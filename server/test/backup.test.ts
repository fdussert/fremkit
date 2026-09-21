import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { backupFilename, CONFIG_ENTRY, MANIFEST_ENTRY, readBackup } from '../src/backup/routes.js'
import { readZip, writeZip } from '../src/backup/zip.js'
import { DEFAULT_BACKGROUND } from '../src/backgrounds/seed.js'

/** A one-pixel PNG, which is what detectImageType has to accept. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const CONFIG = {
  version: 3,
  locale: 'fr',
  display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
  connections: [{ id: 'gh-x1z9', type: 'github', name: 'Travail', fields: { host: '' } }],
  secrets: { backend: 'file' },
  pages: [{ id: 'home', name: 'Accueil', widgets: [] }],
}

let dir: string
let app: FastifyInstance

async function build(dataDir: string): Promise<FastifyInstance> {
  return buildApp({ dataDir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [] })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-backup-'))
  await writeFile(join(dir, 'fremkit.json'), JSON.stringify(CONFIG), 'utf8')
  await mkdir(join(dir, 'backgrounds'), { recursive: true })
  await writeFile(join(dir, 'backgrounds', 'photo.png'), PNG)
  app = await build(dir)
})
afterEach(async () => { await app.close() })

const zipOf = (res: { rawPayload: Buffer }) => readZip(Buffer.from(res.rawPayload))
const post = (body: Buffer) =>
  app.inject({ method: 'POST', url: '/api/restore', headers: { 'content-type': 'application/zip' }, payload: body })

describe('GET /api/backup', () => {
  it('answers a zip holding the config, the manifest and the backgrounds', async () => {
    const res = await app.inject({ url: '/api/backup' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="fremkit-backup-\d{4}-\d{2}-\d{2}\.zip"/)
    const names = zipOf(res).map((e) => e.name).sort()
    expect(names).toContain(CONFIG_ENTRY)
    expect(names).toContain(MANIFEST_ENTRY)
    expect(names).toContain('backgrounds/photo.png')
    // The seeded wallpaper travels too: it is an ordinary file in the library.
    expect(names).toContain(`backgrounds/${DEFAULT_BACKGROUND}`)
  })

  it('carries the live config, migrated, and no secret whatsoever', async () => {
    const res = await app.inject({ url: '/api/backup' })
    const entries = zipOf(res)
    const config = JSON.parse(entries.find((e) => e.name === CONFIG_ENTRY)!.data.toString('utf8'))
    expect(config.version).toBe(3)
    expect(config.connections[0]).toMatchObject({ id: 'gh-x1z9', type: 'github', name: 'Travail' })
    // The keychain is the only place a secret lives; nothing in the archive may look like one.
    const whole = Buffer.concat(entries.map((e) => e.data)).toString('utf8')
    expect(whole).not.toMatch(/token|apiKey|accessCode|"pat"/)
    const manifest = JSON.parse(entries.find((e) => e.name === MANIFEST_ENTRY)!.data.toString('utf8'))
    expect(manifest).toMatchObject({ secrets: 'excluded', configVersion: 3 })
    expect(manifest.fremkitVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('refuses a cross-site read: it hands back the whole dashboard', async () => {
    const res = await app.inject({ url: '/api/backup', headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.statusCode).toBe(403)
  })

  it('names the file after the day it was made', () => {
    expect(backupFilename(new Date('2026-09-18T22:10:00Z'))).toMatch(/^fremkit-backup-2026-09-\d{2}\.zip$/)
  })
})

describe('POST /api/restore', () => {
  it('round-trips: backup here, restore onto a fresh data dir', async () => {
    const archive = Buffer.from((await app.inject({ url: '/api/backup' })).rawPayload)

    const fresh = await mkdtemp(join(tmpdir(), 'fremkit-restored-'))
    const other = await build(fresh)
    const res = await other.inject({
      method: 'POST', url: '/api/restore',
      headers: { 'content-type': 'application/zip' }, payload: archive,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, pages: 1 })

    // The config is the one that was backed up, connection and all.
    const restored = (await other.inject({ url: '/api/config' })).json()
    expect(restored.pages[0].id).toBe('home')
    expect(restored.connections[0]).toMatchObject({ id: 'gh-x1z9', type: 'github', name: 'Travail' })
    // The backgrounds came with it.
    expect(await readdir(join(fresh, 'backgrounds'))).toContain('photo.png')
    expect(await readFile(join(fresh, 'backgrounds', 'photo.png'))).toEqual(PNG)
    await other.close()
  })

  it('names the connections whose secret really is missing', async () => {
    const archive = Buffer.from((await app.inject({ url: '/api/backup' })).rawPayload)
    const fresh = await mkdtemp(join(tmpdir(), 'fremkit-restored-'))
    const other = await build(fresh)
    const res = await other.inject({
      method: 'POST', url: '/api/restore',
      headers: { 'content-type': 'application/zip' }, payload: archive,
    })
    // The file backend with a fresh data dir: nothing was carried, so it has to be typed in.
    expect(res.json().reenterSecrets).toEqual([{ id: 'gh-x1z9', name: 'Travail', type: 'github' }])
    const listed = (await other.inject({ url: '/api/connections' })).json()
    expect(listed.find((c: { id: string }) => c.id === 'gh-x1z9').secrets.token).toBe(false)
    await other.close()
  })

  it('names nothing when the secrets are already there under the same ids', async () => {
    // Secrets are keyed by connection id and a restore keeps those ids, so restoring onto a data
    // dir that already holds them — the same Mac, which is the common case — needs nothing typed
    // in. Claiming otherwise would send the user to re-enter five working tokens.
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ 'gh-x1z9/token': 'still here' }), 'utf8')
    const reopened = await build(dir)
    const archive = Buffer.from((await reopened.inject({ url: '/api/backup' })).rawPayload)
    const res = await reopened.inject({
      method: 'POST', url: '/api/restore',
      headers: { 'content-type': 'application/zip' }, payload: archive,
    })
    expect(res.json().reenterSecrets).toEqual([])
    await reopened.close()
  })

  it('migrates a v1 config out of an archive', async () => {
    const v1 = {
      version: 1,
      display: { cols: 32, rows: 8, cell: 80, autoCycleSeconds: 0 },
      pages: [{ id: 'home', name: 'Accueil', widgets: [{ instanceId: 'c1', widgetId: 'clock', x: 1, y: 1, w: 8, h: 2 }] }],
    }
    const archive = writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(v1), 'utf8') }])
    const res = await post(archive)
    expect(res.statusCode).toBe(200)
    const restored = (await app.inject({ url: '/api/config' })).json()
    expect(restored.version).toBe(3)
    // v1 used 80 px cells on a 32x8 grid; v2 halves the cell and doubles the coordinates.
    expect(restored.display).toMatchObject({ cols: 64, rows: 16, cell: 40 })
    expect(restored.pages[0].widgets[0]).toMatchObject({ x: 2, y: 2, w: 16, h: 4 })
  })

  it('refuses an archive with no config in it', async () => {
    const res = await post(writeZip([{ name: 'backgrounds/a.png', data: PNG }]))
    expect(res.statusCode).toBe(400)
    expect(res.json().errors[0]).toMatch(/fremkit\.json/)
  })

  it('refuses a config that is not one', async () => {
    for (const body of ['{ nope', '{"version":99}', '[]', 'null']) {
      const res = await post(writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(body, 'utf8') }]))
      expect(res.statusCode, body).toBe(400)
    }
  })

  it('refuses a background name that tries to escape the directory', async () => {
    for (const name of ['backgrounds/../../../.ssh/authorized_keys', 'backgrounds/../evil.png',
      'backgrounds/.hidden.png', 'backgrounds/sub/dir.png']) {
      const res = await post(writeZip([
        { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG), 'utf8') },
        { name, data: PNG },
      ]))
      expect(res.statusCode, name).toBe(400)
      expect(res.json().errors[0], name).toMatch(/nom de fond|invalid background/)
    }
  })

  it('refuses a background that is not an image, whatever it is called', async () => {
    const res = await post(writeZip([
      { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG), 'utf8') },
      { name: 'backgrounds/evil.png', data: Buffer.from('<script>fetch("/api/config")</script>', 'utf8') },
    ]))
    expect(res.statusCode).toBe(400)
    expect(res.json().errors[0]).toMatch(/pas une image|not an image/)
  })

  it('writes nothing at all when it refuses', async () => {
    const before = (await readdir(join(dir, 'backgrounds'))).sort()
    await post(writeZip([
      { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG), 'utf8') },
      { name: 'backgrounds/good.png', data: PNG },
      { name: 'backgrounds/evil.png', data: Buffer.from('not an image', 'utf8') },
    ]))
    expect((await readdir(join(dir, 'backgrounds'))).sort()).toEqual(before)
  })

  it('refuses a body that is not a zip, and an empty one', async () => {
    expect((await post(Buffer.from('hello'))).statusCode).toBe(400)
    expect((await post(Buffer.alloc(0))).statusCode).toBe(400)
  })

  it('refuses a write from a page on another origin', async () => {
    const archive = writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG), 'utf8') }])
    const res = await app.inject({
      method: 'POST', url: '/api/restore',
      headers: { 'content-type': 'application/zip', origin: 'https://evil.example' }, payload: archive,
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses while the config on disk cannot be read', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'fremkit-degraded-restore-'))
    const onDisk = JSON.stringify({ version: 99, pages: [{ id: 'mine', name: 'Mienne' }] })
    await writeFile(join(bad, 'fremkit.json'), onDisk, 'utf8')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const other = await build(bad)
    err.mockRestore()
    const res = await other.inject({
      method: 'POST', url: '/api/restore',
      headers: { 'content-type': 'application/zip' },
      payload: writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG), 'utf8') }]),
    })
    expect(res.statusCode).toBe(409)
    expect(await readFile(join(bad, 'fremkit.json'), 'utf8')).toBe(onDisk)
    await other.close()
  })
})

describe('readBackup', () => {
  it('keeps the manifest out of the backgrounds', () => {
    const archive = writeZip([
      { name: MANIFEST_ENTRY, data: Buffer.from('{}', 'utf8') },
      { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG), 'utf8') },
      { name: 'backgrounds/a.png', data: PNG },
    ])
    const read = readBackup(archive)
    expect(read.backgrounds.map((b) => b.name)).toEqual(['a.png'])
  })

  it('ignores a file the archive holds that is none of our business', () => {
    const archive = writeZip([
      { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG), 'utf8') },
      { name: 'README.txt', data: Buffer.from('hello', 'utf8') },
      { name: 'backgrounds/', data: Buffer.alloc(0) },
    ])
    expect(readBackup(archive).backgrounds).toEqual([])
  })
})

/**
 * A restore keeps the connection ids, which is what lets a backup come back working on the same
 * Mac — and is also what lets an archive point an existing id at a host of its choosing. The
 * stored secret was issued for the old host; it must not follow the connection to the new one.
 */
