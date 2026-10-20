import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { SourceId } from './types.js'

/** The file, in the data folder, that keeps what the live sources showed across restarts. */
export const MEMORY_FILE = 'recent-projects.json'
/** Folders a live source (a terminal pane) is remembered for, per source. */
export const LIVE_MEMORY = 50
/** The sources that show only what is open now, and so are remembered. */
export const LIVE_SOURCES = ['tmux', 'herdr'] as const satisfies readonly SourceId[]

/** Per live source, folder → last time it was seen (null when the source gave no date), oldest first. */
export type LiveMemory = Map<SourceId, Map<string, number | null>>

const Entry = z.object({ path: z.string().startsWith('/').max(4096), seenAt: z.number().nullable() })
const FileSchema = z.object({
  version: z.literal(1),
  sources: z.record(z.string(), z.array(z.unknown())),
})

/**
 * The memory saved by `saveMemory`, or an empty one when the file is missing, unreadable or not
 * one of ours: it is a convenience, never a reason not to start. Entries that do not check are
 * dropped one by one, and each source keeps its newest `LIVE_MEMORY`.
 */
export async function loadMemory(file: string): Promise<LiveMemory> {
  const memory: LiveMemory = new Map()
  let parsed
  try {
    parsed = FileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return memory
  }
  if (!parsed.success) return memory
  for (const id of LIVE_SOURCES) {
    const seen = new Map<string, number | null>()
    for (const raw of parsed.data.sources[id] ?? []) {
      const e = Entry.safeParse(raw)
      if (e.success) seen.set(e.data.path, e.data.seenAt)
    }
    while (seen.size > LIVE_MEMORY) seen.delete(seen.keys().next().value!)
    if (seen.size) memory.set(id, seen)
  }
  return memory
}

/** The file's text for a memory: paths and dates only, live sources only. */
export function serializeMemory(memory: LiveMemory): string {
  const sources: Record<string, { path: string; seenAt: number | null }[]> = {}
  for (const id of LIVE_SOURCES) {
    const seen = memory.get(id)
    if (seen?.size) sources[id] = [...seen].slice(-LIVE_MEMORY).map(([path, seenAt]) => ({ path, seenAt }))
  }
  return JSON.stringify({ version: 1, sources }) + '\n'
}

/** Writes the memory beside the config: owner-only, through a temporary file and a rename. */
export async function saveMemory(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}
