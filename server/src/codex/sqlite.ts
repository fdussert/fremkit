import { execFile } from 'node:child_process'
import { targetPlatform } from '../platform/index.js'

export interface SqliteQueryOptions {
  /** The database file, opened read-only: a missing file is an error, never created. */
  path: string
  /** `darwin` shells out to the system `sqlite3`; `win32` has none and uses `node:sqlite`. */
  platform?: NodeJS.Platform
  timeoutMs: number
  maxBuffer: number
}

/**
 * Run one read-only SELECT and return its rows. Rejects with `offline` when the database cannot be
 * read, `invalid` when the output is not rows, and `unsupported` when this Node has no `node:sqlite`.
 * The SQL is built by the caller from validated UUIDs only.
 */
export function querySqlite(sql: string, options: SqliteQueryOptions): Promise<unknown> {
  return targetPlatform(options.platform) === 'win32' ? queryNodeSqlite(sql, options) : queryCli(sql, options)
}

function queryCli(sql: string, { path, timeoutMs, maxBuffer }: SqliteQueryOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', [
      '-readonly', '-json', '-batch', '-cmd', 'PRAGMA query_only=ON;', '-cmd', '.timeout 1000', path, sql,
    ], { timeout: timeoutMs, maxBuffer, shell: false }, (error, stdout) => {
      if (error) return reject(Error('offline'))
      try { resolve(JSON.parse(stdout || '[]')) } catch { reject(Error('invalid')) }
    })
  })
}

async function queryNodeSqlite(sql: string, { path, timeoutMs }: SqliteQueryOptions): Promise<unknown> {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync
  try {
    // Loaded on demand: a Node without the module reports `unsupported` instead of failing at start.
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch { throw Error('unsupported') }
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    // `timeout` is SQLite's busy timeout: a locked database cannot hold the server past the bound.
    db = new DatabaseSync(path, { readOnly: true, timeout: timeoutMs })
    db.exec('PRAGMA query_only=ON;')
    return db.prepare(sql).all().map(row => ({ ...row }))
  } catch { throw Error('offline') } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}
