# barra-stato

Mod per Claude Code: due riquadri sotto il prompt.

**Riquadro principale**
- modello ed effort, cliccabili per cambiarli;
- advisor (`/advisor`): il modello più forte che il principale consulta nei passaggi complessi, cliccabile per scegliere Fable, Opus, Sonnet o spegnerlo;
- contesto usato rispetto alla soglia di autocompattazione;
- limiti di utilizzo a 5 ore e a 7 giorni, con il tempo al reset;
- skill in uso, durata e token generati dell'ultimo turno, con i consulti dell'advisor.

**Riquadro del piano**, a destra
- una riga per step: superati barrati e flaggati, in corso evidenziato, da fare in grigio;
- di default 5 righe attorno allo step in corso, con «mostra tutti» per l'elenco completo;
- si alimenta da `TaskCreate` / `TaskUpdate` / `TodoWrite` e dallo strumento `mcp__barra-stato__piano`, che il modello chiama per pubblicare il proprio piano a step.

## Installazione

Al prompt di una sessione di Claude Code nel terminale:

```
/plugin install barra-stato --marketplace fiumanamattia-web/barra-stato
```

Rispondi `y` per aggiungere il marketplace, poi scegli l'ambito (utente per averlo in ogni sessione).

Da una shell:

```
claude plugin install barra-stato --marketplace fiumanamattia-web/barra-stato
```

Nell'app desktop, dove `/plugin` non è disponibile: + accanto al campo del prompt, poi Plugins, Add marketplace con `fiumanamattia-web/barra-stato`, poi Add plugin.

## Uso del piano

Perché il modello pubblichi i suoi piani nel riquadro, aggiungi al tuo `CLAUDE.md` una riga come:

> Quando esponi un piano a step, pubblicalo con lo strumento `mcp__barra-stato__piano` e aggiornalo a ogni step superato.

## Regolazioni

In testa a `hooks/register.tsx`: `RIGHE_PIANO` (righe visibili a riquadro compresso), `LARGHEZZA_PIANO` (larghezza minima del piano), `AGGIUNTA_PRINCIPALE` (celle aggiunte al riquadro principale).
