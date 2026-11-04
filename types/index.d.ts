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
  /** How much of a monthly usage window is used, 0 to 100; absent when none is reported. */
  month?: number
}

/** The bars a person can switch on and off, top to bottom. */
export type BarId = 'month' | 'week' | 'session' | 'context' | 'cache'

/** Which bars are switched on. */
export type ShownBars = Record<BarId, boolean>

export type CacheClock = {
  /** When the last main-chat reply ended, in ms. 0 before the first reply. */
  lastEnd: number
  /** How long the cache stays warm after a reply, in ms. */
  ttlMs: number
  /** Context tokens the next message re-sends. */
  tokens: number
  /** The clock's last tick, in ms, so the bar redraws every second. */
  now: number
}

export type CacheWarm = {
  /** When keep warm was turned on, in ms: it stops by itself 2 hours later. */
  startedAt: number
  /** Pings sent so far: it stops by itself after 30. */
  pings: number
  /** Cache read tokens of the last ping. */
  read: number
  /** Cache write tokens of the last ping. */
  write: number
  /** True when the last ping wrote the chat to the cache again: it had gone cold. */
  cold: boolean
  /** Why the last ping failed, or ''. */
  error: string
  /** True while a ping is out. */
  sending: boolean
  /** Failed pings in a row: it stops after 3. */
  failures: number
  /** No new ping before this time, in ms (after a failure). */
  retryAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-pane': {
      snapshot: ContextSnapshot | null
      isHidden: boolean
      /** The prompt cache clock, from the last main-chat reply. */
      cacheClock: CacheClock | null
      /** Keep warm while it runs, else null. */
      cacheWarm: CacheWarm | null
      /** Which bars are switched on; null until the session starts (all on). */
      shown: ShownBars | null
      /** True while the row of switches is open (the ⚙ button). */
      switchesOpen: boolean
      /** The 5-hour usage window ("Current session"), or null off a subscription. */
      sessionLimit: SessionLimit | null
    }
  }
}
