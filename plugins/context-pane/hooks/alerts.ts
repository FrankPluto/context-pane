import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { SessionLimit } from '../types'

// Alerts: a notification through the person's own notification channel when the
// 5-hour window passes 80% and 95%, and once it resets after such a warning.
// Off by default; the `alerts` setting, so the choice holds in every chat.
// Each warning is sent once per window, so nothing repeats while the figure sits there.
export const ALERTS_OPTION = 'alerts'
export const ALERT_LEVELS = [80, 95] as const
const TITLE = 'Context Pane'

const alertsOn = atom({ plugin: 'context-pane', key: 'alerts' } as const, null)
// The window the warnings belong to (its reset time), the levels already sent, and whether
// the reset was told. Kept in the store, across chats, so a new chat does not warn again.
const ALERTED_KEY = 'alerted'
type Alerted = { window: number | null; levels: number[]; resetTold: boolean }

async function readAlerted($: EngineInterface): Promise<Alerted | null> {
  const v = (await $.store.get(ALERTED_KEY).catch(() => undefined)) as Partial<Alerted> | undefined
  if (!v || typeof v !== 'object' || !Array.isArray(v.levels)) return null
  return { window: typeof v.window === 'number' ? v.window : null, levels: v.levels.filter(n => typeof n === 'number'), resetTold: v.resetTold === true }
}

async function writeAlerted($: EngineInterface, value: Alerted): Promise<void> {
  await $.store.set(ALERTED_KEY, value).catch(() => undefined)
}

/** session.start: alerts as saved (off unless switched on). */
export async function startAlerts($: EngineInterface, options: PluginOptions): Promise<void> {
  await update($, alertsOn, () => options[ALERTS_OPTION] === true)
}

export async function readAlerts($: EngineInterface): Promise<boolean> {
  return (await read($, alertsOn)) ?? false
}

/** Turns alerts on or off now, and saves it as the plugin's setting. */
export async function toggleAlerts($: EngineInterface): Promise<boolean> {
  const isOn = !(await readAlerts($))
  await update($, alertsOn, () => isOn)
  const rows = await $.config.list().catch(() => [])
  const key = rows.find(r => r.key.startsWith('context-pane') && r.key.endsWith(`.${ALERTS_OPTION}`))?.key ?? `context-pane.${ALERTS_OPTION}`
  // Saving can be refused (a managed setting); alerts still follow the switch for this chat.
  await $.config.set({ key, value: isOn }).catch(() => undefined)
  return isOn
}

/**
 * After each reading and each tick: sends what is due. `until` is the "resets in"
 * text, when known. A warning is only sent while the window is live; the reset
 * notice only after a warning in that window, so a quiet window stays quiet.
 */
export async function checkAlerts($: EngineInterface, l: SessionLimit, until?: string): Promise<void> {
  if (!(await readAlerts($))) return
  const old = await readAlerted($)
  const isPast = l.resetsAt !== null && l.now >= l.resetsAt
  if (isPast) {
    if (old && old.window === l.resetsAt && old.levels.length > 0 && !old.resetTold) {
      await writeAlerted($, { ...old, resetTold: true })
      await $.ui.notify('Your 5-hour window has reset.', { title: TITLE, key: 'context-pane-reset' }).catch(() => undefined)
    }
    return
  }
  const state: Alerted = old && old.window === l.resetsAt ? old : { window: l.resetsAt, levels: [], resetTold: false }
  const crossed = ALERT_LEVELS.filter(level => l.percent >= level && !state.levels.includes(level))
  if (crossed.length === 0) {
    if (state !== old) await writeAlerted($, state)
    return
  }
  // A jump past both levels sends the higher one only.
  await writeAlerted($, { ...state, levels: [...state.levels, ...crossed] })
  const text = `5-hour window at ${Math.round(l.percent)}%${until ? `, ${until}` : ''}.`
  await $.ui.notify(text, { title: TITLE, key: 'context-pane-limit' }).catch(() => undefined)
}
