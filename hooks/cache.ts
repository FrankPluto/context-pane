import type { EngineInterface, ModelForkResult } from 'claude-code'

import type { CacheClock, CacheWarm } from '../types'
import { readShown, setBar } from './bars'

// The prompt cache clock: counts down until the chat's prompt cache goes cold,
// and can keep it warm with a small background ping. register.tsx draws it as
// the cache bar and calls these functions from its hooks.

const CLOCK = { plugin: 'context-pane', key: 'cacheClock' } as const
const WARM = { plugin: 'context-pane', key: 'cacheWarm' } as const

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000
const DEMO_MS = 60_000

// Keep warm: one small background ping about 45 s before the cache would go cold.
// $.model.fork repeats the main thread's last request (same model, system prompt,
// tools, messages) with this one line after it, so the API reads the chat from its
// cache and the cache's timer starts again. The fork never writes the transcript.
export const LEAD = 45_000
const MAX_PINGS = 30
const MAX_MS = 2 * 60 * 60_000
const MAX_FAILS = 3
const RETRY_MS = 20_000
export const PING_PROMPT = 'Reply with the single word: ok'
// Turns that are not the person typing: they do not count as "they are back".
const BACKGROUND = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation'])

// Module variables reset on a reload; the clock itself lives in $.state.
let sid = ''
let home = ''
let demo = false
// While the demo runs: when the last real reply ended, so the bar can go back to it.
let realEnd = 0
// How long "lost" stays on screen before the demo hands back.
const DEMO_LOST_MS = 2000
let detected: 'unknown' | '5m' | '1h' = 'unknown'
// The length found last time, in any chat (kept in $.store): the guess until
// this chat's own log answers, so a new chat does not start on the wrong one.
let remembered: '5m' | '1h' | undefined
let lastDetect = 0
// A length chosen by hand with the ⏱ switch (kept in $.store for every chat):
// it wins over the log until /context-pane auto clears it.
let manual: '5m' | '1h' | undefined
let working = false
let pinging = false

const short = (tokens: number) => `${Math.round(tokens / 1000)}k`

function ttlMs(): number {
  if (demo) return DEMO_MS
  const known = manual ?? (detected === 'unknown' ? remembered : detected)
  return known === '5m' ? FIVE_MIN : ONE_HOUR
}

async function getClock($: EngineInterface): Promise<CacheClock | null> {
  const { value } = await $.state.get(CLOCK)
  return value ?? null
}

async function setClock($: EngineInterface, c: CacheClock | null) {
  await $.state.set(CLOCK, c)
}

async function getWarm($: EngineInterface): Promise<CacheWarm | null> {
  const { value } = await $.state.get(WARM)
  return value ?? null
}

async function setWarm($: EngineInterface, w: CacheWarm | null) {
  await $.state.set(WARM, w)
}

async function isHidden($: EngineInterface): Promise<boolean> {
  return !(await readShown($)).cache
}

/** What the cache bar draws from: the clock, keep warm, and whether it is hidden. */
export async function readCache($: EngineInterface): Promise<{ clock: CacheClock | null; warm: CacheWarm | null; hidden: boolean }> {
  return { clock: await getClock($), warm: await getWarm($), hidden: await isHidden($) }
}

function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // The toast is only a hint.
  }
}

async function log($: EngineInterface, line: string) {
  try {
    await $.process.run(['mkdir', '-p', `${home}/.claude/mods-logs`])
    const path = `${home}/.claude/mods-logs/context-pane-cache.log`
    const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    const lines = old ? old.trimEnd().split('\n').slice(-200) : []
    lines.push(`${new Date(await $.clock.now()).toISOString()} ${sid.slice(0, 8)} ${line}`)
    await $.fs.write(path, `${lines.join('\n')}\n`)
  } catch {
    // The log must never break the clock.
  }
}

// Shows or hides the cache bar, through its switch (remembered in every chat).
// Hiding it also stops keep warm, which never runs out of sight.
export async function setCacheHidden($: EngineInterface, value: boolean) {
  await setBar($, 'cache', !value)
  if (value) await stopWarm($, 'Keep warm stopped: the cache bar is hidden.', false)
}

// Turns keep warm on. 'none' when there is no reply yet whose cache could be kept.
async function startWarm($: EngineInterface): Promise<'on' | 'none'> {
  const c = await getClock($)
  if (!c || !c.lastEnd) return 'none'
  // Keep warm never runs out of sight: it shows the cache bar first.
  if (await isHidden($)) await setCacheHidden($, false)
  await setWarm($, { startedAt: await $.clock.now(), pings: 0, read: 0, write: 0, cold: false, error: '', sending: false, failures: 0, retryAt: 0 })
  await log($, `keep warm on (${c.ttlMs / 1000} s cache, ${short(c.tokens)} tokens)`)
  return 'on'
}

async function stopWarm($: EngineInterface, why: string, shout = true) {
  const w = await getWarm($)
  if (!w) return
  await setWarm($, null)
  await log($, `keep warm off after ${w.pings} pings: ${why}`)
  if (shout) toast($, why)
}

