import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextRow, ContextSnapshot, SessionLimit } from '../types'
import { cacheStart, cachePrompt, cacheTurnComplete, cacheTurnStart, hideCache, keepWarmCommand, readCache, setCacheHidden, setDemo, setTtl, toggleTtl, toggleWarm } from './cache'
import { TINY5_WOFF2_BASE64 } from './tiny5'

const snapshot = atom({ plugin: 'context-pane', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'context-pane', key: 'isHidden' } as const, false)
// The account's 5-hour usage window ("Current session" on the usage page).
const sessionLimit = atom({ plugin: 'context-pane', key: 'sessionLimit' } as const, null)

// How well Claude recalls the conversation, by how full the window is.
// Each zone starts with a marker on the bar and its label under that marker.
type Zone = { label: string; from: number; color: string }
const ZONES: Zone[] = [
  { label: 'SHARP', from: 0, color: '#34A853' },
  { label: 'GOOD', from: 125_000, color: '#00ACC1' },
  { label: 'WEAKER', from: 250_000, color: '#FA7B17' },
  { label: 'FORGETFUL', from: 500_000, color: '#EA4335' },
]
const COMPACT_ZONE = { label: 'AUTO-COMPACT', color: '#A142F4' }
// A section narrower than this share of the bar shows its label at the
// right end of the section before it, so the words never overlap.
const NARROW_PCT = 9

type Section = { label: string; color: string; from: number; to: number }

// The zones that fall inside this window, plus the auto-compact section.
function sections(s: ContextSnapshot): Section[] {
  const end = s.compactAt && s.compactAt < s.window ? s.compactAt : s.window
  const out: Section[] = ZONES.filter(z => z.from < end).map((z, i, all) => ({
    label: z.label,
    color: z.color,
    from: z.from,
    to: Math.min(all[i + 1]?.from ?? end, end),
  }))
  if (end < s.window) out.push({ ...COMPACT_ZONE, from: end, to: s.window })
  return out
}

const BAR_W = 1000 // SVG units across; stretched to the full width
const BAR_H = 4 // CSS pixels
const GAP = 5 // SVG units cut out of the fill at a passed marker (about 3–4 px)

const TICK = '#5F6368'

// Colours for the category labels, in order of size.
const LABEL_COLORS = ['#4285F4', '#A142F4', '#00ACC1']
const FREE_COLOR = '#34A853'

// "59312" -> "59.3k", "1000000" -> "1m"
function short(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(n)
}

// The colour of the zone the context is in now: the same as that zone's label on the bar.
function zoneColor(s: ContextSnapshot): string {
  const used = s.tokens ?? 0
  const secs = sections(s)
  return (secs.find(sec => used < sec.to) ?? secs[secs.length - 1])?.color ?? ZONES[0]!.color
}

// A section of a bar, as shares (0–1) of its width. `color` is its label,
// marker and starting fill colour; with `endColor` the fill shades into that
// colour across the section, else it blends into the next section's colour.
type Seg = {
  label: string
  color: string
  from: number
  to: number
  endColor?: string
  /** The label's colour in dark mode, where `color` is too dark to read. */
  darkLabel?: string
  /** The caption text's colour in this zone, when it should follow the theme (a theme key). */
  textColor?: string
}

// The context zones as shares of the window.
function contextSegs(s: ContextSnapshot): Seg[] {
  return sections(s).map(sec => ({ ...sec, from: sec.from / s.window, to: sec.to / s.window }))
}

// A gradient across the whole bar with each colour pinned at a share (0–1) of it.
function zoneGradient(id: string, stops: Array<{ at: number; color: string }>): string {
  const s = stops.map(st => `<stop offset="${(st.at * 100).toFixed(2)}%" stop-color="${st.color}"/>`).join('')
  return `<linearGradient id="${id}" x1="0" y1="0" x2="${BAR_W}" y2="0" gradientUnits="userSpaceOnUse">${s}</linearGradient>`
}

