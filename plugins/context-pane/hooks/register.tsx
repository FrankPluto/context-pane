import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BarId, ContextRow, ContextSnapshot, SessionLimit } from '../types'
import { BARS, isBarId, isSwitchesOpen, readShown, readToday, readWeekDays, setBar, setWeekDays, startBars, startToday, startWeekDays, toggleSwitches, toggleToday, toggleWeekDays } from './bars'
import { SPEAKER_KEY, speakReply, speakerView, startSpeech, toggleReadAloud } from './speech'
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
// The purple is too dark to read as a label on a dark background, so the label turns light purple there.
const COMPACT_ZONE = { label: 'AUTO-COMPACT', color: '#A142F4', darkLabel: '#D7AEFB' }
// A section narrower than this share of the bar shows its label at the
// right end of the section before it, so the words never overlap.
const NARROW_PCT = 9

type Section = { label: string; color: string; from: number; to: number; darkLabel?: string }

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
// `h` is the bar's height in px (the context bar uses BAR_H).
// `lineH` thinner than `h` draws a line of that height, centred, with every
// zone marker still `h` tall, so the markers read as in the full bars.
function barSvg(segs: Seg[], fill: number, id: string, h = BAR_H, lineH = h): string {
  const isLine = lineH < h
  const y = (h - lineH) / 2
  const fillW = Math.max(0, Math.min(BAR_W, fill * BAR_W))
  const x = (share: number) => share * BAR_W

  // A marker where each section begins. One the fill has not reached is a
  // coloured tick; one the fill has passed becomes a gap cut through the bar,
  // so it stays visible whatever colour the fill has there.
  const marks = segs.filter(sec => sec.from > 0)
  // A line too thin for a visible cut gets a full-height tick at every marker.
  const passed = isLine ? [] : marks.filter(sec => x(sec.from) < fillW)
  const ahead = isLine ? marks : marks.filter(sec => x(sec.from) >= fillW)
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
      .map(([a, b]) => `<rect x="${a}" y="${y}" width="${b - a}" height="${lineH}" fill="${paint}"${extra}/>`)
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

// ---- Session bar -----------------------------------------------------------
// How much of the 5-hour usage window ("Current session") is used, and when it
// resets. The fill grows with use; each zone keeps its colour, as the context bar.
const LIMIT_SEGS: Seg[] = [
  { label: 'OK', from: 0, to: 0.7, color: '#34A853' },
  { label: 'HIGH', from: 0.7, to: 0.9, color: '#FA7B17' },
  { label: 'LIMIT', from: 0.9, to: 1, color: '#EA4335' },
]

// The 7-day window: one section per day, green while the day is within pace
// and red where the usage has run ahead of it (see weekPace).
const WEEK_OK = LIMIT_SEGS[0]!.color // #34A853, the session bar's OK
const WEEK_AHEAD = LIMIT_SEGS[2]!.color // #EA4335, the session bar's LIMIT
const WEEK_COLOR = '#D81B60' // the "Week 46%" caption when pace is not known

// The colour `share` (0–1) of the way from `a` to `b`, both "#RRGGBB".
function mixHex(a: string, b: string, share: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return '#' + [0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * share).toString(16).padStart(2, '0')).join('').toUpperCase()
}


// A monthly window, drawn above the week bar only when one is reported. Today
// the engine reports five_hour, seven_day and a gateway's spend_limit, so this
// stays hidden until a monthly kind shows up. Indigo, used nowhere else.
const MONTH_LIGHT = '#7986CB'
const MONTH_DEEP = '#283593'
const MONTH_COLOR = '#3F51B5'
const MONTH_SEGS: Seg[] = LIMIT_SEGS.map(z => ({ ...z, color: mixHex(MONTH_LIGHT, MONTH_DEEP, z.from), endColor: mixHex(MONTH_LIGHT, MONTH_DEEP, z.to) }))
const MONTH_KIND = /month|30_?day|thirty_day/i

