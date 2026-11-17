import type { EngineInterface, PluginOptions } from 'claude-code'

import type { ContextSnapshot, SessionLimit, ShownBars, UsageSnapshotFile } from '../types'

// The snapshot file: the same figures the bars show, written as JSON each time
// the mod measures, so an app outside Claude Code (the Context Pane app for Mac
// and iPhone) can show them too. Nothing here reads the file back.
//
//   ~/.claude/context-pane/latest.json            the chat measured last
//   ~/.claude/context-pane/chats/<session id>.json one per chat
//
// It is the `writeSnapshot` setting (on by default). The schema is in
// types/index.d.ts (`UsageSnapshotFile`); `schema` goes up only when a field
// changes meaning or goes away, never when one is added.
export const SNAPSHOT_OPTION = 'writeSnapshot'
export const SNAPSHOT_SCHEMA = 1

/** Whether the snapshot file is written; on unless switched off. */
export function snapshotOn(options: PluginOptions): boolean {
  return options[SNAPSHOT_OPTION] !== false
}

/** The folder the files go in: `.claude/context-pane` in the home folder, or null when no home is known. */
export async function snapshotDir($: EngineInterface): Promise<string | null> {
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  if (!home) return null
  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  return [home.replace(/[\\/]+$/, ''), '.claude', 'context-pane'].join(sep)
}

/** The last part of a path: the chat's folder name, without the rest of the path. */
function folderName(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1]
}

/** A session id kept to the characters a file name can always hold. */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'chat'
}

export type SnapshotInput = {
  now: number
  chatId: string | undefined
  cwd: string | undefined
  limit: SessionLimit | null
  context: ContextSnapshot | null
  shown: ShownBars
  weekDays: 5 | 7
  showToday: boolean
}

/** The file's content, built from what the bars hold. Pure, so it is tested on its own. */
export function buildSnapshot(i: SnapshotInput): UsageSnapshotFile {
  const l = i.limit
  const window = (percent: number | undefined, resetsAt: number | null | undefined) =>
    percent === undefined ? null : { percent, resetsAt: resetsAt ?? null }
  return {
    schema: SNAPSHOT_SCHEMA,
    source: 'context-pane',
    capturedAt: i.now,
    capturedAtIso: new Date(i.now).toISOString(),
    chat: { id: i.chatId ?? null, folder: folderName(i.cwd) ?? null },
    usage: {
      fiveHour: l ? { percent: l.percent, resetsAt: l.resetsAt } : null,
      week: l ? window(l.week, l.weekResetsAt) : null,
      month: l ? window(l.month, null) : null,
    },
    context: i.context
      ? {
          tokens: i.context.tokens,
          window: i.context.window,
          percent: i.context.percent,
          top: i.context.top.map(r => ({ name: r.name, tokens: r.tokens })),
          free: i.context.free,
          compactAt: i.context.compactAt ?? null,
        }
      : null,
    settings: { shown: { ...i.shown }, weekDays: i.weekDays, showToday: i.showToday },
  }
}

/**
 * Writes the snapshot: the chat's own file, then latest.json. A failed write
 * (no home folder, a read-only disk) is let go: the bars never depend on it.
 */
export async function writeSnapshot($: EngineInterface, input: Omit<SnapshotInput, 'now' | 'chatId' | 'cwd'>): Promise<void> {
  const dir = await snapshotDir($)
  if (!dir) return
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const [now, chatId, cwd] = await Promise.all([
    $.clock.now(),
    $.session.id().catch(() => undefined),
    $.session.root().catch(() => $.session.cwd().catch(() => undefined)),
  ])
  const text = JSON.stringify(buildSnapshot({ ...input, now, chatId, cwd }), null, 2) + '\n'
  if (chatId) await $.fs.write([dir, 'chats', `${safeId(chatId)}.json`].join(sep), text).catch(() => undefined)
  await $.fs.write([dir, 'latest.json'].join(sep), text).catch(() => undefined)
}
