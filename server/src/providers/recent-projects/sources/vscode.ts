import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Exec } from '../../exec.js'
import type { Source, SourceEntry } from '../types.js'
import { exists } from '../util.js'

const SQLITE = '/usr/bin/sqlite3'
const RECENT_KEY = 'history.recentlyOpenedPathsList'

/**
 * The folders of VS Code's "recently opened" list, most recent first. Files and remote
 * workspaces (`vscode-remote://…`) are left out: only a local `file://` folder is a project here.
 */
export function parseRecentlyOpened(json: string): string[] {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  const entries = (data as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return []
  const out: string[] = []
  for (const e of entries) {
    const uri = (e as { folderUri?: unknown })?.folderUri
    if (typeof uri !== 'string' || !uri.startsWith('file://')) continue
    try {
      out.push(fileURLToPath(uri))
    } catch { /* not a local path */ }
  }
  return out
}

/**
 * When each folder was last opened, from `workspaceStorage/<hash>/workspace.json` and the
 * modification time of that folder's own state. The recent list has no dates; this has them for
 * the folders the editor still keeps state for.
 */
async function workspaceDates(storage: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  let names: string[]
  try {
    names = await readdir(storage)
  } catch {
    return out
  }
  for (const name of names.slice(0, 500)) {
    try {
      const json = JSON.parse(await readFile(join(storage, name, 'workspace.json'), 'utf8')) as { folder?: unknown }
      if (typeof json.folder !== 'string' || !json.folder.startsWith('file://')) continue
      const dir = join(storage, name)
      const at = Math.max((await stat(dir)).mtimeMs, await stat(join(dir, 'state.vscdb')).then((s) => s.mtimeMs, () => 0))
      out.set(fileURLToPath(json.folder), at)
    } catch { /* no workspace.json, or not a folder */ }
  }
  return out
}

/**
 * VS Code and its forks (Cursor) keep the same files under their own Application Support folder.
 * The recent list is read with the system's `sqlite3`, read-only, one key; a folder with no
 * workspace date is placed just behind the one before it, which keeps the editor's order.
 */
export function createVscodeSource(
  id: 'vscode' | 'cursor',
  label: { fr: string; en: string },
  appSupportName: string,
  exec: Exec,
): Source {
  const userDir = (home: string) => join(home, 'Library', 'Application Support', appSupportName, 'User')
  return {
    id,
    label,
    available: async (ctx) => exists(join(userDir(ctx.home), 'globalStorage', 'state.vscdb')),
    async list(ctx) {
      const db = join(userDir(ctx.home), 'globalStorage', 'state.vscdb')
      const [stdout, dates, dbStat] = await Promise.all([
        exec(SQLITE, ['-readonly', '-cmd', '.timeout 1000', db, `SELECT value FROM ItemTable WHERE key = '${RECENT_KEY}'`]),
        workspaceDates(join(userDir(ctx.home), 'workspaceStorage')),
        stat(db),
      ])
      const out: SourceEntry[] = []
      let previous = dbStat.mtimeMs
      for (const path of parseRecentlyOpened(stdout.trim())) {
        const at = dates.get(path) ?? previous - 60_000
        out.push({ path, seenAt: at })
        previous = Math.min(previous, at)
      }
      return out
    },
  }
}