// Once a second: sends the ping when the cache is 45 s from going cold, and keeps the caps.
async function warmTick($: EngineInterface) {
  const w = await getWarm($)
  if (!w || pinging || working) return
  const now = await $.clock.now()
  if (now - w.startedAt >= MAX_MS) return stopWarm($, 'Keep warm stopped after 2 hours.')
  if (w.pings >= MAX_PINGS) return stopWarm($, `Keep warm stopped after ${MAX_PINGS} pings.`)
  if (now < w.retryAt) return
  const c = await getClock($)
  if (!c || !c.lastEnd) return
  if (c.lastEnd + c.ttlMs - now > LEAD) return
  pinging = true
  void ping($, now).catch(async err => {
    pinging = false
    await log($, `ping failed: ${String(err)}`)
  })
}

async function ping($: EngineInterface, start: number) {
  const w0 = await getWarm($)
  if (w0) await setWarm($, { ...w0, sending: true })
  let r: ModelForkResult | null = null
  let thrown = ''
  try {
    r = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    thrown = String(err)
  }
  pinging = false
  const n = (w0?.pings ?? 0) + 1
  if (r && !r.isAnswered && r.reason === 'nothing-to-fork') {
    await log($, `ping ${n}: nothing to fork yet`)
    return stopWarm($, 'Keep warm stopped: there is no reply to keep warm yet.')
  }
  const usage = r && 'usage' in r ? r.usage : null
  const read = usage?.cache_read_input_tokens ?? 0
  const write = usage?.cache_creation_input_tokens ?? 0
  // An answer, or a reply with no words, still read the chat: the cache timer restarted.
  const ok = r !== null && (r.isAnswered || r.reason === 'empty-reply')
  const error = ok ? '' : thrown ? 'error' : r && !r.isAnswered && r.reason === 'api-error' ? `${r.error}${r.status ? ` ${r.status}` : ''}` : r && !r.isAnswered ? r.reason : 'error'
  await log($, `ping ${n}: cache read ${read}, cache write ${write}, error ${error || 'none'}${thrown ? ` (${thrown.slice(0, 200)})` : ''}`)
  const w = await getWarm($)
  // Stopped while the ping was out (a prompt, keep warm off): only the log keeps it.
  if (!w) return
  const now = await $.clock.now()
  if (ok) {
    await setWarm($, { ...w, pings: n, read, write, cold: write > read, error: '', sending: false, failures: 0, retryAt: 0 })
    const c = await getClock($)
    if (c) await setClock($, { ...c, lastEnd: Math.max(c.lastEnd, start), now })
  } else {
    const failures = w.failures + 1
    await setWarm($, { ...w, pings: n, error, sending: false, failures, retryAt: now + RETRY_MS })
    if (failures >= MAX_FAILS) return stopWarm($, `Keep warm stopped: ${MAX_FAILS} pings in a row failed (${error}).`)
  }
  if (n >= MAX_PINGS) await stopWarm($, `Keep warm stopped after ${MAX_PINGS} pings.`)
}

// Reads which cache length this chat's replies were written with (5 min or 1 hour).
async function detect($: EngineInterface) {
  if (!sid) return
  lastDetect = await $.clock.now()
  const r = await $.process.run(['python3', `${$.plugin.root}/bin/ttl.py`, sid])
  const out = r.stdout.trim()
  if (out === '5m' || out === '1h') {
    detected = out
    if (out !== remembered) {
      remembered = out
      await $.store.set('cacheTtl', out).catch(() => undefined)
    }
    // A clock started on the guess takes the real length now.
    const c = await getClock($)
    if (c && !demo && c.ttlMs !== ttlMs()) await setClock($, { ...c, ttlMs: ttlMs() })
  } else if (r.exitCode !== 0) await log($, `ttl check failed: ${r.stderr.slice(0, 200)}`)
}

// A main-chat reply just ended: the cache is warm again from now.
async function restart($: EngineInterface) {
  const now = await $.clock.now()
  const { context } = await $.session.usage()
  await detect($).catch(() => undefined)
  if (demo) realEnd = now
  await setClock($, { lastEnd: now, ttlMs: ttlMs(), tokens: context.tokens ?? 0, now })
}

// Once a second: moves the countdown while the bar shows.
async function tick($: EngineInterface) {
  const c = await getClock($)
  if (!c || !c.lastEnd || (await isHidden($))) return
  const now = await $.clock.now()
  // Still unknown (the log had no reply yet): ask again every 5 s.
  if (detected === 'unknown' && now - lastDetect >= 5000) void detect($).catch(() => undefined)
  // The demo runs once: shortly after it is lost, the real length and time come back.
  if (demo && now - c.lastEnd >= c.ttlMs + DEMO_LOST_MS) {
    demo = false
    await setClock($, { ...c, lastEnd: realEnd || c.lastEnd, ttlMs: ttlMs(), now })
    toast($, `Demo over: back to the ${ttlMs() === ONE_HOUR ? '1 hour' : '5 min'} cache.`)
    return
  }
  // A lost cache only needs a redraw once a minute.
  const lost = now - c.lastEnd >= c.ttlMs
  if (lost && c.now - c.lastEnd >= c.ttlMs && Math.floor((now - c.lastEnd) / 60_000) === Math.floor((c.now - c.lastEnd) / 60_000)) return
  await setClock($, { ...c, now })
}

