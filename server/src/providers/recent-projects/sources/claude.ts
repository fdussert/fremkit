import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Source, SourceEntry } from '../types.js'
import { exists } from '../util.js'

/** How Claude Code names a project's folder: every character but letters and digits becomes `-`. */
export function encodeClaudeName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '-')
}

/** Folders read while decoding one name, past which it is given up. */
const MAX_READS = 200

/**
 * The path a `~/.claude/projects/<name>` folder stands for.
 *
 * The encoding is lossy — `/`, `.`, `_`, `-` and spaces all became `-` — so it is decoded against
 * the disk: from `/`, each child folder whose encoded name matches the next stretch of the name
 * is tried, longest first, until the whole name is used. The first folder that exists wins; a
 * project whose folder is gone decodes to null. Only folder names are read.
 */
export async function decodeClaudeName(encoded: string, root: string = sep): Promise<string | null> {
  let reads = 0
  async function walk(dir: string, rest: string): Promise<string | null> {
    if (rest === '') return dir
    if (reads++ >= MAX_READS) return null
    let names: string[]
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      names = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
    } catch {
      return null
    }
    const candidates = names
      .map((name) => ({ name, enc: '-' + encodeClaudeName(name) }))
      .filter(({ enc }) => rest === enc || (rest.startsWith(enc) && rest[enc.length] === '-'))
      .sort((a, b) => b.enc.length - a.enc.length)
    for (const c of candidates) {
      const found = await walk(join(dir, c.name), rest.slice(c.enc.length))
      if (found) return found
    }
    return null
  }
  if (!encoded.startsWith('-')) return null
  return walk(root, encoded)
}

/** The newest modification time among a folder's files: when the project was last talked to. */
async function newestInside(dir: string): Promise<number | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  let newest: number | null = null
  for (const name of names.slice(0, 500)) {
    try {
      const t = (await stat(join(dir, name))).mtimeMs
      if (newest === null || t > newest) newest = t
    } catch { /* removed meanwhile */ }
  }
  return newest
}

const RETRY_MS = 10 * 60_000

export function createClaudeSource(opts: { projectsDir?: (home: string) => string; root?: string } = {}): Source {
  const dirOf = opts.projectsDir ?? ((home: string) => join(home, '.claude', 'projects'))
  /**
   * Decoding reads folders: a name's answer is kept while the folder it named still exists, and a
   * name that decoded to nothing is tried again ten minutes later.
   */
  const decoded = new Map<string, { path: string | null; at: number }>()
  return {
    id: 'claude',
    label: { fr: 'Claude Code', en: 'Claude Code' },
    available: async (ctx) => exists(dirOf(ctx.home)),
    async list(ctx) {
      const base = dirOf(ctx.home)
      const names = (await readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
      const out: SourceEntry[] = []
      for (const name of names) {
        const known = decoded.get(name)
        let path = known?.path ?? null
        const stale = !known || (known.path === null ? Date.now() - known.at > RETRY_MS : !(await exists(known.path)))
        if (stale) {
          path = await decodeClaudeName(name, opts.root)
          decoded.set(name, { path, at: Date.now() })
        }
        if (!path) continue
        // Only modification times: no transcript is ever opened.
        out.push({ path, seenAt: await newestInside(join(base, name)) })
      }
      return out
    },
  }
}