// `fill` is the filled share of the bar (0–1); `id` names its gradient.
// `h` is the bar's height in px (the context and cache bars use BAR_H).
function barSvg(segs: Seg[], fill: number, id: string, h = BAR_H): string {
  const fillW = Math.max(0, Math.min(BAR_W, fill * BAR_W))
  const x = (share: number) => share * BAR_W

  // A marker where each section begins. One the fill has not reached is a
  // coloured tick; one the fill has passed becomes a gap cut through the bar,
  // so it stays visible whatever colour the fill has there.
  const marks = segs.filter(sec => sec.from > 0)
  const passed = marks.filter(sec => x(sec.from) < fillW)
  const ahead = marks.filter(sec => x(sec.from) >= fillW)
  const ticks = ahead.map(sec => `<rect x="${x(sec.from) - 1.5}" y="0" width="3" height="${h}" fill="${sec.color}"/>`)

  // Split [0, BAR_W] at each passed marker, leaving GAP units empty there,
  // and draw the track and the fill piece by piece. The gradient is laid
  // across the whole bar, so the pieces still read as one continuous fill.
  const cuts = passed.map(sec => x(sec.from))
  const pieces: Array<[number, number]> = []
  let start = 0
  for (const c of cuts) {
    pieces.push([start, c - GAP / 2])
    start = c + GAP / 2
  }
  pieces.push([start, BAR_W])
  const rects = (from: number, to: number, paint: string, extra = '') =>
    pieces
      .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as const)
      .filter(([a, b]) => b > a)
      .map(([a, b]) => `<rect x="${a}" y="0" width="${b - a}" height="${h}" fill="${paint}"${extra}/>`)
      .join('')
  // The fill takes each zone's label colour from that zone's marker on, and
  // blends into the next zone's colour by the next marker.
  const zoneStops = segs.flatMap(sec => [
    { at: sec.from, color: sec.color },
    ...(sec.endColor ? [{ at: sec.to, color: sec.endColor }] : []),
  ])
  const last = segs[segs.length - 1]
  if (last && !last.endColor) zoneStops.push({ at: 1, color: last.color })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${h}" viewBox="0 0 ${BAR_W} ${h}" preserveAspectRatio="none">` +
    `<defs>${zoneGradient(id, zoneStops)}</defs>` +
    rects(0, BAR_W, '#9AA0A6', ' fill-opacity="0.25"') +
    rects(0, fillW, `url(#${id})`) +
    ticks.join('') +
    `</svg>`
  )
}

// Text drawn inside the SVG, in the Tiny5 pixel font (built into the mod),
// since the app's own text cannot go smaller than its caption size.
const FONT_PX = 8 // Tiny5 is drawn on a pixel grid; 8 px keeps it crisp
const ZONE_Y = BAR_H + 3 + 6 // baseline of the zone labels
const BAND_H = ZONE_Y + 3

// A thin line under the row, with space above and below, so the other mods'
// rows beneath never touch it. Always drawn: depending on load order the other
// mods may add their rows after this hook has run, so it cannot see them.
const DIVIDER_GAP = 6 // px above and below the line
const DIVIDER_H = DIVIDER_GAP * 2 + 1
const DIVIDER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${DIVIDER_H}">` +
  `<rect x="0" y="${DIVIDER_GAP}" width="100%" height="1" fill="#9AA0A6" fill-opacity="0.45"/>` +
  `</svg>`

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// A bar and the zone labels under it. `now` (0–1) picks the zone shown at
// full strength. The stats line below is the app's own text.
function bandSvg(segs: Seg[], fill: number, now: number, id: string): string {
  // Zone labels, each left-aligned just after the marker that starts its
  // section. A section too narrow for its word puts it at the bar's right end.
  // The zone in use now is full strength; the rest are faded.
  const labels = segs.map((sec, i) => {
    const isNow = now >= sec.from && (now < sec.to || (i === segs.length - 1 && now <= sec.to))
    const isTail = i > 0 && (sec.to - sec.from) * 100 < NARROW_PCT && i === segs.length - 1
    const at = isTail
      ? `x="100%" text-anchor="end"`
      : `x="${(sec.from * 100).toFixed(3)}%" dx="${i > 0 ? 3 : 0}"`
    const cls = sec.darkLabel ? ` class="z${i}"` : ''
    return `<text ${at} y="${ZONE_Y}"${cls} fill="${sec.color}" fill-opacity="${isNow ? 1 : 0.7}">${esc(sec.label)}</text>`
  })
  // Labels with a dark-mode colour switch to it when the app is dark.
  const dark = segs.map((sec, i) => (sec.darkLabel ? `.z${i}{fill:${sec.darkLabel}}` : '')).join('')
  const darkCss = dark ? `@media (prefers-color-scheme:dark){${dark}}` : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${BAND_H}">` +
    `<style>@font-face{font-family:'ContextPaneTiny5';src:url(data:font/woff2;base64,${TINY5_WOFF2_BASE64}) format('woff2')}` +
    `text{font-family:'ContextPaneTiny5',monospace;font-size:${FONT_PX}px;letter-spacing:0.4px}${darkCss}</style>` +
    barSvg(segs, fill, id) +
    labels.join('') +
    `</svg>`
  )
}

