import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { BarId, ShownBars } from '../types'

// The bars a person can switch on and off, top to bottom. Each is a
// `userConfig` field in plugin.json (on by default), so a fresh install shows
// them all and a choice is remembered in every chat.
export const BARS: ReadonlyArray<{ id: BarId; option: string; label: string }> = [
  { id: 'week', option: 'showWeek', label: 'Week' },
  { id: 'session', option: 'showSession', label: '5h Session' },
  { id: 'context', option: 'showContext', label: 'Context' },
]

export const ALL_SHOWN: ShownBars = { week: true, session: true, context: true }

const shown = atom({ plugin: 'context-pane', key: 'shown' } as const, null)
const switchesOpen = atom({ plugin: 'context-pane', key: 'switchesOpen' } as const, false)

export function isBarId(word: string): word is BarId {
  return BARS.some(b => b.id === word)
}

/** The switches as the plugin's options hold them; a missing one is on. */
export function shownFromOptions(options: PluginOptions): ShownBars {
  return Object.fromEntries(BARS.map(b => [b.id, options[b.option] !== false])) as ShownBars
}

/** session.start: the switches as saved. */
export async function startBars($: EngineInterface, options: PluginOptions): Promise<void> {
  await update($, shown, () => shownFromOptions(options))
}

export async function readShown($: EngineInterface): Promise<ShownBars> {
  return (await read($, shown)) ?? ALL_SHOWN
}

/** Turns one bar on or off now, and saves it as the plugin's setting. */
export async function setBar($: EngineInterface, id: BarId, isOn: boolean): Promise<void> {
  await update($, shown, old => ({ ...(old ?? ALL_SHOWN), [id]: isOn }))
  const option = BARS.find(b => b.id === id)!.option
  // The setting's row as /config names it ("context-pane.showWeek", or with
  // the marketplace in the plugin's name).
  const rows = await $.config.list().catch(() => [])
  const key = rows.find(r => r.key.startsWith('context-pane') && r.key.endsWith(`.${option}`))?.key ?? `context-pane.${option}`
  // Saving can be refused (a managed setting); the bar still follows the switch for this chat.
  await $.config.set({ key, value: isOn }).catch(() => undefined)
}

export async function isSwitchesOpen($: EngineInterface): Promise<boolean> {
  return read($, switchesOpen)
}

export async function toggleSwitches($: EngineInterface): Promise<void> {
  await update($, switchesOpen, v => !v)
}

// ---- Week bar days ---------------------------------------------------------
// The week bar is split into days: 7 for a full week, 5 for a work week. It is
// the `workWeek` setting (off by default), so the choice holds in every chat.
export const WORK_WEEK_OPTION = 'workWeek'
export type WeekDays = 5 | 7

const weekDays = atom({ plugin: 'context-pane', key: 'weekDays' } as const, null)

/** session.start: the split as saved. */
export async function startWeekDays($: EngineInterface, options: PluginOptions): Promise<void> {
  await update($, weekDays, () => (options[WORK_WEEK_OPTION] === true ? 5 : 7))
}

export async function readWeekDays($: EngineInterface): Promise<WeekDays> {
  return (await read($, weekDays)) ?? 7
}

/** Sets the split now, and saves it as the plugin's setting. */
export async function setWeekDays($: EngineInterface, days: WeekDays): Promise<void> {
  await update($, weekDays, () => days)
  const rows = await $.config.list().catch(() => [])
  const key = rows.find(r => r.key.startsWith('context-pane') && r.key.endsWith(`.${WORK_WEEK_OPTION}`))?.key ?? `context-pane.${WORK_WEEK_OPTION}`
  // Saving can be refused (a managed setting); the bar still follows the switch for this chat.
  await $.config.set({ key, value: days === 5 }).catch(() => undefined)
}

// ---- Today marker ----------------------------------------------------------
// The light grey bar above the day section we are in. It is the `showToday`
// setting (on by default), so the choice holds in every chat.
export const TODAY_OPTION = 'showToday'

const showToday = atom({ plugin: 'context-pane', key: 'showToday' } as const, null)

/** session.start: the marker as saved (on unless switched off). */
export async function startToday($: EngineInterface, options: PluginOptions): Promise<void> {
  await update($, showToday, () => options[TODAY_OPTION] !== false)
}

export async function readToday($: EngineInterface): Promise<boolean> {
  return (await read($, showToday)) ?? true
}

/** Turns the marker on or off now, and saves it as the plugin's setting. */
export async function toggleToday($: EngineInterface): Promise<boolean> {
  const isOn = !(await readToday($))
  await update($, showToday, () => isOn)
  const rows = await $.config.list().catch(() => [])
  const key = rows.find(r => r.key.startsWith('context-pane') && r.key.endsWith(`.${TODAY_OPTION}`))?.key ?? `context-pane.${TODAY_OPTION}`
  // Saving can be refused (a managed setting); the marker still follows the switch for this chat.
  await $.config.set({ key, value: isOn }).catch(() => undefined)
  return isOn
}

export async function toggleWeekDays($: EngineInterface): Promise<WeekDays> {
  const days: WeekDays = (await readWeekDays($)) === 7 ? 5 : 7
  await setWeekDays($, days)
  return days
}
