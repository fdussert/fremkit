import { homedir } from 'node:os'
import { join } from 'node:path'
import { querySqlite } from './sqlite.js'
import { ThreadIdSchema } from './snapshot.js'

export interface LocalChatValidator {
  (threadId: string): Promise<boolean>
  validateMany?: (threadIds: string[]) => Promise<Set<string>>
}

/** Desktop-owned catalog membership, independent of source, title and thread status. */
export function createLocalChatValidator(options: { databasePath?: string; platform?: NodeJS.Platform } = {}): LocalChatValidator {
  const databasePath = options.databasePath ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sqlite', 'codex-dev.db')
  const validateMany = async (threadIds: string[]): Promise<Set<string>> => {
    const ids = [...new Set(threadIds.filter(id => ThreadIdSchema.safeParse(id).success))].slice(0, 50)
    if (!ids.length) return new Set()
    // UUID validation excludes SQL delimiters. The child sees one bounded page, not thread content.
    const quoted = ids.map(id => `'${id}'`).join(',')
    const query = `SELECT DISTINCT t.thread_id AS id FROM local_thread_catalog AS t
      JOIN local_thread_catalog_hosts AS h ON h.host_id=t.host_id
      WHERE t.host_id='local' AND h.host_kind='local' AND t.missing_candidate=0
      AND t.thread_id IN (${quoted});`
    try {
      const rows = await querySqlite(query, { path: databasePath, platform: options.platform, timeoutMs: 2000, maxBuffer: 8192 })
      if (!Array.isArray(rows)) return new Set()
      return new Set(rows.flatMap(row => row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' && ids.includes(row.id) ? [row.id] : []))
    } catch { return new Set() }
  }
  const validate: LocalChatValidator = async id => (await validateMany([id])).has(id)
  validate.validateMany = validateMany
  return validate
}
