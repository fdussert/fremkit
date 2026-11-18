import { constants } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Source, SourceEntry } from '../types.js'
import { exists } from '../util.js'

/** Session files looked at per poll, newest days first. */
const MAX_FILES = 150
/** The first line of a session (its `session_meta`) is read up to this many bytes, never further. */
const HEAD_BYTES = 128 * 1024

/**
 * The working folder a Codex session file records on its first line, or null.
 *
 * Only that line is read: `{"type":"session_meta","payload":{"cwd":…}}` in current versions,
 * a bare `{"cwd":…}` in older ones. The conversation that follows is never read.
 */
export async function sessionCwd(file: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const end = buffer.subarray(0, bytesRead).indexOf(10)
    if (end < 0) return null
    const first = JSON.parse(buffer.subarray(0, end).toString('utf8')) as Record<string, unknown>
    const payload = (first.payload && typeof first.payload === 'object' ? first.payload : first) as Record<string, unknown>
    return typeof payload.cwd === 'string' ? payload.cwd : null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

async function childrenDesc(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort().reverse()
  } catch {
    return []
  }
}

export function createCodexSource(opts: { sessionsDir?: (home: string) => string } = {}): Source {
  const dirOf = opts.sessionsDir ?? ((home: string) => join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions'))
  return {
    id: 'codex',
    label: { fr: 'Codex', en: 'Codex' },
    available: async (ctx) => exists(dirOf(ctx.home)),
    async list(ctx) {
      // sessions/YYYY/MM/DD/rollout-….jsonl: walked newest first until enough files are found.
      const base = dirOf(ctx.home)
      const files: string[] = []
      outer: for (const y of await childrenDesc(base)) {
        for (const m of await childrenDesc(join(base, y))) {
          for (const d of await childrenDesc(join(base, y, m))) {
            for (const f of await childrenDesc(join(base, y, m, d))) {
              if (!f.endsWith('.jsonl')) continue
              files.push(join(base, y, m, d, f))
              if (files.length >= MAX_FILES) break outer
            }
          }
        }
      }
      const out: SourceEntry[] = []
      for (const file of files) {
        const cwd = await sessionCwd(file)
        if (!cwd) continue
        try {
          out.push({ path: cwd, seenAt: (await stat(file)).mtimeMs })
        } catch { /* removed meanwhile */ }
      }
      return out
    },
  }
}
