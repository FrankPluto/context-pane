import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

// Read aloud: each of Claude's replies is spoken with macOS `say`. The speaker
// button next to ⚙ is the switch; it is also the `readAloud` setting, so the
// choice holds in every chat.
export const READ_ALOUD_OPTION = 'readAloud'
export const SPEAKER_KEY = 'read-aloud'

const readAloud = atom({ plugin: 'context-pane', key: 'readAloud' } as const, null)
const speaking = atom({ plugin: 'context-pane', key: 'speaking' } as const, false)

// The speaker button is text: "Speaking" while Read aloud is on, "Silent" when off.
const LABEL_ON = 'Speaking'
const LABEL_OFF = 'Silent'

// Counts readings, so only the latest one's end clears `speaking`.
let reading = 0

/** session.start: the switch as saved (on unless switched off). */
export async function startSpeech($: EngineInterface, options: PluginOptions): Promise<void> {
  await update($, readAloud, () => options[READ_ALOUD_OPTION] !== false)
  await setSpeaking($, false)
}

async function setSpeaking($: EngineInterface, isSpeaking: boolean): Promise<void> {
  await update($, speaking, () => isSpeaking)
}

export async function isReadAloud($: EngineInterface): Promise<boolean> {
  return (await read($, readAloud)) ?? true
}

/** The speaker button's text: Speaking when Read aloud is on, Silent when off. */
export async function speakerView($: EngineInterface): Promise<{ label: string; isOn: boolean }> {
  const isOn = await isReadAloud($)
  return { label: isOn ? LABEL_ON : LABEL_OFF, isOn }
}

/** Turns read aloud on or off now, saves it as the setting, and stops any reading when off. */
export async function setReadAloud($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, readAloud, () => isOn)
  const rows = await $.config.list().catch(() => [])
  const key = rows.find(r => r.key.startsWith('context-pane') && r.key.endsWith(`.${READ_ALOUD_OPTION}`))?.key ?? `context-pane.${READ_ALOUD_OPTION}`
  // Saving can be refused (a managed setting); the switch still holds for this chat.
  await $.config.set({ key, value: isOn }).catch(() => undefined)
  if (!isOn) await stopSpeaking($)
}

export async function toggleReadAloud($: EngineInterface): Promise<boolean> {
  const isOn = !(await isReadAloud($))
  await setReadAloud($, isOn)
  return isOn
}

async function stopSpeaking($: EngineInterface): Promise<void> {
  await $.process.run(['pkill', '-x', 'say']).catch(() => undefined)
  await setSpeaking($, false)
}

/** turn.complete on the main chat: reads the reply aloud, cutting off one still being read. */
export async function speakReply($: EngineInterface, answer: string): Promise<void> {
  if (!(await isReadAloud($))) return
  const text = plain(answer)
  if (!text) return
  await stopSpeaking($)
  await setSpeaking($, true)
  const mine = ++reading
  // Not awaited: the turn ends at once and the reading goes on beside the chat.
  void (async () => {
    try {
      // `say` with no words reads its standard input.
      for await (const _ of $.process.spawn({ argv: ['say'], input: text })) { /* no output to read */ }
    } finally {
      // Only this reading's end clears it: a newer reply may have started meanwhile.
      if (reading === mine) await setSpeaking($, false)
    }
  })().catch(() => undefined)
}

/** Markdown as words: no symbols, code blocks or link addresses read out. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#{1,6}|[-*+]|\d+\.|>|\|)\s*/gm, '')
    .replace(/^[\s|:-]+$/gm, '')
    .replace(/[*_~|#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
