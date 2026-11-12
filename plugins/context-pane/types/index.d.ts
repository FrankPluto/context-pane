export type ContextRow = { name: string; tokens: number }

export type ContextSnapshot = {
  /** Tokens in use, or null before the first response of the live window. */
  tokens: number | null
  /** The model's context window, in tokens. */
  window: number
  /** tokens / window as a whole percentage, or null when unknown. */
  percent: number | null
  /** The biggest used categories, as /context names them. */
  top: ContextRow[]
  /** Free space left, as /context counts it. */
  free: number | null
  /** Where auto-compaction runs, in tokens; absent when it is off or unknown. */
  compactAt?: number
}

export type SessionLimit = {
  /** How much of the 5-hour usage window is used, 0 to 100. */
  percent: number
  /** When the window resets, in ms; null when not reported. */
  resetsAt: number | null
  /** The last tick, in ms, so the "resets in" countdown moves. */
  now: number
  /** The reset as a local clock time, "20:32"; absent when unknown. */
  resetClock?: string
  /** How much of the 7-day usage window is used, 0 to 100; absent when not reported. */
  week?: number
  /** When the 7-day window resets, in ms; absent when not reported. */
  weekResetsAt?: number
  /** The local weekday the 7-day window started on, 1 (Monday) to 7 (Sunday); absent when unknown. */
  weekStartDow?: number
  /** When the 7-day window resets, as a local weekday and clock time, "Tue 04:00"; absent when unknown. */
  weekResetClock?: string
  /** How much of a monthly usage window is used, 0 to 100; absent when none is reported. */
  month?: number
}

/** The system the mod runs on, as Read aloud checks it at session start. */
export type SpeechSystem = 'macos' | 'windows' | 'linux' | 'other'

/** The bars a person can switch on and off, top to bottom. */
export type BarId = 'week' | 'session' | 'context'

/** Which bars are switched on. */
export type ShownBars = Record<BarId, boolean>

declare module 'claude-code' {
  interface PluginState {
    'context-pane': {
      snapshot: ContextSnapshot | null
      isHidden: boolean
      /** Which bars are switched on; null until the session starts (all on). */
      shown: ShownBars | null
      /** True while the row of switches is open (the ⚙ button). */
      switchesOpen: boolean
      /** The 5-hour usage window ("Current session"), or null off a subscription. */
      sessionLimit: SessionLimit | null
      /** Read aloud switched on; null until the session starts (on). */
      readAloud: boolean | null
      /** True while a reply is being read aloud. */
      speaking: boolean
      /** The system found at session start; null until checked. */
      speechSystem: SpeechSystem | null
      /** A speech tool was found on this computer; null until checked. */
      canSpeak: boolean | null
      /** Days the week bar is split into: 7 (full week) or 5 (work week); null until the session starts (7). */
      weekDays: 5 | 7 | null
      /** The light grey bar above today's section of the week bar is shown; null until the session starts (shown). */
      showToday: boolean | null
    }
  }
}
