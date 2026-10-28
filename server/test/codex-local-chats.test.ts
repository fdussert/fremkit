import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalChatValidator } from '../src/codex/local-chats.js'
// Fixtures are written with node:sqlite; the validator runs through every backend the platform can have.
const platforms: NodeJS.Platform[] = process.platform === 'win32' ? ['win32'] : ['darwin', 'win32']
function sqlite(path: string, sql: string) {
  const db = new DatabaseSync(path)
  try { db.exec(sql) } finally { db.close() }
}
const A = '01900000-0000-7000-8000-000000000001'
const B = '01900000-0000-7000-8000-000000000002'
const C = '01900000-0000-7000-8000-000000000003'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function database(sql: string) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-catalog-test-')); dirs.push(dir)
  const path = join(dir, 'catalog.db')
  sqlite(path, sql)
  return path
}
const schema = `CREATE TABLE local_thread_catalog_hosts (host_id TEXT PRIMARY KEY, host_kind TEXT NOT NULL);
CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT, missing_candidate INTEGER NOT NULL);
INSERT INTO local_thread_catalog_hosts VALUES ('local','local'),('remote','ssh');`
describe.each(platforms)('Codex desktop local catalog validation (%s)', platform => {
  it('proves same-title chats by UUID while rejecting foreign, removed and absent IDs', async () => {
    const path = await database(`${schema}
INSERT INTO local_thread_catalog VALUES ('local','${A}','Same title',0),('local','${B}','Same title',0),('remote','${C}','Same title',0);`)
    const valid = createLocalChatValidator({ databasePath: path, platform })
    expect(await valid(A)).toBe(true); expect(await valid(B)).toBe(true); expect(await valid(C)).toBe(false)
    expect(await valid('01900000-0000-7000-8000-000000000004')).toBe(false)
    sqlite(path, `UPDATE local_thread_catalog SET missing_candidate=1 WHERE thread_id='${A}';`)
    expect(await valid(A)).toBe(false)
    expect(await valid("' OR 1=1 --")).toBe(false)
  })
  it('requires the authoritative local host kind even when a host ID is local', async () => {
    const path = await database(`${schema} INSERT INTO local_thread_catalog VALUES ('local','${A}','Same title',0); UPDATE local_thread_catalog_hosts SET host_kind='ssh' WHERE host_id='local';`)
    expect(await createLocalChatValidator({ databasePath: path, platform })(A)).toBe(false)
  })
  it('checks a history page in one query and excludes IDs outside the local catalog', async () => {
    const path = await database(`${schema} INSERT INTO local_thread_catalog VALUES ('local','${A}','A',0),('remote','${B}','B',0),('local','${C}','C',1);`)
    const validator = createLocalChatValidator({ databasePath: path, platform })
    expect(await validator.validateMany!([A, B, C, A, "' OR 1=1 --"])).toEqual(new Set([A]))
  })
  it('fails closed for missing or unsupported databases without creating one', async () => {
    const path = await database('CREATE TABLE unsupported (id TEXT);')
    expect(await createLocalChatValidator({ databasePath: path, platform })(A)).toBe(false)
    const missing = join(dirs[0], 'missing.db')
    expect(await createLocalChatValidator({ databasePath: missing, platform })(A)).toBe(false)
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Codex catalog without node:sqlite', () => {
  it('fails closed when the module cannot be loaded', async () => {
    vi.resetModules()
    vi.doMock('node:sqlite', () => { throw new Error('No such built-in module') })
    try {
      const { querySqlite } = await import('../src/codex/sqlite.js')
      await expect(querySqlite('SELECT 1', { path: 'x', platform: 'win32', timeoutMs: 1, maxBuffer: 1 })).rejects.toThrow('unsupported')
    } finally { vi.doUnmock('node:sqlite'); vi.resetModules() }
  })
  it('opens node:sqlite read-only with the caller bound as its busy timeout', async () => {
    const opened: unknown[][] = []
    vi.resetModules()
    vi.doMock('node:sqlite', () => ({
      DatabaseSync: class {
        constructor(...args: unknown[]) { opened.push(args) }
        exec() {}
        prepare() { return { all: () => [{ id: 1 }] } }
        close() {}
      },
    }))
    try {
      const { querySqlite } = await import('../src/codex/sqlite.js')
      expect(await querySqlite('SELECT 1', { path: 'db', platform: 'win32', timeoutMs: 2500, maxBuffer: 1 })).toEqual([{ id: 1 }])
      expect(opened).toEqual([['db', { readOnly: true, timeout: 2500 }]])
    } finally { vi.doUnmock('node:sqlite'); vi.resetModules() }
  })
})
