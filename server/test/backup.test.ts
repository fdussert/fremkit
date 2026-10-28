import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { backupFilename, CONFIG_ENTRY, MANIFEST_ENTRY, readBackup, TILE_ICONS_PREFIX } from '../src/backup/routes.js'
import { readZip, writeZip } from '../src/backup/zip.js'
import { DEFAULT_BACKGROUND } from '../src/backgrounds/seed.js'
import { checkTileIcon, MAX_TILE_ICON_BYTES } from '../src/tile-icons/routes.js'
import { tr } from '../src/i18n.js'

/** A one-pixel PNG, which is what detectImageType has to accept. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const NAS_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="20" height="8" x="2" y="8"/></svg>')

const CONFIG = {
  version: 4,
  locale: 'fr',
  connections: [{ id: 'gh-x1z9', type: 'github', name: 'Travail', fields: { host: '' } }],
  secrets: { backend: 'file' },
  widgets: {},
  screens: [{
    id: 'edge', name: 'Xeneon Edge', kind: 'edge',
    display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
    pages: [{ id: 'home', name: 'Accueil', items: [] }],
  }],
}

let dir: string
let app: FastifyInstance

async function build(dataDir: string): Promise<FastifyInstance> {
  return buildApp({ accessToken: null, dataDir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [] })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-backup-'))
  await writeFile(join(dir, 'fremkit.json'), JSON.stringify(CONFIG), 'utf8')
  await mkdir(join(dir, 'backgrounds'), { recursive: true })
  await writeFile(join(dir, 'backgrounds', 'photo.png'), PNG)
  await mkdir(join(dir, 'tile-icons'), { recursive: true })
  await writeFile(join(dir, 'tile-icons', '1-nas.svg'), NAS_SVG)
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
    expect(config.version).toBe(4)
    expect(config.connections[0]).toMatchObject({ id: 'gh-x1z9', type: 'github', name: 'Travail' })
    // The keychain is the only place a secret lives; nothing in the archive may look like one.
    const whole = Buffer.concat(entries.map((e) => e.data)).toString('utf8')
    expect(whole).not.toMatch(/token|apiKey|accessCode|"pat"/)
    const manifest = JSON.parse(entries.find((e) => e.name === MANIFEST_ENTRY)!.data.toString('utf8'))
    expect(manifest).toMatchObject({ secrets: 'excluded', configVersion: 4 })
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
    expect(res.json()).toMatchObject({ ok: true, pages: 1, screens: 1 })

    // The config is the one that was backed up, connection and all.
    const restored = (await other.inject({ url: '/api/config' })).json()
    expect(restored.screens[0].pages[0].id).toBe('home')
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
    expect(restored.version).toBe(4)
    // v1 used 80 px cells on a 32x8 grid; v2 halves the cell and doubles the coordinates.
    expect(restored.screens[0].display).toMatchObject({ cols: 64, rows: 16, cell: 40 })
    expect(restored.screens[0].pages[0].items[0]).toMatchObject({ instanceId: 'c1', x: 2, y: 2, w: 16, h: 4 })
    expect(restored.widgets.c1).toMatchObject({ widgetId: 'clock' })
  })

  it('restoring a v3 archive yields a v4 config with one edge screen', async () => {
    // Every backup taken before screens existed is a v3 file: it must come back, not be refused.
    const v3 = {
      version: 3,
      locale: 'fr',
      display: { theme: 'edge', cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0, navWidgets: [] },
      pages: [
        { id: 'home', name: 'Accueil', widgets: [{ instanceId: 'c1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, settings: {} }] },
        { id: 'work', name: 'Travail', widgets: [] },
      ],
    }
    const res = await post(writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(v3), 'utf8') }]))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, pages: 2, screens: 1 })
    const restored = (await app.inject({ url: '/api/config' })).json()
    expect(restored.version).toBe(4)
    expect(restored.theme).toBe('edge')
    expect(restored.screens).toHaveLength(1)
    expect(restored.screens[0]).toMatchObject({ kind: 'edge' })
    expect(restored.screens[0].pages.map((p: { id: string }) => p.id)).toEqual(['home', 'work'])
    expect(restored.widgets.c1).toMatchObject({ widgetId: 'clock' })
  })

  it('counts the pages of every screen, and the screens', async () => {
    const two = {
      ...CONFIG,
      screens: [
        CONFIG.screens[0],
        { id: 'ipad', name: 'iPad', kind: 'device', pages: [{ id: 'a', name: 'A', items: [] }, { id: 'b', name: 'B', items: [] }] },
      ],
    }
    const res = await post(writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(two), 'utf8') }]))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, pages: 3, screens: 2 })
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

describe('tile icons in a backup', () => {
  it('archives the imported icons', async () => {
    const names = zipOf(await app.inject({ url: '/api/backup' })).map((e) => e.name)
    expect(names).toContain(`${TILE_ICONS_PREFIX}1-nas.svg`)
  })
  it('restores them beside the config', async () => {
    const archive = Buffer.from((await app.inject({ url: '/api/backup' })).rawPayload)
    await rm(join(dir, 'tile-icons'), { recursive: true, force: true })
    const res = await post(archive)
    expect(res.statusCode).toBe(200)
    expect(res.json().tileIcons).toBe(1)
    expect(await readFile(join(dir, 'tile-icons', '1-nas.svg'))).toEqual(NAS_SVG)
  })
  it('refuses an archive smuggling an active SVG, a JPEG, an oversize icon or a bad name', () => {
    const config = { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG)) }
    // A plain drawing padded past the limit with a comment, so only its size is wrong.
    const oversize = Buffer.concat([NAS_SVG, Buffer.from(`<!--${'x'.repeat(MAX_TILE_ICON_BYTES)}-->`)])
    expect(checkTileIcon(oversize).ok).toBe(true)
    for (const [entry, message] of [
      [{ name: `${TILE_ICONS_PREFIX}1-x.svg`, data: Buffer.from('<svg onload="x"/>') }, tr(undefined, 'backup.badTileIcon')],
      [{ name: `${TILE_ICONS_PREFIX}1-x.png`, data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]) }, tr(undefined, 'backup.badTileIcon')],
      [{ name: `${TILE_ICONS_PREFIX}1-big.svg`, data: oversize }, tr(undefined, 'backup.badTileIcon')],
      [{ name: `${TILE_ICONS_PREFIX}../../x.svg`, data: NAS_SVG }, tr(undefined, 'backup.badTileIconName')],
    ] as const) expect(() => readBackup(writeZip([config, entry], new Date())), entry.name).toThrow(message)
  })
  it('takes a library of a few hundred backgrounds and icons together', () => {
    const config = { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG)) }
    const icons = Array.from({ length: 300 }, (_, i) => ({ name: `${TILE_ICONS_PREFIX}${i}-x.svg`, data: NAS_SVG }))
    const bgs = Array.from({ length: 300 }, (_, i) => ({ name: `backgrounds/${i}.png`, data: PNG }))
    const read = readBackup(writeZip([config, ...icons, ...bgs], new Date()))
    expect([read.tileIcons.length, read.backgrounds.length]).toEqual([300, 300])
  })
  it('refuses an icon whose name claims another type than its bytes', () => {
    // The route serves an icon by its extension, so a `.svg` name on raster bytes would be
    // served as SVG — and RIFF…WEBP bytes can carry `<svg onload>` past the magic check.
    const config = { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(CONFIG)) }
    const webpSvg = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.from('<svg onload="x"/>')])
    expect(checkTileIcon(webpSvg).ok).toBe(true)
    for (const entry of [
      { name: `${TILE_ICONS_PREFIX}1-x.svg`, data: webpSvg },
      { name: `${TILE_ICONS_PREFIX}1-x.svg`, data: PNG },
      { name: `${TILE_ICONS_PREFIX}1-x.png`, data: NAS_SVG },
    ]) expect(() => readBackup(writeZip([config, entry], new Date())), entry.name).toThrow(tr(undefined, 'backup.badTileIcon'))
    const ok = readBackup(writeZip([config, { name: `${TILE_ICONS_PREFIX}1-x.png`, data: PNG }], new Date()))
    expect(ok.tileIcons.map((i) => i.name)).toEqual(['1-x.png'])
  })
})

describe('page backgrounds in a backup', () => {
  it('carries a page background and its image, and restores both', async () => {
    const config = structuredClone(CONFIG) as typeof CONFIG & { screens: { pages: Record<string, unknown>[] }[] }
    config.screens[0].pages[0].background = { image: 'photo.png', fit: 'contain' }
    await writeFile(join(dir, 'fremkit.json'), JSON.stringify(config), 'utf8')
    await app.close()
    app = await build(dir)
    const archive = Buffer.from((await app.inject({ url: '/api/backup' })).rawPayload)
    const fresh = await mkdtemp(join(tmpdir(), 'fremkit-restored-'))
    const other = await build(fresh)
    const res = await other.inject({
      method: 'POST', url: '/api/restore', headers: { 'content-type': 'application/zip' }, payload: archive,
    })
    expect(res.statusCode).toBe(200)
    const restored = (await other.inject({ url: '/api/config' })).json()
    expect(restored.screens[0].pages[0].background).toEqual({ image: 'photo.png', fit: 'contain' })
    expect(await readdir(join(fresh, 'backgrounds'))).toContain('photo.png')
    await other.close()
  })
})

describe('what an archive or a PUT cannot change', () => {
  const FORGED_CONSENT = {
    version: '1.0.0', registry: 'official', installedAt: '2026-01-01T00:00:00.000Z',
    consentedPermissions: { subscriptions: ['github:*'], commands: ['github:*'], network: ['evil.example'] },
    sharedConnections: ['gh-x1z9'],
  }

  it('restoring keeps this Mac\'s secrets backend, whichever one the archive names', async () => {
    const before = (await app.inject({ url: '/api/config' })).json()
    for (const backend of ['keychain', 'file', 'dpapi'].filter((b) => b !== before.secrets.backend)) {
      const archive = writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify({ ...CONFIG, secrets: { backend } })) }])
      expect((await post(archive)).statusCode).toBe(200)
      expect((await app.inject({ url: '/api/config' })).json().secrets).toEqual(before.secrets)
    }
  })

  it('restoring keeps this Mac\'s secrets backend, privacy choices and consent records', async () => {
    const before = (await app.inject({ url: '/api/config' })).json()
    const crafted = {
      ...CONFIG,
      secrets: { backend: before.secrets.backend === 'file' ? 'keychain' : 'file' },
      // A restored backup from another machine cannot tick a WSL distribution here either.
      privacy: { ...before.privacy, claudeAccountUsage: true, showAccountEmail: true, wslDistros: ['Ubuntu'] },
      marketplace: { installed: { 'evil-widget': FORGED_CONSENT } },
    }
    const archive = writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(crafted)) }])
    const res = await post(archive)
    expect(res.statusCode).toBe(200)
    const after = (await app.inject({ url: '/api/config' })).json()
    expect(after.secrets).toEqual(before.secrets)
    expect(after.privacy).toEqual(before.privacy)
    expect(after.privacy.wslDistros).toEqual([])
    expect(after.marketplace.installed).toEqual(before.marketplace.installed)
    expect(after.marketplace.installed['evil-widget']).toBeUndefined()
  })

  it('restoring keeps this Mac\'s experimental features switches, either way', async () => {
    for (const here of [true, false]) {
      const current = (await app.inject({ url: '/api/config' })).json()
      const mine = { devices: here, companion: !here }
      expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { ...current, labs: mine } })).statusCode).toBe(200)
      // A file stating the opposite, then one written before the switches existed with two
      // screens and a Fremplay widget, which the migration would turn both on for.
      for (const labs of [{ labs: { devices: !here, companion: here } }, {}]) {
        const crafted = {
          ...CONFIG, ...labs,
          widgets: { ...CONFIG.widgets, 'fremplay-1': { widgetId: 'fremplay', showTitle: false, settings: {} } },
          screens: [CONFIG.screens[0], { ...CONFIG.screens[0], id: 'second', name: 'Second' }],
        }
        const archive = writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(crafted)) }])
        expect((await post(archive)).statusCode).toBe(200)
        expect((await app.inject({ url: '/api/config' })).json().labs).toEqual(mine)
      }
    }
  })

  it('PUT /api/config without labs keeps the switches, and with them sets them', async () => {
    const current = (await app.inject({ url: '/api/config' })).json()
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { ...current, labs: { devices: true, companion: true } } })).statusCode).toBe(200)
    const { labs: _labs, ...without } = current
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: without })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/config' })).json().labs).toEqual({ devices: true, companion: true })
    // One switch sent, the other kept.
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { ...current, labs: { devices: false } } })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/config' })).json().labs).toEqual({ devices: false, companion: true })
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { ...current, labs: { companion: false } } })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/config' })).json().labs).toEqual({ devices: false, companion: false })
  })

  it('PUT /api/config replays the current consent records', async () => {
    const current = (await app.inject({ url: '/api/config' })).json()
    const res = await app.inject({
      method: 'PUT', url: '/api/config',
      payload: { ...current, marketplace: { installed: { 'evil-widget': FORGED_CONSENT } } },
    })
    expect(res.statusCode).toBe(200)
    const after = (await app.inject({ url: '/api/config' })).json()
    expect(after.marketplace.installed['evil-widget']).toBeUndefined()
    expect(after.marketplace.installed).toEqual(current.marketplace.installed)
  })
})