// The week and month bars are 1px lines in a BAR_H row, their zone markers
// BAR_H tall as in the session bar, each with a gap under it.
const THIN_H = 1
const THIN_GAP = 3 // px between a thin bar and the bar under it
const THIN_BOX = BAR_H + THIN_GAP

function thinSvg(segs: Seg[], share: number, id: string): string {
  const fill = Math.max(0, Math.min(1, share / 100))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${THIN_BOX}">${barSvg(segs, fill, id, BAR_H, THIN_H)}</svg>`
}

// ---- Week bar: usage against pace -------------------------------------------
// The week is split into days (7, or the 5 Mon–Fri days), each worth an equal
// share of the weekly limit. The 7-day window is cut into 24 h slots from its
// start (the weekly reset a week ago); in a work week only the Mon–Fri slots
// count, so weekends add no budget. Green is usage within the share of the days
// up to and including today; red is usage beyond it: budget of days still to come.
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

type WeekCell = { green: number; red: number } // each 0–1 of one day's section
// `today` is the day section we are in now (0 is the first), or null when it is unknown or a weekend in a work week.
// `labels` names each section's day ("TUESDAY", "WEDNESDAY"…), starting on the weekday the week resets; empty when unknown.
type WeekPace = { cells: WeekCell[]; labels: string[]; ahead: number; left: number; note: string; today: number | null }

const DAY_NAMES = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] // index 0 is Monday; Tiny5 holds A–Z only
const DAY_WORDS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/** The local weekday, 1 (Monday) to 7 (Sunday), of the window's 24 h slot `i`. */
const slotDow = (startDow: number, i: number) => ((startDow - 1 + i) % 7) + 1

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

function weekPace(l: SessionLimit, days: 5 | 7): WeekPace | null {
  if (l.week === undefined) return null
  const p = Math.max(0, Math.min(100, l.week))
  const share = 100 / days
  const known = l.weekResetsAt !== undefined && l.weekStartDow !== undefined && l.now < l.weekResetsAt
  // Work days from the start of the window up to and including today's slot.
  let elapsed = 0
  let todayIsWork = false
  let left = 0 // counted days left until the reset, with a fraction for what is left of today
  if (known) {
    const since = (l.now - (l.weekResetsAt! - WEEK_MS)) / DAY_MS
    const slot = Math.max(0, Math.min(6, Math.floor(since)))
    const isWork = (i: number) => days === 7 || slotDow(l.weekStartDow!, i) <= 5
    for (let i = 0; i <= slot; i++) if (isWork(i)) elapsed++
    todayIsWork = isWork(slot)
    if (todayIsWork) left += Math.max(0, slot + 1 - since)
    for (let i = slot + 1; i < 7; i++) if (isWork(i)) left++
  }
  const cells: WeekCell[] = Array.from({ length: days }, (_, j) => {
    const filled = clamp01((p - j * share) / share)
    // Without a reset time there is no pace: the whole fill stays green.
    return !known || j < elapsed ? { green: filled, red: 0 } : { green: 0, red: filled }
  })
  // The sections run in the window's own order, so the first is the day the week resets on.
  const labels = l.weekStartDow === undefined ? [] : Array.from({ length: 7 }, (_, i) => slotDow(l.weekStartDow!, i))
    .filter(d => days === 7 || d <= 5)
    .map(d => DAY_NAMES[d - 1]!)
  if (!known) return { cells, labels, ahead: 0, left: 0, note: '', today: null }
  const ahead = Math.max(0, p - elapsed * share)
  // Days left counts down to the reset: "7.0 d left" just after it, "6.3 d left" that evening.
  const parts: string[] = []
  if (ahead >= 0.5) parts.push(`ahead ${Math.round(ahead)}%`)
  // "last day" only while that day is under way; on a weekend before Monday it still reads "1.0 d left".
  if (left > 1 || (left > 0 && !todayIsWork)) parts.push(`${left.toFixed(1)} d left · ${Math.round(Math.max(0, 100 - p) / left)}%/day`)
  else if (left > 0) parts.push(`last day · ${Math.round(Math.max(0, 100 - p))}% left`)
  else parts.push('no work days left')
  return { cells, labels, ahead, left, note: parts.join(' · '), today: todayIsWork ? elapsed - 1 : null }
}