/** session.start: timers and the cache length. */
export async function cacheStart($: EngineInterface) {
  sid = await $.session.id()
  // HOME from the environment: the plugin's own path is not under it when loaded from its source folder.
  home = (await $.env.get('HOME').catch(() => undefined)) ?? $.plugin.root.split('/.claude/')[0] ?? ''
  demo = false
  const ttlSaved = await $.store.get('cacheTtl').catch(() => undefined)
  if (ttlSaved === '5m' || ttlSaved === '1h') remembered = ttlSaved
  const manualSaved = await $.store.get('cacheTtlManual').catch(() => undefined)
  manual = manualSaved === '5m' || manualSaved === '1h' ? manualSaved : undefined
  $.clock.every(1000, () => {
    void tick($).catch(() => undefined)
    void warmTick($).catch(err => log($, `keep warm tick failed: ${String(err)}`))
  })
  void detect($).catch(() => undefined)
}

/** turn.start: Claude is working, so no ping goes out. */
export function cacheTurnStart(text: string | undefined) {
  // Should the engine ever raise a turn for the ping's own fork, it is not the person's turn.
  if (!(pinging && text === PING_PROMPT)) working = true
}

/** turn.complete of the main chat: the cache is fresh again. */
export async function cacheTurnComplete($: EngineInterface) {
  working = false
  await restart($).catch(err => log($, `restart failed: ${String(err)}`))
}

/** prompt.submit: the person is back, so keep warm ends. Its own command does not count. */
export async function cachePrompt($: EngineInterface, text: string, originKind: string | undefined) {
  const t = text.trim().toLowerCase()
  const own = t.startsWith('/context-pane') || t === PING_PROMPT.toLowerCase()
  if (!own && !BACKGROUND.has(originKind ?? '')) await stopWarm($, 'Keep warm stopped: you sent a message.')
}

/** The ♨/⏸ icon: starts or stops keep warm. */
export async function toggleWarm($: EngineInterface) {
  if (await getWarm($)) await stopWarm($, 'Keep warm off.')
  else if ((await startWarm($)) === 'on') toast($, 'Keep warm on.')
}

/** The ✕ icon: hides the cache bar. */
export async function hideCache($: EngineInterface) {
  const wasWarm = (await getWarm($)) !== null
  await setCacheHidden($, true)
  toast($, `Cache bar hidden${wasWarm ? ' and keep warm stopped' : ''}. /context-pane cache shows it.`)
}

/** /context-pane keepwarm [off]. */
export async function keepWarmCommand($: EngineInterface, arg: string): Promise<string> {
  const w = await getWarm($)
  if (arg === 'off' || (arg !== 'on' && w)) {
    await stopWarm($, 'Keep warm off.', false)
    return 'Keep warm off.'
  }
  if (w) return 'Keep warm is already on.'
  if ((await startWarm($)) === 'none') return "Nothing to keep warm yet. Keep warm works after Claude's first reply."
  return 'Keep warm on.'
}

/** /context-pane demo|auto: a 60 s cache for filming, in this chat only. */
export async function setDemo($: EngineInterface, on: boolean) {
  const c0 = await getClock($)
  // Starting: remember the real reply time, and count the demo from now.
  if (on && !demo) realEnd = c0?.lastEnd ?? 0
  const wasDemo = demo
  demo = on
  // auto also hands the length back to the chat's log.
  if (!on && manual) {
    manual = undefined
    await $.store.delete('cacheTtlManual').catch(() => undefined)
  }
  const c = await getClock($)
  const now = await $.clock.now()
  if (c && on) await setClock($, { ...c, lastEnd: now, ttlMs: ttlMs(), now })
  else if (c) await setClock($, { ...c, lastEnd: wasDemo ? realEnd || c.lastEnd : c.lastEnd, ttlMs: ttlMs(), now })
}

/** /context-pane 1h|5m: sets the timer's length by hand, in every chat. */
export async function setTtl($: EngineInterface, value: '5m' | '1h'): Promise<string> {
  if (demo) {
    demo = false
    const c = await getClock($)
    if (c && realEnd) await setClock($, { ...c, lastEnd: realEnd })
  }
  manual = value
  await $.store.set('cacheTtlManual', manual).catch(() => undefined)
  const c = await getClock($)
  if (c) await setClock($, { ...c, ttlMs: ttlMs(), now: await $.clock.now() })
  return `Cache timer: ${manual === '1h' ? '1 hour' : '5 min'}. /context-pane auto reads it from the chat again.`
}

/** The ⏱ switch: flips the timer between 1 hour and 5 min. */
export async function toggleTtl($: EngineInterface) {
  toast($, await setTtl($, ttlMs() === ONE_HOUR ? '5m' : '1h'))
}
