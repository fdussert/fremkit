import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ConfigHistory } from '../src/config/history.js'
import { ConfigSchema } from '../src/config/schema.js'
import { CONFIG_ENTRY } from '../src/backup/routes.js'
import { writeZip } from '../src/backup/zip.js'

const CONFIG = {
  version: 4,
  locale: 'en',
  secrets: { backend: 'file' },
  privacy: { claudeAccountUsage: false, showAccountEmail: false },
  widgets: {},
  screens: [{
    id: 'edge', name: 'Xeneon Edge', kind: 'edge',
    display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
    pages: [{ id: 'home', name: 'Home', items: [] }],
  }],
}

let dir: string
let app: FastifyInstance

const build = () => buildApp({ accessToken: null, dataDir: dir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [] })
const config = async () => (await app.inject({ url: '/api/config' })).json()
const list = async () => (await app.inject({ url: '/api/history' })).json().entries as { id: string; kind: string; savedAt: number }[]
async function renamePage(name: string): Promise<void> {
  const current = await config()
  current.screens[0].pages[0].name = name
  const res = await app.inject({ method: 'PUT', url: '/api/config', payload: current })
  expect(res.statusCode).toBe(200)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-history-routes-'))
  await writeFile(join(dir, 'fremkit.json'), JSON.stringify(CONFIG), 'utf8')
})
afterEach(async () => { await app?.close() })

describe('history routes', () => {
  beforeEach(async () => { app = await build() })

  it('lists the versions newest first and reads one back', async () => {
    await renamePage('Desk')
    const entries = await list()
    expect(entries.map((e) => e.kind)).toEqual(['save', 'earlier'])
    const res = await app.inject({ url: `/api/history/${entries[1].id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().config.screens[0].pages[0].name).toBe('Home')
  })

  it('answers 404 to an id that is not one, traversal included', async () => {
    for (const id of ['..%2Ffremkit', 'index', '0000000000000-abcdef']) {
      expect((await app.inject({ url: `/api/history/${id}` })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: `/api/history/${id}/restore` })).statusCode).toBe(404)
    }
  })

  it('refuses a cross-site read: it hands back a whole dashboard', async () => {
    const res = await app.inject({ url: '/api/history', headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.statusCode).toBe(403)
  })

  it('puts a version back as a save of its own, which can itself be undone', async () => {
    await renamePage('Desk')
    const earlier = (await list()).find((e) => e.kind === 'earlier')!
    const res = await app.inject({ method: 'POST', url: `/api/history/${earlier.id}/restore` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, screens: 1, pages: 1, reenterSecrets: [] })
    expect((await config()).screens[0].pages[0].name).toBe('Home')

    const entries = await list()
    expect(entries.map((e) => e.kind)).toEqual(['revert', 'save', 'earlier'])
    // The version the restore replaced is still there: restoring it undoes the restore.
    const back = await app.inject({ method: 'POST', url: `/api/history/${entries[1].id}/restore` })
    expect(back.statusCode).toBe(200)
    expect((await config()).screens[0].pages[0].name).toBe('Desk')
  })

  it('a backup restore leaves the version it replaced in the history', async () => {
    const archive = writeZip([{ name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify({
      ...CONFIG, screens: [{ ...CONFIG.screens[0], pages: [{ id: 'other', name: 'Other', items: [] }] }],
    })) }])
    const res = await app.inject({ method: 'POST', url: '/api/restore', headers: { 'content-type': 'application/zip' }, payload: archive })
    expect(res.statusCode).toBe(200)
    const entries = await list()
    expect(entries.map((e) => e.kind)).toEqual(['restore', 'earlier'])
    const before = await app.inject({ url: `/api/history/${entries[1].id}` })
    expect(before.json().config.screens[0].pages[0].name).toBe('Home')
  })
})

describe('restoring an old version keeps this Mac\'s security settings', () => {
  it('leaves the experimental features switch as it is now', async () => {
    // An old version from before the switch was ticked: one screen, flag off.
    const old = ConfigSchema.parse({ ...CONFIG, labs: { devices: false, companion: false } })
    const history = new ConfigHistory(join(dir, 'history'))
    await history.recordChange(old, old, 'save')
    const [entry] = await history.list()

    app = await build()
    const current = await config()
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { ...current, labs: { devices: true, companion: true } } })).statusCode).toBe(200)
    const res = await app.inject({ method: 'POST', url: `/api/history/${entry.id}/restore` })
    expect(res.statusCode).toBe(200)
    expect((await config()).labs).toEqual({ devices: true, companion: true })
  })

  it('leaves the secrets backend, privacy and consent records as they are now', async () => {
    // An old version written while the choices were different.
    const old = ConfigSchema.parse({
      ...CONFIG,
      secrets: { backend: 'keychain' },
      privacy: { claudeAccountUsage: true, showAccountEmail: true },
      marketplace: { installed: { 'old-widget': {
        version: '1.0.0', registry: 'official', installedAt: '2026-01-01T00:00:00.000Z',
        consentedPermissions: { subscriptions: [], commands: [], network: ['example.com'] },
      } } },
    })
    const history = new ConfigHistory(join(dir, 'history'))
    await history.recordChange(old, old, 'save')
    const [entry] = await history.list()

    app = await build()
    const before = await config()
    const res = await app.inject({ method: 'POST', url: `/api/history/${entry.id}/restore` })
    expect(res.statusCode).toBe(200)
    const after = await config()
    expect(after.secrets).toEqual(before.secrets)
    expect(after.privacy).toEqual(before.privacy)
    expect(after.marketplace.installed).toEqual(before.marketplace.installed)
    expect(after.marketplace.installed['old-widget']).toBeUndefined()
  })
})
