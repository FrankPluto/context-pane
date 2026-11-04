import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { BarId, ShownBars } from '../types'

// The bars a person can switch on and off, top to bottom. Each is a
// `userConfig` field in plugin.json (on by default), so a fresh install shows
// them all and a choice is remembered in every chat.
export const BARS: ReadonlyArray<{ id: BarId; option: string; label: string }> = [
  { id: 'month', option: 'showMonth', label: 'Month' },
  { id: 'week', option: 'showWeek', label: 'Week' },
  { id: 'session', option: 'showSession', label: '5h Session' },
  { id: 'context', option: 'showContext', label: 'Context' },
  { id: 'cache', option: 'showCache', label: 'Cache' },
]

export const ALL_SHOWN: ShownBars = { month: true, week: true, session: true, context: true, cache: true }

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
