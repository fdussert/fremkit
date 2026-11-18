import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { APP_IDS, type AppId } from './apps.js'
import type { SourceId } from './types.js'

/**
 * The file, in the data folder, that keeps what the live sources showed and the application each
 * project was told to open with, across restarts. Project paths live here and nowhere in the
 * config, so they never reach a backup, the config history, a shared layout or the diagnostics.
 */
export const MEMORY_FILE = 'recent-projects.json'
/** Folders a live source (a terminal pane) is remembered for, per source. */
export const LIVE_MEMORY = 50
/** The sources that show only what is open now, and so are remembered. */
export const LIVE_SOURCES = ['tmux', 'herdr'] as const satisfies readonly SourceId[]

/** Projects given an application of their own, at most; the least recently set go first. */
export const MAX_OPENERS = 200

/** Folder → the application a tap opens it with, oldest set first. */
export type Openers = Map<string, AppId>

/** Per live source, folder → last time it was seen (null when the source gave no date), oldest first. */
export type LiveMemory = Map<SourceId, Map<string, number | null>>

const Entry = z.object({ path: z.string().startsWith('/').max(4096), seenAt: z.number().nullable() })
const Opener = z.object({ path: Entry.shape.path, app: z.enum(APP_IDS) })
const FileSchema = z.object({
  version: z.literal(1),
  sources: z.record(z.string(), z.array(z.unknown())),
  openers: z.array(z.unknown()).optional(),
})

/** The file's two parts, as kept in memory. */
export interface SavedState {
  live: LiveMemory
  openers: Openers
}

/**
 * What `saveMemory` wrote, or an empty state when the file is missing, unreadable or not one of
 * ours: it is a convenience, never a reason not to start. Entries that do not check are dropped one
 * by one; each live source keeps its newest `LIVE_MEMORY`, the openers their newest `MAX_OPENERS`.
 */
export async function loadState(file: string): Promise<SavedState> {
  const state: SavedState = { live: new Map(), openers: new Map() }
  let parsed
  try {
    parsed = FileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return state
  }
  if (!parsed.success) return state
  for (const id of LIVE_SOURCES) {
    const seen = new Map<string, number | null>()
    for (const raw of parsed.data.sources[id] ?? []) {
      const e = Entry.safeParse(raw)
      if (e.success) seen.set(e.data.path, e.data.seenAt)
    }
    while (seen.size > LIVE_MEMORY) seen.delete(seen.keys().next().value!)
    if (seen.size) state.live.set(id, seen)
  }
  for (const raw of parsed.data.openers ?? []) {
    const o = Opener.safeParse(raw)
    if (!o.success) continue
    state.openers.delete(o.data.path)
    state.openers.set(o.data.path, o.data.app)
  }
  while (state.openers.size > MAX_OPENERS) state.openers.delete(state.openers.keys().next().value!)
  return state
}

/** The live sources' part of the file alone. */
export async function loadMemory(file: string): Promise<LiveMemory> {
  return (await loadState(file)).live
}

/** The file's text: paths and dates for the live sources, paths and application ids for the openers. */
export function serializeMemory(memory: LiveMemory, openers: Openers = new Map()): string {
  const sources: Record<string, { path: string; seenAt: number | null }[]> = {}
  for (const id of LIVE_SOURCES) {
    const seen = memory.get(id)
    if (seen?.size) sources[id] = [...seen].slice(-LIVE_MEMORY).map(([path, seenAt]) => ({ path, seenAt }))
  }
  const out: Record<string, unknown> = { version: 1, sources }
  if (openers.size) out.openers = [...openers].slice(-MAX_OPENERS).map(([path, app]) => ({ path, app }))
  return JSON.stringify(out) + '\n'
}

/** Writes the memory beside the config: owner-only, through a temporary file and a rename. */
export async function saveMemory(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}
