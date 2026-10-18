import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { createLocalChatValidator } from '../src/codex/local-chats.js'
const A = '01900000-0000-7000-8000-000000000001'
const B = '01900000-0000-7000-8000-000000000002'
const C = '01900000-0000-7000-8000-000000000003'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function database(sql: string) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-catalog-test-')); dirs.push(dir)
  const path = join(dir, 'catalog.db')
  execFileSync('/usr/bin/sqlite3', [path, sql])
  return path
}
const schema = `CREATE TABLE local_thread_catalog_hosts (host_id TEXT PRIMARY KEY, host_kind TEXT NOT NULL);
CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT, missing_candidate INTEGER NOT NULL);
INSERT INTO local_thread_catalog_hosts VALUES ('local','local'),('remote','ssh');`
describe('Codex desktop local catalog validation', () => {
  it('proves same-title chats by UUID while rejecting foreign, removed and absent IDs', async () => {
    const path = await database(`${schema}
INSERT INTO local_thread_catalog VALUES ('local','${A}','Same title',0),('local','${B}','Same title',0),('remote','${C}','Same title',0);`)
    const valid = createLocalChatValidator({ databasePath: path })
    expect(await valid(A)).toBe(true); expect(await valid(B)).toBe(true); expect(await valid(C)).toBe(false)
    expect(await valid('01900000-0000-7000-8000-000000000004')).toBe(false)
    execFileSync('/usr/bin/sqlite3', [path, `UPDATE local_thread_catalog SET missing_candidate=1 WHERE thread_id='${A}';`])
    expect(await valid(A)).toBe(false)
    expect(await valid("' OR 1=1 --")).toBe(false)
  })
  it('requires the authoritative local host kind even when a host ID is local', async () => {
    const path = await database(`${schema} INSERT INTO local_thread_catalog VALUES ('local','${A}','Same title',0); UPDATE local_thread_catalog_hosts SET host_kind='ssh' WHERE host_id='local';`)
    expect(await createLocalChatValidator({ databasePath: path })(A)).toBe(false)
  })
  it('checks a history page in one query and excludes IDs outside the local catalog', async () => {
    const path = await database(`${schema} INSERT INTO local_thread_catalog VALUES ('local','${A}','A',0),('remote','${B}','B',0),('local','${C}','C',1);`)
    const validator = createLocalChatValidator({ databasePath: path })
    expect(await validator.validateMany!([A, B, C, A, "' OR 1=1 --"])).toEqual(new Set([A]))
  })
  it('fails closed for missing or unsupported databases without creating one', async () => {
    const path = await database('CREATE TABLE unsupported (id TEXT);')
    expect(await createLocalChatValidator({ databasePath: path })(A)).toBe(false)
    const missing = join(dirs[0], 'missing.db')
    expect(await createLocalChatValidator({ databasePath: missing })(A)).toBe(false)
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
