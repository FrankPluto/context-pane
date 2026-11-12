import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { SpeechSystem } from '../types'

// Read aloud: each of Claude's replies is spoken with the computer's own speech.
// At session start the mod checks which system it runs on and picks the tool:
// `say` on macOS, Windows' built-in System.Speech through PowerShell, and on
// Linux the first of espeak-ng, espeak or spd-say that is installed. With none,
// the speaker button is hidden. The button is the switch; it is also the
// `readAloud` setting, so the choice holds in every chat.
export const READ_ALOUD_OPTION = 'readAloud'
export const SPEAKER_KEY = 'read-aloud'

const readAloud = atom({ plugin: 'context-pane', key: 'readAloud' } as const, null)
const speaking = atom({ plugin: 'context-pane', key: 'speaking' } as const, false)
// The system found at session start and whether it has a speech tool; null until checked.
const speechSystem = atom({ plugin: 'context-pane', key: 'speechSystem' } as const, null)
const canSpeak = atom({ plugin: 'context-pane', key: 'canSpeak' } as const, null)

// The speaker button is text: "Speaking" while Read aloud is on, "Silent" when off.
const LABEL_ON = 'Speaking'
const LABEL_OFF = 'Silent'

/** A speech tool: the command that reads its standard input aloud, and how to cut it off. */
export type Voice = { name: string; argv: readonly string[]; stopArgv?: readonly string[] }

// Windows: the System.Speech synthesizer that ships with Windows. Standard input is
// read as UTF-8 so letters such as å, ä and ö are spoken right.
const WINDOWS_SCRIPT =
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' +
  'Add-Type -AssemblyName System.Speech; ' +
  '(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())'

export const VOICES = {
  say: { name: 'say', argv: ['say'] },
  windows: { name: 'powershell', argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT] },
  espeakNg: { name: 'espeak-ng', argv: ['espeak-ng', '--stdin'] },
  espeak: { name: 'espeak', argv: ['espeak', '--stdin'] },
  // spd-say hands the text to the speech-dispatcher service, so stopping it also cancels there.
  spdSay: { name: 'spd-say', argv: ['spd-say', '--wait', '--pipe-mode'], stopArgv: ['spd-say', '--cancel'] },
} as const satisfies Record<string, Voice>

// Linux tools in the order they are tried.
const LINUX_VOICES: readonly Voice[] = [VOICES.espeakNg, VOICES.espeak, VOICES.spdSay]

// The tool found at session start (found again on each reload), and the reading in progress.
let voice: Voice | null = null
let current: AsyncGenerator<unknown, unknown> | null = null
// Counts readings, so only the latest one's end clears `speaking`.
let reading = 0

/** Which system the mod runs on: Windows by its OS variable, macOS and Linux by `uname -s`. */
export async function detectSystem($: EngineInterface): Promise<SpeechSystem> {
  if ((await $.env.get('OS').catch(() => undefined)) === 'Windows_NT') return 'windows'
  const r = await $.process.run(['uname', '-s'], { timeoutMs: 5000 }).catch(() => undefined)
  const name = r?.exitCode === 0 ? r.stdout.trim() : ''
  if (name === 'Darwin') return 'macos'
  if (name === 'Linux') return 'linux'
  return 'other'
}

/** Whether a command is installed: it starts and answers `--version`. */
async function isInstalled($: EngineInterface, command: string): Promise<boolean> {
  const r = await $.process.run([command, '--version'], { timeoutMs: 5000 }).catch(() => undefined)
  return r?.exitCode === 0
}

/** The speech tool for this system, or null when it has none. */
export async function findVoice($: EngineInterface, system: SpeechSystem): Promise<Voice | null> {
  if (system === 'macos') return VOICES.say
  if (system === 'windows') return VOICES.windows
  if (system === 'linux') {
    for (const v of LINUX_VOICES) if (await isInstalled($, v.argv[0]!)) return v
  }
  return null
}

/** session.start: the switch as saved (on unless switched off), and the speech tool for this system. */
export async function startSpeech($: EngineInterface, options: PluginOptions): Promise<void> {
  await update($, readAloud, () => options[READ_ALOUD_OPTION] !== false)
  await setSpeaking($, false)
  const system = await detectSystem($)
  voice = await findVoice($, system)
  await update($, speechSystem, () => system)
  await update($, canSpeak, () => voice !== null)
}

async function setSpeaking($: EngineInterface, isSpeaking: boolean): Promise<void> {
  await update($, speaking, () => isSpeaking)
}

export async function isReadAloud($: EngineInterface): Promise<boolean> {
  return (await read($, readAloud)) ?? true
}

/** True once a speech tool was found on this computer. */
export async function hasVoice($: EngineInterface): Promise<boolean> {
  return (await read($, canSpeak)) === true
}

/** Why Read aloud cannot work here, for the command's answer. */
export async function noVoiceText($: EngineInterface): Promise<string> {
  const system = await read($, speechSystem)
  return system === 'linux'
    ? 'Read aloud needs a speech tool: install espeak-ng (or espeak, or speech-dispatcher) and start a new session.'
    : 'Read aloud is not available on this computer: no speech tool was found.'
}

/** The speaker button's text: Speaking when Read aloud is on, Silent when off; hidden without a speech tool. */
export async function speakerView($: EngineInterface): Promise<{ label: string; isOn: boolean; isShown: boolean }> {
  const isOn = await isReadAloud($)
  return { label: isOn ? LABEL_ON : LABEL_OFF, isOn, isShown: await hasVoice($) }
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
  // Closing the stream ends the speech program, on every system.
  const was = current
  current = null
  if (was) {
    await was.return(undefined).catch(() => undefined)
    if (voice?.stopArgv) await $.process.run(voice.stopArgv, { timeoutMs: 5000 }).catch(() => undefined)
  }
  await setSpeaking($, false)
}

/** turn.complete on the main chat: reads the reply aloud, cutting off one still being read. */
export async function speakReply($: EngineInterface, answer: string): Promise<void> {
  if (!(await isReadAloud($)) || !voice) return
  const text = plain(answer)
  if (!text) return
  await stopSpeaking($)
  await setSpeaking($, true)
  const mine = ++reading
  // The tool reads its standard input.
  const stream = $.process.spawn({ argv: voice.argv, input: text })
  current = stream
  // Not awaited: the turn ends at once and the reading goes on beside the chat.
  void (async () => {
    try {
      for await (const _ of stream) { /* no output to read */ }
    } finally {
      // Only this reading's end clears it: a newer reply may have started meanwhile.
      if (reading === mine) {
        current = null
        await setSpeaking($, false)
      }
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