// The day we are in is marked by a light grey bar, 1 px tall, just above its section. It is still:
// nothing in the week bar moves. The space for it is always kept, so the rows below do not jump
// when the marker is switched on or off.
const TODAY_H = 1 // CSS pixels
const TODAY_GAP = 1 // px between the marker and the bars
const TODAY_COLOR = '#9AA0A6'
// The day names sit on top, then the today marker, then the bars.
const DAY_LABEL_Y = 6 // baseline of the day names (Tiny5 capitals are 5 px tall)
const TODAY_Y = DAY_LABEL_Y + 2
const WEEK_BARS_Y = TODAY_Y + TODAY_H + TODAY_GAP
const WEEK_BOX = WEEK_BARS_Y + BAR_H + THIN_GAP

/** One 4 px section per day, with a gap between: green for usage within pace, red beyond it. The day we are in has a light grey 1 px bar over it. */
function weekSvg(cells: WeekCell[], today: number | null, labels: string[] = [], todayColor = TODAY_COLOR): string {
  const n = cells.length
  const w = (BAR_W - GAP * (n - 1)) / n
  const rects = cells.flatMap((c, j) => {
    const x = j * (w + GAP)
    return [
      `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${BAR_H}" fill="#9AA0A6" fill-opacity="0.25"/>`,
      c.green > 0 ? `<rect x="${x.toFixed(2)}" y="0" width="${(w * c.green).toFixed(2)}" height="${BAR_H}" fill="${WEEK_OK}"/>` : '',
      c.red > 0 ? `<rect x="${(x + w * c.green).toFixed(2)}" y="0" width="${(w * c.red).toFixed(2)}" height="${BAR_H}" fill="${WEEK_AHEAD}"/>` : '',
    ]
  })
  const marker =
    today === null
      ? ''
      : `<svg y="${TODAY_Y}" width="100%" height="${TODAY_H}" viewBox="0 0 ${BAR_W} ${TODAY_H}" preserveAspectRatio="none">` +
        `<rect class="td" x="${(today * (w + GAP)).toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${TODAY_H}" fill="${TODAY_COLOR}"/></svg>`
  // Each day's name above its section, left-aligned with it. Today's is in the pace colour, the rest faded grey.
  const names = labels.length === n
    ? `<style>@font-face{font-family:'ContextPaneTiny5';src:url(data:font/woff2;base64,${TINY5_WOFF2_BASE64}) format('woff2')}` +
      `text{font-family:'ContextPaneTiny5',monospace;font-size:${FONT_PX}px;letter-spacing:0.4px}</style>` +
      labels.map((d, j) => `<text x="${((j * (w + GAP)) / BAR_W * 100).toFixed(3)}%" y="${DAY_LABEL_Y}" fill="${j === today ? todayColor : TODAY_COLOR}" fill-opacity="${j === today ? 1 : 0.6}">${d}</text>`).join('') 
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${WEEK_BOX}">${names}${marker}` +
    `<svg y="${WEEK_BARS_Y}" width="100%" height="${BAR_H}" viewBox="0 0 ${BAR_W} ${BAR_H}" preserveAspectRatio="none">${rects.join('')}</svg></svg>`
  )
}

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

// `until` and `clock` are `right` in two parts, so the clock time can stand out from the countdown.
type LimitView = { fill: number; color: string; left: string; right: string; alt: string; until?: string; clock?: string }

