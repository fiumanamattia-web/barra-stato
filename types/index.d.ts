export type Limite = { tipo: string; usato: number; reset?: string }

export type Misura = {
  tokens?: number
  finestra: number
  soglia?: number
  utile?: number
  limiti: Limite[]
}

// consulti: chiamate all'advisor nel turno; assente nei turni salvati prima del contatore.
export type Turno = { inizio: number; fine: number; uscita: number; attivo: boolean; consulti?: number }

export type StatoTask = 'pending' | 'in_progress' | 'completed'

export type Task = { id: string; titolo: string; stato: StatoTask }

declare module 'claude-code' {
  interface PluginState {
    'barra-stato': {
      misura: Misura | null
      modello: string
      effort: string
      advisor: string
      skill: string | null
      tasks: Task[]
      tick: number
      turno: Turno | null
      menu: 'modello' | 'effort' | 'advisor' | null
      pianoEsteso: boolean
    }
  }
}