describe('POST /api/restore and the secrets already on this machine', () => {
  const SECRETS = join('secrets.json')

  /** Restores `connections` onto `dir`, which already holds `gh-x1z9/token`. */
  async function restoreWith(connections: unknown[]): Promise<{ reenter: unknown; stored: Record<string, string> }> {
    await writeFile(join(dir, SECRETS), JSON.stringify({ 'gh-x1z9/token': 'issued for the old host' }), 'utf8')
    const other = await build(dir)
    const archive = writeZip([
      { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify({ ...CONFIG, connections }), 'utf8') },
    ])
    const res = await other.inject({
      method: 'POST', url: '/api/restore',
      headers: { 'content-type': 'application/zip' }, payload: archive,
    })
    expect(res.statusCode).toBe(200)
    await other.close()
    let stored: Record<string, string> = {}
    try { stored = JSON.parse(await readFile(join(dir, SECRETS), 'utf8')) } catch { /* deleted */ }
    return { reenter: res.json().reenterSecrets, stored }
  }

  it('keeps the secret when the connection comes back unchanged', async () => {
    const { reenter, stored } = await restoreWith([
      { id: 'gh-x1z9', type: 'github', name: 'Travail', fields: { host: '' } },
    ])
    expect(stored['gh-x1z9/token']).toBe('issued for the old host')
    expect(reenter).toEqual([])
  })

  it('drops the secret when the archive moves the connection to another host', async () => {
    const { reenter, stored } = await restoreWith([
      { id: 'gh-x1z9', type: 'github', name: 'Travail', fields: { host: 'https://198.51.100.9' } },
    ])
    expect(stored['gh-x1z9/token']).toBeUndefined()
    expect(reenter).toEqual([{ id: 'gh-x1z9', name: 'Travail', type: 'github' }])
  })

  it('drops the secret when the archive gives the id another type', async () => {
    const { reenter, stored } = await restoreWith([
      { id: 'gh-x1z9', type: 'bambu', name: 'Imprimante', fields: { host: '198.51.100.9', serial: 'P1', model: 'X1C' } },
    ])
    expect(stored['gh-x1z9/token']).toBeUndefined()
    expect(reenter).toEqual([{ id: 'gh-x1z9', name: 'Imprimante', type: 'bambu' }])
  })

  it('forgets the secret of a connection the restore drops', async () => {
    // `syncNow` unregisters the vanished provider but never touched the keychain: the item stayed
    // behind under an id nothing used, waiting for an archive to claim it.
    const { stored } = await restoreWith([])
    expect(stored['gh-x1z9/token']).toBeUndefined()
  })
})