function limitView(l: SessionLimit): LimitView {
  // Past the reset time the old figure no longer holds: a fresh window.
  if (l.resetsAt !== null && l.now >= l.resetsAt) {
    return { fill: 0, color: LIMIT_SEGS[0]!.color, left: '0%', right: 'reset', alt: 'Session reset' }
  }
  const fill = Math.max(0, Math.min(1, l.percent / 100))
  const pct = `${Math.round(l.percent)}%`
  const at = l.resetClock ? ` ${l.resetClock}` : ''
  const right = l.resetsAt === null ? '' : `resets in ${untilText(l.resetsAt - l.now)}${at}`
  const until = l.resetsAt === null ? undefined : `resets in ${untilText(l.resetsAt - l.now)}`
  return {
    fill, color: limitColor(fill), left: pct, right, alt: `Session ${pct} used${right ? `, ${right}` : ''}`,
    ...(until ? { until } : {}), ...(until && l.resetClock ? { clock: l.resetClock } : {}),
  }
}

// Reads the 5-hour window from the same figures the status line has.
async function measureLimit($: EngineInterface, rateLimits: ReadonlyArray<{ kind: string; percentUsed: number; resetsAt?: string }>): Promise<void> {
  const five = rateLimits.find(r => r.kind === 'five_hour')
  const week = rateLimits.find(r => r.kind === 'seven_day')
  const month = rateLimits.find(r => MONTH_KIND.test(r.kind))
  const now = await $.clock.now()
  const resetsAt = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
  const at = Number.isNaN(resetsAt) ? null : resetsAt
  // The clock time is worked out only when the reset time changes.
  const old = await read($, sessionLimit)
  const resetClock = at === null ? undefined : old?.resetsAt === at && old.resetClock ? old.resetClock : await clockTime($, at)
  // The week's reset, and the weekday its window started on (worked out only when the reset changes).
  const weekParsed = week?.resetsAt ? Date.parse(week.resetsAt) : NaN
  const weekAt = Number.isNaN(weekParsed) ? null : weekParsed
  const sameWeek = old?.weekResetsAt === weekAt
  const weekStartDow = weekAt === null ? undefined : sameWeek && old.weekStartDow ? old.weekStartDow : await weekdayOf($, weekAt - WEEK_MS)
  // "Tue 04:00": the window starts and resets on the same weekday, at the same time.
  let weekResetClock = sameWeek ? old?.weekResetClock : undefined
  if (!weekResetClock && weekAt !== null && weekStartDow) {
    const clock = await clockTime($, weekAt)
    if (clock) weekResetClock = `${DAY_WORDS[weekStartDow - 1]} ${clock}`
  }
  const next: SessionLimit | null = five
    ? {
        percent: five.percentUsed, resetsAt: at, now, ...(resetClock ? { resetClock } : {}),
        ...(week ? { week: week.percentUsed } : {}),
        ...(weekAt !== null ? { weekResetsAt: weekAt } : {}),
        ...(weekStartDow ? { weekStartDow } : {}),
        ...(weekResetClock ? { weekResetClock } : {}),
        ...(month ? { month: month.percentUsed } : {}),
      }
    : null
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

// 1 (Monday) to 7 (Sunday): the local weekday of an instant; the system's date command knows the time zone.
async function weekdayOf($: EngineInterface, ms: number): Promise<number | undefined> {
  const secs = String(Math.floor(ms / 1000))
  for (const argv of [['date', '-r', secs, '+%u'], ['date', '-d', `@${secs}`, '+%u']]) {
    const r = await $.process.run(argv).catch(() => null)
    const out = r?.stdout.trim() ?? ''
    if (r && r.exitCode === 0 && /^[1-7]$/.test(out)) return Number(out)
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


const ICON_SWITCHES = '⚙' // opens the row of switches
// The same gear asked for in its one-colour text form (not the emoji), as a Material icon reads.
const ICON_SWITCHES_TEXT = '⚙︎'
const SWITCHES_KEY = 'switches'


// One figure of the usage caption: a dim label and a coloured value.
type Figure = { label: string; value: string; color: string; note?: string; noteColor?: string }

async function toggleBar($: EngineInterface, id: BarId): Promise<boolean> {
  const isOn = !(await readShown($))[id]
  await setBar($, id, isOn)
  return isOn
}

const HELP =
  'Show or hide the context row. "week", "session" or "context" switches one bar, "switches" opens the switches, ' +
  '"speak" switches Read aloud, "5d" / "7d" splits the week bar into a work week or a full week, "today" switches the grey bar above today'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-pane',
      description: HELP,
      argumentHint: '[week|session|context|switches|speak|5d|7d|today]',
      immediate: true,
    })
    const result = await next(e)
    await startBars($, options)
    await startSpeech($, options)
    await startWeekDays($, options)
    await startToday($, options)
    await measure($).catch(() => undefined)
    $.clock.every(30_000, () => {
      void tickLimit($).catch(() => undefined)
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Read aloud: the main chat's reply only, not a helper's or an interrupted one.
    if (e.agentId === undefined && e.reason === 'answer') await speakReply($, e.answer).catch(() => undefined)
    return result
  })

  // Fires after each turn when the context moved.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') || e.changed.includes('rateLimits')) await measure($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'context-pane' }, async ($, e) => {
    const [arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (isBarId(arg)) {
      const isOn = await toggleBar($, arg)
      const label = BARS.find(b => b.id === arg)!.label
      return { text: `${label} bar ${isOn ? 'shown' : `hidden. /context-pane ${arg} shows it`}.` }
    }
    if (arg === 'speak') {
      const isOn = await toggleReadAloud($)
      return { text: isOn ? 'Read aloud on: replies are read aloud.' : 'Read aloud off. /context-pane speak turns it on.' }
    }
    if (arg === 'today') {
      const isOn = await toggleToday($)
      return { text: isOn ? 'Today marker shown above the week bar.' : 'Today marker hidden. /context-pane today shows it.' }
    }
    if (arg === '5d' || arg === '7d') {
      await setWeekDays($, arg === '5d' ? 5 : 7)
      return { text: arg === '5d' ? 'Week bar: work week, 5 days.' : 'Week bar: full week, 7 days.' }
    }
    if (arg === 'switches') {
      await toggleSwitches($)
      return { text: (await isSwitchesOpen($)) ? 'Switches shown under the bars.' : 'Switches closed.' }
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

    const show = await readShown($)
    const isOpen = await isSwitchesOpen($)
    const lim = await read($, sessionLimit)
    const limit = lim && show.session ? limitView(lim) : null
    const month = lim?.month // drawn whenever Claude Code reports a monthly window
    const week = show.week ? lim?.week : undefined
    const days = await readWeekDays($)
    const pace = week !== undefined && lim ? weekPace(lim, days) : null
    const todayOn = await readToday($)
    const todaySection = todayOn ? (pace?.today ?? null) : null

    // The usage figures, in the order of the caption.
    const figures: Figure[] = [
      ...(limit ? [{ label: '5h Session', value: limit.left, color: limit.color }] : []),
      ...(week !== undefined
        ? [{
            label: 'Week Session',
            value: `${Math.round(week)}%`,
            // Green while within pace, red once ahead of it; pink when pace is not known.
            color: pace?.note ? (pace.ahead > 0 ? WEEK_AHEAD : WEEK_OK) : WEEK_COLOR,
            ...(pace?.note ? { note: pace.note, noteColor: pace.ahead > 0 ? WEEK_AHEAD : undefined } : {}),
          }]
        : []),
      ...(month !== undefined ? [{ label: 'Month', value: `${Math.round(month)}%`, color: MONTH_COLOR }] : []),
    ]
    const pc = zoneColor(snap)
    const used = snap.tokens === null ? '—' : short(snap.tokens)
    const pct = snap.percent === null ? '' : ` ${snap.percent}%`
    const cats = snap.top.map((r, i) => ({ label: r.name, value: short(r.tokens), color: LABEL_COLORS[i] ?? TICK }))
    if (snap.free !== null) cats.push({ label: 'Free', value: short(snap.free), color: FREE_COLOR })
    // The ⚙ sits at the end of the lowest row shown.
    const last = show.context ? 'context' : figures.length ? 'usage' : 'none'

    const speaker = await speakerView($)

    const { Box, Text, Button } = $.ui.resolve(e)
    const desktop = e.surface !== 'terminal'
    // The speaker (Read aloud) sits just before ⚙, so both stay in sight whichever bars are shown.
    // It is a text button: "Speaking" when Read aloud is on, "Silent" (dim) when off.
    // On the desktop the ⚙ is a one-colour glyph at heading size.
    const gear = [
      <Button key={SPEAKER_KEY} label={speaker.label} plain dimColor={!speaker.isOn} onPress={() => void toggleReadAloud($)} />,
      desktop ? (
        <Button key={SWITCHES_KEY} label="Settings" plain dimColor onPress={() => void toggleSwitches($)}>
          <Text size="heading">{ICON_SWITCHES_TEXT}</Text>
        </Button>
      ) : (
        <Button key={SWITCHES_KEY} label={ICON_SWITCHES} plain dimColor onPress={() => void toggleSwitches($)} />
      ),
    ]
    // A small filled dot for on and a small ring for off.
    const mark = (isOn: boolean) => (isOn ? '•' : '◦')
    const barButton = (b: (typeof BARS)[number]) => (
      <Button key={`bar-${b.id}`} label={`${mark(show[b.id])} ${b.label}`} plain dimColor={!show[b.id]} onPress={() => void toggleBar($, b.id)} />
    )
    // The same text button, in the caption size of the text under the bars on the desktop.
    const small = (key: string, label: string, isDim: boolean, press: () => void) =>
      desktop ? (
        <Button key={key} label={label} plain dimColor={isDim} onPress={press}>
          <Text size="caption">{label}</Text>
        </Button>
      ) : (
        <Button key={key} label={label} plain dimColor={isDim} onPress={press} />
      )
    // Everything about the week bar sits together, right after its own switch: 5d/7d and Today.
    // Then the other bars. Read aloud is not here: the Speaking /
    // Silent button beside ⚙ is its switch.
    const switches = isOpen ? (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {BARS.filter(b => b.id === 'week').map(barButton)}
        <Button key="switch-week-days" label={`${days}d`} plain onPress={() => void toggleWeekDays($)} />
        {small('switch-today', `${mark(todayOn)} Today`, !todayOn, () => void toggleToday($))}
        {BARS.filter(b => b.id !== 'week').map(barButton)}
      </Box>
    ) : null

    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column">
          {figures.length ? (
            <Box flexDirection="row" gap={1}>
              <Text wrap="truncate-end">
                {limit ? <Text color={limit.color}>{textBar(limit.fill * 100) + ' '}</Text> : null}
                {figures.map((f, i) => (
                  <Text key={f.label}>
                    <Text dimColor>{(i > 0 ? '   ' : '') + f.label + ' '}</Text>
                    <Text bold color={f.color}>{f.value}</Text>
                    {f.note ? <Text color={f.noteColor} dimColor={!f.noteColor}>{' · ' + f.note}</Text> : null}
                  </Text>
                ))}
                {limit?.right ? <Text dimColor>{'  ·  ' + limit.right}</Text> : null}
              </Text>
              {last === 'usage' ? gear : null}
            </Box>
          ) : null}
          {show.context ? (
            <Box flexDirection="row" gap={1}>
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
              {last === 'context' ? gear : null}
            </Box>
          ) : null}
          {last === 'none' ? (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>Context Pane: all bars off</Text>
              {gear}
            </Box>
          ) : null}
          {switches}
          {rest}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e as typeof e & { surface: 'desktop' })
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" width="100%">
          {/* Usage on top: the month and week lines over the 5-hour session bar. */}
          {figures.length ? (
            <Box flexDirection="column" width="100%" marginBottom={1}>
              {month !== undefined ? <Svg source={thinSvg(MONTH_SEGS, month, 'context-pane-month')} height={THIN_BOX} alt={`Month ${Math.round(month)}% used`} /> : null}
              {pace && week !== undefined ? (
                <Svg
                  source={weekSvg(pace.cells, todaySection, pace.labels, pace.ahead > 0 ? WEEK_AHEAD : WEEK_OK)}
                  height={WEEK_BOX}
                  alt={`Week ${Math.round(week)}% used, ${days} days${pace.labels.length ? ` from ${pace.labels[0]}` : ''}${todaySection !== null ? `, day ${todaySection + 1} now` : ''}${pace.ahead > 0 ? `, ${Math.round(pace.ahead)}% ahead of pace` : ''}`}
                />
              ) : null}
              {limit ? <Svg source={bandSvg(LIMIT_SEGS, limit.fill, limit.fill, 'context-pane-session')} height={BAND_H} alt={limit.alt} /> : null}
              <Box flexDirection="row" width="100%" justifyContent="space-between" alignItems="center" gap={1}>
                <Text size="caption" wrap="truncate-end" tabular>
                  {figures.map((f, i) => (
                    <Text key={f.label}>
                      <Text dimColor>{(i > 0 ? '   ' : '') + f.label + ' '}</Text>
                      <Text weight="semibold" color={f.color}>{f.value}</Text>
                      {f.note ? <Text color={f.noteColor} dimColor={!f.noteColor}>{' · ' + f.note}</Text> : null}
                    </Text>
                  ))}
                </Text>
                <Box flexDirection="row" alignItems="center" gap={1}>
                  {limit?.until ? (
                    <Text size="caption" wrap="truncate-end" tabular>
                      <Text dimColor>{`${limit.until} `}</Text>
                      {limit.clock ? <Text>{limit.clock}</Text> : null}
                    </Text>
                  ) : limit?.right ? (
                    <Text size="caption" dimColor>{limit.right}</Text>
                  ) : null}
                  {last === 'usage' ? gear : null}
                </Box>
              </Box>
            </Box>
          ) : null}
          {show.context ? (
            <Box flexDirection="column" width="100%">
              <Svg
                source={bandSvg(contextSegs(snap), (snap.tokens ?? 0) / snap.window, (snap.tokens ?? 0) / snap.window, 'context-pane-zones')}
                height={BAND_H}
                alt={`Context ${used} of ${short(snap.window)} tokens used${pct}`}
              />
              {/* The total on the left, the categories against the right edge. */}
              <Box flexDirection="row" width="100%" justifyContent="space-between" alignItems="center" gap={1}>
                <Text size="caption" wrap="truncate-end" tabular>
                  <Text dimColor>Total </Text>
                  <Text weight="semibold" color={pc}>{used} / {short(snap.window)}{pct}</Text>
                </Text>
                <Box flexDirection="row" alignItems="center" gap={1}>
                  <Text size="caption" wrap="truncate-end" tabular>
                    {cats.map((c, i) => (
                      <Text key={c.label}>
                        <Text dimColor>{(i > 0 ? '  ·  ' : '') + c.label + ' '}</Text>
                        <Text color={c.color} weight="medium">{c.value}</Text>
                      </Text>
                    ))}
                  </Text>
                  {last === 'context' ? gear : null}
                </Box>
              </Box>
            </Box>
          ) : null}
          {last === 'none' ? (
            <Box flexDirection="row" width="100%" justifyContent="space-between" alignItems="center" gap={1}>
              <Text size="caption" dimColor>Context Pane: all bars off</Text>
              {gear}
            </Box>
          ) : null}
          {switches ? <Box marginTop={1}>{switches}</Box> : null}
        </Box>
        {/* The line only separates this row from other mods' rows beneath it. */}
        {rest ? <Svg source={DIVIDER_SVG} height={DIVIDER_H} alt="Divider" /> : null}
        {rest}
      </Box>
    )
  })
}
