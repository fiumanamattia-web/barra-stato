import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { Misura, StatoTask, Task } from '../types'

const misura = atom({ plugin: 'barra-stato', key: 'misura' } as const, null)
const modello = atom({ plugin: 'barra-stato', key: 'modello' } as const, '')
const effort = atom({ plugin: 'barra-stato', key: 'effort' } as const, '')
const advisor = atom({ plugin: 'barra-stato', key: 'advisor' } as const, '')
const skill = atom({ plugin: 'barra-stato', key: 'skill' } as const, null)
const tasks = atom({ plugin: 'barra-stato', key: 'tasks' } as const, [] as Task[])
const tick = atom({ plugin: 'barra-stato', key: 'tick' } as const, 0)
const turno = atom({ plugin: 'barra-stato', key: 'turno' } as const, null)
const menu = atom({ plugin: 'barra-stato', key: 'menu' } as const, null)
const pianoEsteso = atom({ plugin: 'barra-stato', key: 'pianoEsteso' } as const, false)

// Righe del piano visibili a riquadro compresso.
const RIGHE_PIANO = 5

// Celle aggiunte alla larghezza naturale del riquadro principale.
const AGGIUNTA_PRINCIPALE = 10

// Larghezza minima del riquadro del piano: prende lo spazio lasciato da quello principale, i titoli lunghi si troncano.
const LARGHEZZA_PIANO = 40

const MODELLI = [
  { alias: 'opus', nome: 'Opus', colore: '#a78bfa' },
  { alias: 'sonnet', nome: 'Sonnet', colore: '#60a5fa' },
  { alias: 'haiku', nome: 'Haiku', colore: '#4ade80' },
  { alias: 'fable', nome: 'Fable', colore: '#fb923c' },
] as const

const SCELTE_MODELLO = MODELLI

// /advisor accetta fable, opus e sonnet.
const SCELTE_ADVISOR = MODELLI.filter(m => m.alias !== 'haiku')
const COLORE_ADVISOR = '#f472b6'

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const COLORI_EFFORT = ['#4ade80', '#a3e635', '#facc15', '#fb923c', '#f87171'] as const

const SPENTO = '#4b5563'
const BORDO = '#6366f1'
const ETICHETTA = '#93c5fd'
const FONDO_EFFORT = '#1f2937'

// Verde fino al 60%, poi giallo, arancio e rosso a ridosso del 100%.
const GRADIENTE: [number, [number, number, number]][] = [
  [0, [34, 197, 94]],
  [0.6, [234, 179, 8]],
  [0.85, [249, 115, 22]],
  [1, [239, 68, 68]],
]

function colore(p: number): string {
  const x = Math.min(1, Math.max(0, p))
  for (let i = 1; i < GRADIENTE.length; i++) {
    const [p0, c0] = GRADIENTE[i - 1]!
    const [p1, c1] = GRADIENTE[i]!
    if (x <= p1) {
      const t = (x - p0) / (p1 - p0)
      return '#' + c0.map((v, k) => Math.round(v + (c1[k]! - v) * t).toString(16).padStart(2, '0')).join('')
    }
  }
  return '#ef4444'
}

function famiglia(id: string) {
  const s = id.toLowerCase()
  return MODELLI.find(m => s.includes(m.alias))
}

function nomeModello(id: string): string {
  const f = famiglia(id)
  if (!f) return id || '-'
  const v = /(\d+)[-.](\d+)/.exec(id)
  return v ? `${f.nome} ${v[1]}.${v[2]}` : f.nome
}

function durata(ms: number): string {
  if (ms <= 0) return 'ora'
  const min = Math.floor(ms / 60000)
  const g = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (g > 0) return `${g}g ${String(h).padStart(2, '0')}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

function kTok(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// Token generati, come la riga nativa del turno: 840, 4,2k, 18k.
function tok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1).replace('.', ',')}k`
  return `${Math.round(n / 1000)}k`
}