// ---- Cache bar -------------------------------------------------------------
// The time left before the prompt cache goes cold (hooks/cache.ts keeps the
// clock). The fill is the share of the cache time still left, so it
// goes from green through red into stone-cold blue.
const CACHE_SEGS: Seg[] = [
  // stone-cold blue; its label light blue in dark mode, its caption the theme's blue
  { label: 'WARNING', from: 0, to: 0.1, color: '#1A4E8C', darkLabel: '#8AB4F8', textColor: 'suggestion' },
  { label: 'COOLER', from: 0.1, to: 0.25, color: '#9C6ADE' }, // violet, between WARM's red and WARNING's blue
  { label: 'WARM', from: 0.25, to: 0.5, color: '#EA4335', endColor: '#FA7B17' }, // red, shading to orange towards FRESH
  { label: 'FRESH', from: 0.5, to: 1, color: '#1E8E3E', endColor: '#5BB974' }, // deep green to light green
]

// Once the cache is lost the whole bar turns grey: no fill, grey markers and labels.
const LOST = '#9AA0A6'
const LOST_SEGS: Seg[] = CACHE_SEGS.map(z => ({ ...z, color: LOST, endColor: undefined, darkLabel: undefined }))

function cacheColor(share: number): string {
  const z = CACHE_SEGS.find(z => share < z.to) ?? CACHE_SEGS[CACHE_SEGS.length - 1]!
  return z.textColor ?? z.color
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function ttlLabel(ms: number): string {
  if (ms >= 60 * 60_000) return '1 h'
  if (ms >= 60_000 * 2) return `${Math.round(ms / 60_000)} min`
  return `${Math.round(ms / 1000)} s`
}

type CacheView = { segs: Seg[]; fill: number; now: number; color: string; left: string; right: string; ttl: string; alt: string; isWarming: boolean }

// Icon buttons on the cache row.
const TTL_KEY = 'cache-ttl'
const ICON_TTL = '⏱' // switch the timer between 1 hour and 5 min
const KEEP_WARM_KEY = 'cache-keepwarm'
const HIDE_KEY = 'cache-hide'
const ICON_WARM = '♨' // Keep warm: a quiet icon while off, a lit (primary) button while it runs
const WARM_ON = '#FA7B17'
const ICON_HIDE = '✕' // hide the cache bar

// What the cache row shows now, or null when there is nothing to show.
async function cacheView($: EngineInterface, isWorking: boolean): Promise<CacheView | null> {
  const { clock, warm, hidden } = await readCache($)
  if (!clock || !clock.lastEnd || hidden) return null
  const right = warm ? 'Keep warm' : ''
  const ttl = `${ICON_TTL} ${ttlLabel(clock.ttlMs)}`
  // While Claude works every request refreshes the cache: it is full.
  const isWarming = !!warm
  if (isWorking) return { segs: CACHE_SEGS, fill: 1, now: 1, color: CACHE_SEGS[3]!.color, left: 'in use', right, ttl, alt: 'Cache in use', isWarming }
  const leftMs = clock.lastEnd + clock.ttlMs - clock.now
  if (leftMs <= 0) return { segs: LOST_SEGS, fill: 0, now: -1, color: LOST, left: 'lost', right, ttl, alt: 'Cache lost', isWarming }
  const fill = Math.min(1, leftMs / clock.ttlMs)
  return { segs: CACHE_SEGS, fill, now: fill, color: cacheColor(fill), left: `${mmss(leftMs)} left`, right, ttl, alt: `Cache ${mmss(leftMs)} left`, isWarming }
}

// ---- Session bar -----------------------------------------------------------
// How much of the 5-hour usage window ("Current session") is used, and when it
// resets. The fill grows with use; each zone keeps its colour, as the context bar.
const LIMIT_SEGS: Seg[] = [
  { label: 'OK', from: 0, to: 0.7, color: '#34A853' },
  { label: 'HIGH', from: 0.7, to: 0.9, color: '#FA7B17' },
  { label: 'LIMIT', from: 0.9, to: 1, color: '#EA4335' },
]

function limitColor(share: number): string {
  return (LIMIT_SEGS.find(z => share < z.to) ?? LIMIT_SEGS[LIMIT_SEGS.length - 1]!).color
}

// "2 h 14 min", "14 min", "under 1 min"
function untilText(ms: number): string {
  const m = Math.ceil(ms / 60_000)
  if (m <= 1) return 'under 1 min'
  const h = Math.floor(m / 60)
  return h > 0 ? `${h} h ${m % 60} min` : `${m} min`
}

type LimitView = { fill: number; color: string; left: string; right: string; alt: string }

function limitView(l: SessionLimit): LimitView {
  // Past the reset time the old figure no longer holds: a fresh window.
  if (l.resetsAt !== null && l.now >= l.resetsAt) {
    return { fill: 0, color: LIMIT_SEGS[0]!.color, left: '0%', right: 'reset', alt: 'Session reset' }
  }
  const fill = Math.max(0, Math.min(1, l.percent / 100))
  const pct = `${Math.round(l.percent)}%`
  const at = l.resetClock ? ` [${l.resetClock}]` : ''
  const right = l.resetsAt === null ? '' : `resets in ${untilText(l.resetsAt - l.now)}${at}`
  return { fill, color: limitColor(fill), left: pct, right, alt: `Session ${pct} used${right ? `, ${right}` : ''}` }
}

// Reads the 5-hour window from the same figures the status line has.
async function measureLimit($: EngineInterface, rateLimits: ReadonlyArray<{ kind: string; percentUsed: number; resetsAt?: string }>): Promise<void> {
  const five = rateLimits.find(r => r.kind === 'five_hour')
  const now = await $.clock.now()
  const resetsAt = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
  const at = Number.isNaN(resetsAt) ? null : resetsAt
  // The clock time is worked out only when the reset time changes.
  const old = await read($, sessionLimit)
  const resetClock = at === null ? undefined : old?.resetsAt === at && old.resetClock ? old.resetClock : await clockTime($, at)
  const next: SessionLimit | null = five ? { percent: five.percentUsed, resetsAt: at, now, ...(resetClock ? { resetClock } : {}) } : null
  await update($, sessionLimit, () => next)
}

// "20:32" in the person's own time zone: the system's date command knows it.
async function clockTime($: EngineInterface, ms: number): Promise<string | undefined> {
  const secs = String(Math.floor(ms / 1000))
  for (const argv of [['date', '-r', secs, '+%H:%M'], ['date', '-d', `@${secs}`, '+%H:%M']]) {
    const r = await $.process.run(argv).catch(() => null)
    const out = r?.stdout.trim() ?? ''
    if (r && r.exitCode === 0 && /^\d{2}:\d{2}$/.test(out)) return out
  }
  return undefined
}

// Every 30 s: moves the "resets in" countdown.
async function tickLimit($: EngineInterface): Promise<void> {
  const l = await read($, sessionLimit)
  if (!l) return
  const now = await $.clock.now()
  await update($, sessionLimit, () => ({ ...l, now }))
}

// Terminal fallback: the terminal draws no SVG.
function textBar(p: number | null): string {
  const cells = 10
  const filled = Math.min(cells, Math.max(0, Math.round(((p ?? 0) / 100) * cells)))
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

// Reads the same figures /context shows. `summary` estimates locally: no API calls.
async function measure($: EngineInterface): Promise<void> {
  const { context, rateLimits } = await $.session.usage({ breakdown: 'summary' })
  await measureLimit($, rateLimits ?? []).catch(() => undefined)
  const b = context.breakdown
  const cats = b?.categories ?? []
  const top: ContextRow[] = cats
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .sort((a, c) => c.tokens - a.tokens)
    .slice(0, 3)
    .map(c => ({ name: c.name, tokens: c.tokens }))
  const freeRow = cats.find(c => c.kind === 'free')
  const next: ContextSnapshot = {
    tokens: context.tokens ?? b?.totalTokens ?? null,
    window: context.window,
    percent: context.percent ?? b?.percentage ?? null,
    top,
    free: freeRow ? freeRow.tokens : null,
    ...(b?.isAutoCompactEnabled && b.autoCompactThreshold ? { compactAt: b.autoCompactThreshold } : {}),
  }
  await update($, snapshot, () => next)
}


// The pane id an earlier version opened; closed on start so it doesn't linger.
const OLD_PANE = 'context-pane'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-pane',
      description: 'Show or hide the context row. "1h" / "5m" sets the cache timer, "cache" shows or hides the cache bar, "keepwarm" / "keepwarm off" keeps the cache warm, "demo" one 60 s countdown for filming, "auto" reads the cache length from the chat again',
      argumentHint: '[1h|5m|auto|cache|keepwarm|keepwarm off|demo]',
      immediate: true,
    })
    const result = await next(e)
    await $.ui.close({ id: OLD_PANE }).catch(() => undefined)
    await measure($).catch(() => undefined)
    await cacheStart($)
    $.clock.every(30_000, () => {
      void tickLimit($).catch(() => undefined)
    })
    return result
  })

  on('turn.start', async ($, e, next) => {
    cacheTurnStart(e.text)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A helper's turn does not touch the main chat's cache.
    if (e.agentId === undefined) await cacheTurnComplete($)
    return result
  })

  // The person is back: a prompt of theirs ends keep warm.
  on('prompt.submit', async ($, e, next) => {
    await cachePrompt($, e.text, e.origin?.kind).catch(() => undefined)
    return next(e)
  })

  on('ui.press', { plugin: 'context-pane', element: 'cache-keepwarm' }, async ($, e, next) => {
    await toggleWarm($)
    return next(e)
  })

  on('ui.press', { plugin: 'context-pane', element: 'cache-ttl' }, async ($, e, next) => {
    await toggleTtl($)
    return next(e)
  })

  on('ui.press', { plugin: 'context-pane', element: 'cache-hide' }, async ($, e, next) => {
    await hideCache($)
    return next(e)
  })

  // Fires after each turn when the context moved.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') || e.changed.includes('rateLimits')) await measure($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'context-pane' }, async ($, e) => {
    const [arg = '', sub = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (arg === 'keepwarm') return { text: await keepWarmCommand($, sub) }
    if (arg === '1h' || arg === '5m') return { text: await setTtl($, arg) }
    if (arg === 'cache') {
      const { hidden } = await readCache($)
      await setCacheHidden($, !hidden)
      return { text: hidden ? 'Cache bar shown.' : 'Cache bar hidden. /context-pane cache shows it.' }
    }
    if (arg === 'demo' || arg === 'auto') {
      await setDemo($, arg === 'demo')
      return { text: arg === 'demo' ? 'Cache bar: one 60 s demo countdown, then back to your setting.' : 'Cache bar: length read from the chat again.' }
    }
    const hidden = await update($, isHidden, v => !v)
    if (!hidden) await measure($).catch(() => undefined)
    return { text: hidden ? 'Context Pane hidden. Run /context-pane to show it again.' : 'Context Pane shown.' }
  })

  // Drawn in the strip just above the prompt input, as its top row.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snap = await read($, snapshot)
    if (!snap || (await read($, isHidden))) return next(e)

    // Every other mod draws the rows beneath it first and its own row after,
    // so drawing ours before `rest` keeps this row on top of all of them.
    // Claude Code's own placeholder is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const rest = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const pc = zoneColor(snap)
    const used = snap.tokens === null ? '—' : short(snap.tokens)
    const pct = snap.percent === null ? '' : ` ${snap.percent}%`
    const cats = snap.top.map((r, i) => ({ label: r.name, value: short(r.tokens), color: LABEL_COLORS[i] ?? TICK }))
    if (snap.free !== null) cats.push({ label: 'Free', value: short(snap.free), color: FREE_COLOR })
    const cache = await cacheView($, e.props.isWorking)
    const lim = await read($, sessionLimit)
    const limit = lim ? limitView(lim) : null

    const noop = () => undefined

    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {limit ? (
            <Text wrap="truncate-end">
              <Text color={limit.color}>{textBar(limit.fill * 100)}</Text>
              <Text dimColor> Session </Text>
              <Text bold color={limit.color}>{limit.left}</Text>
              {limit.right ? <Text dimColor>{'  ·  ' + limit.right}</Text> : null}
            </Text>
          ) : null}
          <Text wrap="truncate-end">
            <Text color={pc}>{textBar(snap.percent)}</Text>
            <Text bold color={pc}> {used} / {short(snap.window)}{pct}</Text>
            {cats.map(c => (
              <Text key={c.label}>
                <Text dimColor>{'  ·  ' + c.label + ' '}</Text>
                <Text color={c.color}>{c.value}</Text>
              </Text>
            ))}
          </Text>
          {cache ? (
            <Box flexDirection="row" gap={1}>
              <Text wrap="truncate-end">
                <Text color={cache.color}>{textBar(cache.fill * 100)}</Text>
                <Text dimColor> Cache </Text>
                <Text bold color={cache.color}>{cache.left}</Text>
                {cache.right ? <Text color={WARM_ON}>{'  ·  ' + cache.right}</Text> : null}
              </Text>
              <Button key={TTL_KEY} label={cache.ttl} plain dimColor onPress={noop} />
              {cache.isWarming ? (
                <Button key={KEEP_WARM_KEY} label={ICON_WARM} variant="primary" onPress={noop} />
              ) : (
                <Button key={KEEP_WARM_KEY} label={ICON_WARM} plain dimColor onPress={noop} />
              )}
              <Button key={HIDE_KEY} label={ICON_HIDE} plain dimColor onPress={noop} />
            </Box>
          ) : null}
          {rest}
        </Box>
      )
    }

    const { Box, Text, Svg, Button } = $.ui.resolve(e as typeof e & { surface: 'desktop' })

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" width="100%">
          {/* The 5-hour usage window ("Current session") on top. */}
          {limit ? (
            <Box flexDirection="column" width="100%" marginBottom={1}>
              <Svg source={bandSvg(LIMIT_SEGS, limit.fill, limit.fill, 'context-pane-session')} height={BAND_H} alt={limit.alt} />
              <Box flexDirection="row" width="100%" justifyContent="space-between" gap={1}>
                <Text size="caption" wrap="truncate-end" tabular>
                  <Text dimColor>Session </Text>
                  <Text weight="semibold" color={limit.color}>{limit.left}</Text>
                </Text>
                {limit.right ? (
                  <Text size="caption" wrap="truncate-end" tabular>
                    <Text dimColor>{limit.right}</Text>
                  </Text>
                ) : null}
              </Box>
            </Box>
          ) : null}
          <Svg
            source={bandSvg(contextSegs(snap), (snap.tokens ?? 0) / snap.window, (snap.tokens ?? 0) / snap.window, 'context-pane-zones')}
            height={BAND_H}
            alt={`Context ${used} of ${short(snap.window)} tokens used${pct}`}
          />
          {/* The total on the left, the categories against the right edge. */}
          <Box flexDirection="row" width="100%" justifyContent="space-between" gap={1}>
            <Text size="caption" wrap="truncate-end" tabular>
              <Text dimColor>Total </Text>
              <Text weight="semibold" color={pc}>{used} / {short(snap.window)}{pct}</Text>
            </Text>
            <Text size="caption" wrap="truncate-end" tabular>
              {cats.map((c, i) => (
                <Text key={c.label}>
                  <Text dimColor>{(i > 0 ? '  ·  ' : '') + c.label + ' '}</Text>
                  <Text color={c.color} weight="medium">{c.value}</Text>
                </Text>
              ))}
            </Text>
          </Box>
          {cache ? (
            <Box flexDirection="column" width="100%" marginTop={1}>
              <Svg source={bandSvg(cache.segs, cache.fill, cache.now, 'context-pane-cache')} height={BAND_H} alt={cache.alt} />
              <Box flexDirection="row" width="100%" justifyContent="space-between" gap={1}>
                <Text size="caption" wrap="truncate-end" tabular>
                  <Text dimColor>Cache </Text>
                  <Text weight="semibold" color={cache.color}>{cache.left}</Text>
                </Text>
                <Box flexDirection="row" alignItems="center" gap={1}>
                  {cache.right ? (
                    <Text size="caption" wrap="truncate-end" tabular>
                      <Text color={WARM_ON}>{cache.right}</Text>
                    </Text>
                  ) : null}
                  <Button key={TTL_KEY} label={cache.ttl} plain dimColor onPress={noop} />
                  {cache.isWarming ? (
                <Button key={KEEP_WARM_KEY} label={ICON_WARM} variant="primary" onPress={noop} />
              ) : (
                <Button key={KEEP_WARM_KEY} label={ICON_WARM} plain dimColor onPress={noop} />
              )}
                  <Button key={HIDE_KEY} label={ICON_HIDE} plain dimColor onPress={noop} />
                </Box>
              </Box>
            </Box>
          ) : null}
        </Box>
        {/* The line only separates this row from other mods' rows beneath it. */}
        {rest ? <Svg source={DIVIDER_SVG} height={DIVIDER_H} alt="Divider" /> : null}
        {rest}
      </Box>
    )
  })
}