// Durata di un turno come la riga nativa: 12s, 1m 04s, 1h 02m.
function durataTurno(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

type Lettura = {
  context: { tokens?: number; window: number }
  rateLimits: readonly SessionRateLimit[]
}

let modelloAttivo = ''
let effortAttivo = ''
let soglia: number | undefined
let utile: number | undefined
let finestraSoglia = 0
let orologio: Timer | undefined

async function impostaModello($: EngineInterface, id: string) {
  if (!id || id === modelloAttivo) return
  modelloAttivo = id
  await update($, modello, () => id)
}

async function impostaEffort($: EngineInterface, livello: string) {
  if (!livello || livello === effortAttivo) return
  effortAttivo = livello
  await update($, effort, () => livello)
}

async function effortDaSettings($: EngineInterface, id: string): Promise<string> {
  const perModello = (await $.settings.read({ key: 'modelSettings' })) as
    | Record<string, { effortLevel?: string } | undefined>
    | undefined
  const generale = (await $.settings.read({ key: 'effortLevel' })) as string | undefined
  return perModello?.[id.replace(/\[.*\]$/, '')]?.effortLevel ?? generale ?? ''
}

// Margine fisso che il motore lascia sotto la finestra utile.
const MARGINE_MOTORE = 13000

// La soglia di autocompattazione si chiede al motore solo quando cambia la finestra.
async function registraMisura($: EngineInterface, u: Lettura) {
  if (soglia === undefined || finestraSoglia !== u.context.window) {
    let motore: number | undefined
    try {
      const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
      motore = b?.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
    } catch {}
    if (motore !== undefined) {
      // Il riepilogo del motore dà «finestra utile - 13000 token».
      utile = motore + MARGINE_MOTORE
      soglia = motore
    } else {
      // Senza autocompattazione la barra arriva al 100% della finestra intera.
      utile = u.context.window
      soglia = u.context.window
    }
    finestraSoglia = u.context.window
  }
  const m: Misura = {
    tokens: u.context.tokens,
    finestra: u.context.window,
    soglia,
    utile,
    limiti: u.rateLimits.map(r => ({ tipo: r.kind, usato: r.percentUsed, reset: r.resetsAt })),
  }
  await update($, misura, () => m)
}

function scegliModello($: EngineInterface, alias: string) {
  void update($, menu, () => null)
  $.command.run({ command: 'model', args: alias }).then(
    async () => impostaModello($, await $.session.model()),
    (err: unknown) => $.ui.toast(`Cambio modello non riuscito: ${String(err)}`),
  )
}

// L'advisor in uso è l'impostazione advisorModel, che /advisor scrive: vuota = spento.
async function leggiAdvisor($: EngineInterface) {
  const v = (await $.settings.read({ key: 'advisorModel' })) as unknown
  await update($, advisor, () => (typeof v === 'string' ? v : ''))
}

function scegliAdvisor($: EngineInterface, alias: string) {
  void update($, menu, () => null)
  $.command.run({ command: 'advisor', args: alias }).then(
    async () => {
      await update($, advisor, () => (alias === 'off' ? '' : alias))
      try {
        await leggiAdvisor($)
      } catch {}
    },
    (err: unknown) => $.ui.toast(`Cambio advisor non riuscito: ${String(err)}`),
  )
}

function scegliEffort($: EngineInterface, livello: string) {
  void update($, menu, () => null)
  $.command.run({ command: 'effort', args: livello }).catch((err: unknown) =>
    $.ui.toast(`Cambio effort non riuscito: ${String(err)}`),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await impostaModello($, await $.session.model())
      await impostaEffort($, await effortDaSettings($, modelloAttivo))
    } catch {}
    try {
      await leggiAdvisor($)
    } catch {}
    try {
      await $.tool.register({
        name: 'piano',
        description:
          'Pubblica nel riquadro sotto il prompt il piano a step della task in corso. Ogni chiamata sostituisce il piano intero: passa tutti gli step con il loro stato aggiornato (completed = superato, barrato e flaggato; in_progress = in corso; pending = da fare). Chiamalo quando esponi un piano e a ogni avanzamento.',
        inputSchema: {
          type: 'object',
          properties: {
            passi: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  titolo: { type: 'string' },
                  stato: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
                required: ['titolo', 'stato'],
              },
            },
          },
          required: ['passi'],
        },
        isDeferred: false,
      })
    } catch {}
    try {
      await registraMisura($, await $.session.usage())
    } catch {}
    $.clock.every(60_000, () => void update($, tick, n => n + 1))
    return r
  })

  on('session.measure', async ($, e, next) => {
    try {
      await registraMisura($, e)
    } catch {}
    return next(e)
  })

  // Modello ed effort reali di ogni richiesta dell'agente principale (i subagenti no).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await impostaModello($, e.model)
      if (e.effort !== undefined) await impostaEffort($, String(e.effort))
    }
    const r = yield* next(e)
    // Token generati finora nel turno: la somma dei passi già chiusi.
    if (e.agentId === undefined && r.usage) {
      const generati = r.usage.output_tokens
      await update($, turno, v => (v && v.attivo ? { ...v, uscita: v.uscita + generati } : v))
    }
    // Consulti dell'advisor: il tool lo esegue l'API dentro la richiesta, si leggono a passo chiuso.
    const consulti = (r.serverToolUses ?? []).filter(u => u.name === 'advisor').length
    if (e.agentId === undefined && consulti > 0) {
      await update($, turno, v => (v && v.attivo ? { ...v, consulti: (v.consulti ?? 0) + consulti } : v))
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      await update($, turno, () => ({ inizio: t, fine: 0, uscita: 0, attivo: true, consulti: 0 }))
      orologio?.cancel()
      orologio = $.clock.every(1000, () => void update($, tick, n => n + 1))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      orologio?.cancel()
      orologio = undefined
      const t = await $.clock.now()
      await update($, turno, v => ({
        inizio: v?.inizio ?? t,
        fine: t,
        uscita: e.usage ? e.usage.output_tokens : (v?.uscita ?? 0),
        attivo: false,
        consulti: v?.consulti ?? 0,
      }))
    }
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    await update($, skill, () => e.skill)
    return next(e)
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    const t = r.isError ? undefined : (r.result as { task?: { id: string; subject: string } } | undefined)?.task
    if (t) {
      await update($, tasks, l => [...l.filter(x => x.id !== t.id), { id: t.id, titolo: t.subject, stato: 'pending' as const }])
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    const ok = !r.isError && (r.result as { success?: boolean } | undefined)?.success === true
    if (ok) {
      await update($, tasks, l =>
        e.status === 'deleted'
          ? l.filter(x => x.id !== e.taskId)
          : l.map(x =>
              x.id !== e.taskId ? x : { ...x, titolo: e.subject ?? x.titolo, stato: (e.status ?? x.stato) as StatoTask },
            ),
      )
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError) {
      await update($, tasks, () => e.todos.map((t, i) => ({ id: `todo-${i}`, titolo: t.content, stato: t.status })))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__barra-stato__piano' }, async ($, e) => {
    const passi = ((e as unknown as { passi?: { titolo: string; stato: StatoTask }[] }).passi ?? []).filter(
      p => p && typeof p.titolo === 'string',
    )
    await update($, tasks, () => passi.map((p, i) => ({ id: `piano-${i}`, titolo: p.titolo, stato: p.stato })))
    return { result: `Piano aggiornato: ${passi.filter(p => p.stato === 'completed').length}/${passi.length} step superati.` }
  })

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const r = await next(e)
    await update($, skill, () => null)
    await update($, tasks, () => [])
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const r = await next(e)
    try {
      await impostaModello($, await $.session.model())
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'advisor' }, async ($, e, next) => {
    const r = await next(e)
    try {
      await leggiAdvisor($)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const r = await next(e)
    const livello = e.args.trim().toLowerCase()
    if ((EFFORT as readonly string[]).includes(livello)) await impostaEffort($, livello)
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [m, mod, eff, adv, sk, ts, , tr, mn, est] = await Promise.all([
      read($, misura),
      read($, modello),
      read($, effort),
      read($, advisor),
      read($, skill),
      read($, tasks),
      read($, tick),
      read($, turno),
      read($, menu),
      read($, pianoEsteso),
    ])
    const adesso = await $.clock.now()

    const barra = (p: number, celle: number) => {
      const piene = Math.round(Math.min(1, Math.max(0, p)) * celle)
      const out = []
      for (let i = 0; i < celle; i++) {
        out.push(
          i < piene ? <Text color={colore((i + 0.5) / celle)}>━</Text> : <Text color={SPENTO}>─</Text>,
        )
      }
      return out
    }

    const f = famiglia(mod)
    const ie = EFFORT.indexOf(eff as (typeof EFFORT)[number])
    const coloreEffort = ie >= 0 ? COLORI_EFFORT[ie]! : '#9ca3af'
    const nomeAdvisor = adv ? nomeModello(adv) : 'off'

    const base = m ? (m.soglia ?? m.finestra) : 0
    const pc = m?.tokens !== undefined && base > 0 ? m.tokens / base : undefined
    const dettaglio =
      m?.tokens === undefined
        ? 'in attesa'
        : `${kTok(m.tokens)} / ${kTok(base)} · autocomp. ${Math.round((base / (m.utile ?? m.finestra)) * 100)}%`

    const limite = (tipo: string, etichetta: string) => {
      const l = m?.limiti.find(x => x.tipo === tipo)
      if (!l) return <Text color={SPENTO}>{`◷ ${etichetta} n/d`}</Text>
      const u = l.usato / 100
      const rimanente = Math.max(0, Math.round(100 - l.usato))
      const reset = l.reset ? Date.parse(l.reset) - adesso : NaN
      return (
        <Text>
          <Text color={ETICHETTA} bold>{`◷ ${etichetta} `}</Text>
          {barra(u, 10)}
          <Text color={colore(u)} bold>{` ${rimanente}% rim.`}</Text>
          <Text dimColor>{Number.isNaN(reset) ? '' : ` ↻ ${durata(reset)}`}</Text>
        </Text>
      )
    }

    const fatte = ts.filter(t => t.stato === 'completed').length

    // Larghezza del riquadro principale: la riga più larga del contenuto più AGGIUNTA_PRINCIPALE celle,
    // così il contenuto resta allineato a sinistra e le righe con space-between si distribuiscono.
    const testoLimite = (tipo: string, etichetta: string) => {
      const l = m?.limiti.find(x => x.tipo === tipo)
      if (!l) return `◷ ${etichetta} n/d`
      const reset = l.reset ? Date.parse(l.reset) - adesso : NaN
      return `◷ ${etichetta} ` + 'x'.repeat(10) + ` ${Math.max(0, Math.round(100 - l.usato))}% rim.` + (Number.isNaN(reset) ? '' : ` ↻ ${durata(reset)}`)
    }
    const righe = [
      `CTX ${'x'.repeat(20)} ${pc === undefined ? '--%' : `${Math.round(pc * 100)}%`} ${dettaglio}`,
      `${testoLimite('five_hour', '5h')}   ${testoLimite('seven_day', '7g')}`,
      ` ◆ ${nomeModello(mod)} ▸ ` + ` ✦ ${eff || '-'} ` + 'xxxxx' + ' ▸ ' + ` ⚑ advisor ${nomeAdvisor} ▸ ` + '   ' + (sk ? ` ⚙ ${sk} ` : 'no skill'),
    ]
    const larghezzaPrincipale = Math.max(...righe.map(r => r.length)) + 4 + AGGIUNTA_PRINCIPALE

    // A riquadro compresso si vede una finestra di RIGHE_PIANO righe attorno allo step in corso.
    const corrente = Math.max(
      0,
      ts.findIndex(t => t.stato !== 'completed'),
    )
    const da = est || ts.length <= RIGHE_PIANO ? 0 : Math.min(Math.max(0, corrente - 1), ts.length - RIGHE_PIANO)
    const visibili = est ? ts : ts.slice(da, da + RIGHE_PIANO)
    const sopra = est ? 0 : da
    const sotto = est ? 0 : ts.length - da - visibili.length

    const piano =
      ts.length > 0 ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={BORDO}
          paddingX={1}
          minWidth={LARGHEZZA_PIANO}
          flexGrow={1}
          flexShrink={0}
        >
          <Box justifyContent="space-between">
            <Text color={ETICHETTA} bold>{`PIANO ${fatte}/${ts.length}`}</Text>
            {ts.length > RIGHE_PIANO ? (
              <Button key="piano-esteso" plain onPress={() => update($, pianoEsteso, v => !v)}>
                <Text color="#9ca3af">{est ? '▴ comprimi' : `▾ mostra tutti (${ts.length})`}</Text>
              </Button>
            ) : null}
          </Box>
          {sopra > 0 ? <Text dimColor>{`  … ${sopra} superati sopra`}</Text> : null}
          {visibili.map(t =>
            t.stato === 'completed' ? (
              <Text wrap="truncate-end">
                <Text color="#22c55e">✔ </Text>
                <Text dimColor strikethrough>
                  {t.titolo}
                </Text>
              </Text>
            ) : t.stato === 'in_progress' ? (
              <Text color="#22d3ee" bold wrap="truncate-end">{`▶ ${t.titolo}`}</Text>
            ) : (
              <Text color="#9ca3af" wrap="truncate-end">{`○ ${t.titolo}`}</Text>
            ),
          )}
          {sotto > 0 ? <Text dimColor>{`  … altri ${sotto} da fare`}</Text> : null}
        </Box>
      ) : null

    return (
      <Box flexDirection="row">
      <Box flexDirection="column" borderStyle="round" borderColor={BORDO} paddingX={1} marginRight={1} width={larghezzaPrincipale} flexShrink={1} minWidth={0}>
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Button key="modello" plain onPress={() => update($, menu, v => (v === 'modello' ? null : 'modello'))}>
              <Text backgroundColor={f?.colore ?? '#9ca3af'} color="#111827" bold>
                {` ◆ ${nomeModello(mod)} ▸ `}
              </Text>
            </Button>
            <Button key="effort" plain onPress={() => update($, menu, v => (v === 'effort' ? null : 'effort'))}>
              <Text backgroundColor={FONDO_EFFORT} color="#f9fafb" bold>
                {` ✦ ${eff || '-'} `}
              </Text>
              {EFFORT.map((_, k) => (
                <Text backgroundColor={FONDO_EFFORT} color={k <= ie ? coloreEffort : SPENTO}>
                  {k <= ie ? '●' : '○'}
                </Text>
              ))}
              <Text backgroundColor={FONDO_EFFORT} color="#9ca3af">
                {' ▸ '}
              </Text>
            </Button>
            <Button key="advisor" plain onPress={() => update($, menu, v => (v === 'advisor' ? null : 'advisor'))}>
              {adv ? (
                <Text backgroundColor={COLORE_ADVISOR} color="#111827" bold>
                  {` ⚑ advisor ${nomeAdvisor} ▸ `}
                </Text>
              ) : (
                <Text backgroundColor={FONDO_EFFORT} color="#9ca3af">
                  {` ⚑ advisor off ▸ `}
                </Text>
              )}
            </Button>
          </Box>
          {sk ? (
            <Text backgroundColor="#a21caf" color="#fdf4ff" bold>
              {` ⚙ ${sk} `}
            </Text>
          ) : (
            <Text color={SPENTO}>no skill</Text>
          )}
        </Box>
        {mn === 'modello' ? (
          <Box gap={1}>
            <Text dimColor>modello:</Text>
            {SCELTE_MODELLO.map(x => (
              <Button key={`m-${x.alias}`} plain onPress={() => scegliModello($, x.alias)}>
                <Text backgroundColor={x.colore} color="#111827" bold>
                  {` ${x.nome} `}
                </Text>
              </Button>
            ))}
          </Box>
        ) : mn === 'advisor' ? (
          <Box gap={1}>
            <Text dimColor>advisor:</Text>
            {SCELTE_ADVISOR.map(x => (
              <Button key={`a-${x.alias}`} plain onPress={() => scegliAdvisor($, x.alias)}>
                <Text backgroundColor={x.colore} color="#111827" bold>
                  {` ${x.nome} `}
                </Text>
              </Button>
            ))}
            <Button key="a-off" plain onPress={() => scegliAdvisor($, 'off')}>
              <Text backgroundColor={FONDO_EFFORT} color="#f9fafb" bold>
                {' off '}
              </Text>
            </Button>
          </Box>
        ) : mn === 'effort' ? (
          <Box gap={1}>
            <Text dimColor>effort:</Text>
            {EFFORT.map((l, k) => (
              <Button key={`e-${l}`} plain onPress={() => scegliEffort($, l)}>
                <Text backgroundColor={FONDO_EFFORT} color={COLORI_EFFORT[k]!} bold>
                  {` ${l} `}
                </Text>
              </Button>
            ))}
          </Box>
        ) : null}
        <Box gap={1}>
          <Text color={ETICHETTA} bold>
            CTX
          </Text>
          <Text>{barra(pc ?? 0, 20)}</Text>
          <Text color={colore(pc ?? 0)} bold>
            {pc === undefined ? '--%' : `${Math.round(pc * 100)}%`}
          </Text>
          <Text dimColor>{dettaglio}</Text>
        </Box>
        <Box gap={3}>
          {limite('five_hour', '5h')}
          {limite('seven_day', '7g')}
        </Box>
        <Box justifyContent="space-between">
          {e.props.hint ? <Text dimColor>{e.props.hint}</Text> : <Text> </Text>}
          <Box gap={2}>
            {tr ? (
              <>
                <Text color={tr.attivo ? '#22d3ee' : ETICHETTA}>
                  {`⏱ ${tr.attivo ? 'in corso' : 'ultimo'} ${durataTurno((tr.attivo ? adesso : tr.fine) - tr.inizio)}`}
                </Text>
                <Text color={tr.attivo ? '#22d3ee' : ETICHETTA}>{`↓ ${tok(tr.uscita)} token`}</Text>
                {adv || (tr.consulti ?? 0) > 0 ? (
                  <Text color={(tr.consulti ?? 0) > 0 ? COLORE_ADVISOR : SPENTO}>
                    {`⚑ ${tr.consulti ?? 0} ${tr.consulti === 1 ? 'consulto' : 'consulti'}`}
                  </Text>
                ) : null}
              </>
            ) : (
              <Text dimColor>nessun turno</Text>
            )}
          </Box>
        </Box>
      </Box>
      {piano}
      </Box>
    )
  })
}
