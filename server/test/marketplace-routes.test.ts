import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { marketplaceRoutes, usedBy } from '../src/marketplace/routes.js'
import { Registry } from '../src/marketplace/registry.js'
import { sha256 } from '../src/marketplace/install.js'
import { writeZip } from '../src/backup/zip.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'
import { ConfigStore } from '../src/config/store.js'
import { DEFAULT_CONFIG } from '../src/config/schema.js'
import { SDK_VERSION } from '../src/bridge/sdk.js'

const HOST = 'registry.example.com'
const INDEX_URL = `https://${HOST}/index.json`
const ZIP_URL = `https://${HOST}/widgets/demo-1.0.0.zip`

const MANIFEST = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'demo', name: { fr: 'Démo', en: 'Demo' }, version: '1.0.0', sdk: 1,
  minSize: [8, 4], defaultSize: [8, 4], ...over,
})

function packageOf(manifest: Record<string, unknown> = MANIFEST()): Buffer {
  return writeZip([
    { name: 'index.html', data: Buffer.from('<html>demo</html>') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
  ], new Date(Date.UTC(1980, 0, 1)))
}

function indexFor(zip: Buffer, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registry: 'fremkit-sietch', generatedAt: '2026-09-18T12:00:00.000Z', schema: 1,
    widgets: [{
      id: 'demo', version: '1.0.0', sdk: 1, name: 'Demo', description: 'D', icon: 'layout-grid',
      permissions: { subscriptions: ['system'], commands: [], network: [] }, connections: [],
      size: zip.byteLength, sha256: sha256(zip), url: ZIP_URL,
      publishedAt: '2026-09-18T12:00:00.000Z', previous: [],
      ...over,
    }],
  }
}

let dir: string
let app: FastifyInstance
let store: ConfigStore
let catalog: WidgetCatalog
let installedDir: string
let requested: string[]

interface Setup { zip?: Buffer; index?: Record<string, unknown>; offline?: boolean }

async function build(setup: Setup = {}): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-'))
  installedDir = join(dir, 'widgets')
  const builtins = join(dir, 'builtins')
  await mkdir(join(builtins, 'clock'), { recursive: true })
  await writeFile(join(builtins, 'clock', 'manifest.json'), JSON.stringify({ id: 'clock', name: 'Clock', version: '1.0.0', minSize: [8, 4], defaultSize: [8, 4] }))
  await writeFile(join(builtins, 'clock', 'index.html'), '<html></html>')

  const zip = setup.zip ?? packageOf()
  const index = setup.index ?? indexFor(zip)
  requested = []
  const registry = new Registry({
    url: INDEX_URL,
    isPrivate: async () => false,
    fetch: (async (url: string) => {
      requested.push(url)
      if (setup.offline) throw new Error('offline')
      if (url === INDEX_URL) return new Response(JSON.stringify(index))
      return new Response(new Uint8Array(zip))
    }) as never,
  })

  store = new ConfigStore(join(dir, 'fremkit.json'))
  await store.load()
  catalog = new WidgetCatalog(builtins, installedDir)
  await catalog.scan()
  app = Fastify()
  await app.register(marketplaceRoutes, { store, catalog, registry, installedDir })
}

beforeEach(() => build())
afterEach(async () => { await app?.close() })

const install = (payload: unknown, url = '/api/marketplace/install') =>
  app.inject({ method: 'POST', url, payload: payload as never })

/** The consent a client sends: the set its dialog rendered. */
const set = (over: Partial<{ subscriptions: string[]; commands: string[]; network: string[] }> = {}) =>
  ({ subscriptions: [], commands: [], network: [], ...over })

describe('GET /api/marketplace', () => {
  it('lists the index with what this machine makes of it', async () => {
    const res = await app.inject({ url: '/api/marketplace' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.registry).toBe('fremkit-sietch')
    expect(body.offline).toBe(false)
    expect(body.sdk).toBe(SDK_VERSION)
    const w = body.widgets[0]
    expect(w).toMatchObject({ id: 'demo', installed: false, installedVersion: null, updateAvailable: false, sdkTooNew: false, shadowsBuiltin: false })
    // Nothing granted yet, so everything the entry asks for is new.
    expect(w.consentNeeded).toBe(true)
    expect(w.newPermissions.subscriptions).toEqual(['system'])
  })

  it('says it is offline rather than answering an empty registry', async () => {
    await app.close()
    await build({ offline: true })
    const body = (await app.inject({ url: '/api/marketplace' })).json()
    expect(body.offline).toBe(true)
    expect(body.widgets).toEqual([])
  })

  it('flags an entry a built-in already owns, and one needing a newer SDK', async () => {
    await app.close()
    const zip = packageOf()
    await build({ zip, index: { ...indexFor(zip), widgets: [
      { ...(indexFor(zip).widgets as Record<string, unknown>[])[0], id: 'clock' },
      { ...(indexFor(zip).widgets as Record<string, unknown>[])[0], sdk: SDK_VERSION + 1 },
    ] } })
    const widgets = (await app.inject({ url: '/api/marketplace' })).json().widgets
    expect(widgets.find((w: { id: string }) => w.id === 'clock').shadowsBuiltin).toBe(true)
    expect(widgets.find((w: { id: string }) => w.id === 'demo').sdkTooNew).toBe(true)
  })
})

describe('POST /api/marketplace/refresh', () => {
  it('goes out again and answers 503 while the registry is unreachable', async () => {
    expect((await app.inject({ url: '/api/marketplace' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/marketplace' })).statusCode).toBe(200)
    // The second read came out of the cache; the refresh is what goes back out.
    expect(requested.filter((u) => u === INDEX_URL).length).toBe(1)
    const ok = await app.inject({ method: 'POST', url: '/api/marketplace/refresh' })
    expect(ok.statusCode).toBe(200)
    expect(requested.filter((u) => u === INDEX_URL).length).toBe(2)

    await app.close()
    await build({ offline: true })
    const down = await app.inject({ method: 'POST', url: '/api/marketplace/refresh' })
    expect(down.statusCode).toBe(503)
  })
})

describe('POST /api/marketplace/install', () => {
  it('asks for consent before doing anything, and names what is new', async () => {
    await app.close()
    const zip = packageOf(MANIFEST({ subscriptions: ['system'] }))
    await build({ zip, index: indexFor(zip) })
    const res = await install({ id: 'demo' })
    expect(res.statusCode).toBe(409)
    expect(res.json().newPermissions.subscriptions).toEqual(['system'])
    expect(res.json().errors[0]).toMatch(/permission/i)
    // Nothing was written: the answer is a question, not a half-install.
    await expect(readFile(join(installedDir, 'demo', 'index.html'))).rejects.toThrow()
  })

  it('installs with consent, records what was granted, and serves it from the catalogue', async () => {
    const res = await install({ id: 'demo', consent: set() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, id: 'demo', version: '1.0.0' })
    expect(await readFile(join(installedDir, 'demo', 'index.html'), 'utf8')).toBe('<html>demo</html>')
    expect(catalog.entry('demo')?.source).toBe('installed')
    const record = store.get().marketplace.installed.demo
    expect(record).toMatchObject({ version: '1.0.0', registry: 'fremkit-sietch' })
    // The manifest in the package asks for nothing; the *index entry* advertised `system`. The
    // record follows the package, because only one of the two was hashed.
    expect(record.consentedPermissions).toEqual({ subscriptions: [], commands: [], network: [] })
  })

  it('refuses an id a built-in already owns', async () => {
    const res = await install({ id: 'clock', consent: set() })
    expect(res.statusCode).toBe(409)
    expect(res.json().errors[0]).toMatch(/built-in|intégré/)
  })

  it('refuses a widget the index does not hold, and a version it no longer offers', async () => {
    expect((await install({ id: 'ghost', consent: set() })).statusCode).toBe(404)
    expect((await install({ id: 'demo', version: '0.1.0', consent: set() })).statusCode).toBe(404)
  })

  it('refuses a package whose bytes are not the ones the index named', async () => {
    await app.close()
    // The index describes one package; the server serves another.
    const advertised = packageOf()
    await build({ zip: packageOf(MANIFEST({ version: '9.9.9' })), index: indexFor(advertised) })
    const res = await install({ id: 'demo', consent: set() })
    expect(res.statusCode).toBe(422)
    expect(res.json().errors[0]).toMatch(/index/i)
  })

  it('refuses a package asking for an SDK this build does not have', async () => {
    await app.close()
    const zip = packageOf(MANIFEST({ sdk: SDK_VERSION + 1 }))
    await build({ zip, index: indexFor(zip, { sdk: SDK_VERSION + 1 }) })
    expect((await install({ id: 'demo', consent: set() })).statusCode).toBe(409)
  })

  it('refuses a cross-site fetch, even one that never reads the answer', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/marketplace/install',
      headers: { 'sec-fetch-site': 'cross-site' }, payload: { id: 'demo', consent: set() } as never,
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a body it cannot read', async () => {
    expect((await install({ id: 'Not An Id' })).statusCode).toBe(400)
    expect((await install({})).statusCode).toBe(400)
  })

  it('answers 503 while the registry is unreachable, rather than a broken install', async () => {
    await app.close()
    await build({ offline: true })
    expect((await install({ id: 'demo', consent: set() })).statusCode).toBe(503)
  })
})

describe('POST /api/marketplace/update', () => {
  it('refuses to update something that is not installed', async () => {
    expect((await install({ id: 'demo', consent: set() }, '/api/marketplace/update')).statusCode).toBe(409)
  })

  it('goes through without a dialog when the new version asks for nothing new', async () => {
    await install({ id: 'demo', consent: set() })
    await app.close()
    const zip = packageOf(MANIFEST({ version: '1.1.0' }))
    const older = store.get()
    await build({ zip, index: indexFor(zip, { version: '1.1.0' }) })
    await store.save(older)
    await catalog.scan()
    const res = await install({ id: 'demo' }, '/api/marketplace/update')
    expect(res.statusCode).toBe(200)
    expect(store.get().marketplace.installed.demo.version).toBe('1.1.0')
  })

  it('asks again when the new version asks for more', async () => {
    await install({ id: 'demo', consent: set() })
    await app.close()
    const zip = packageOf(MANIFEST({ version: '1.1.0', subscriptions: ['system'] }))
    const older = store.get()
    await build({ zip, index: indexFor(zip, { version: '1.1.0' }) })
    await store.save(older)
    await catalog.scan()
    const asked = await install({ id: 'demo' }, '/api/marketplace/update')
    expect(asked.statusCode).toBe(409)
    expect(asked.json().newPermissions.subscriptions).toEqual(['system'])
    expect(store.get().marketplace.installed.demo.version).toBe('1.0.0')

    // The consent has to *be* the set the dialog showed: an empty one grants nothing.
    const accepted = await install({ id: 'demo', consent: set({ subscriptions: ['system'] }) }, '/api/marketplace/update')
    expect(accepted.statusCode).toBe(200)
    expect(store.get().marketplace.installed.demo.consentedPermissions.subscriptions).toEqual(['system'])
  })
})

describe('the consent is what the user was shown', () => {
  it('refuses a package asking for more than the index advertised', async () => {
    // The dialog is drawn from the index entry; the record used to be written from the package
    // manifest, and only the package is hashed. A registry could advertise one permission and
    // ship a zip asking for three.
    await app.close()
    const zip = packageOf(MANIFEST({ subscriptions: ['system', 'homey:*'], permissions: { network: ['evil.example'] } }))
    await build({ zip, index: indexFor(zip) })

    const res = await install({ id: 'demo', consent: set({ subscriptions: ['system'] }) })
    expect(res.statusCode).toBe(409)
    // The difference reported is the one against the *grant*, which is empty on a first
    // install — so the dialog reopens on the package's whole real ask, not on the delta from
    // the entry that lied about it.
    expect(res.json().newPermissions.subscriptions).toEqual(['system', 'homey:*'])
    expect(res.json().newPermissions.network).toEqual(['evil.example'])
    // Nothing granted, nothing written.
    expect(store.get().marketplace.installed.demo).toBeUndefined()
    await expect(readFile(join(installedDir, 'demo', 'index.html'))).rejects.toThrow()
  })

  it('installs when the set that was shown covers what the package asks', async () => {
    await app.close()
    const zip = packageOf(MANIFEST({ subscriptions: ['system'] }))
    await build({ zip, index: indexFor(zip) })
    const res = await install({ id: 'demo', consent: set({ subscriptions: ['system'] }) })
    expect(res.statusCode).toBe(200)
    expect(store.get().marketplace.installed.demo.consentedPermissions.subscriptions).toEqual(['system'])
  })

  it('records the package\'s ask, not the set that was shown', async () => {
    // A dialog that showed more than the package needs must not grant the excess.
    await app.close()
    const zip = packageOf(MANIFEST({ subscriptions: ['system'] }))
    await build({ zip, index: indexFor(zip) })
    await install({ id: 'demo', consent: set({ subscriptions: ['system', 'clipboard'], commands: ['volume'] }) })
    expect(store.get().marketplace.installed.demo.consentedPermissions)
      .toEqual({ subscriptions: ['system'], commands: [], network: [] })
  })

  it('refuses a body whose consent is not a permission set', async () => {
    // `true` used to mean "a dialog was answered". It says nothing about what was in it.
    expect((await install({ id: 'demo', consent: true })).statusCode).toBe(400)
    expect((await install({ id: 'demo', consent: { subscriptions: 'system' } })).statusCode).toBe(400)
  })

  it('does not pre-approve a reinstall from a record whose folder is gone', async () => {
    await app.close()
    const zip = packageOf(MANIFEST({ subscriptions: ['system'] }))
    await build({ zip, index: indexFor(zip) })
    await install({ id: 'demo', consent: set({ subscriptions: ['system'] }) })
    // The folder removed by hand, or a config restored without its widgets: the record is stale.
    await rm(join(installedDir, 'demo'), { recursive: true, force: true })
    await catalog.scan()
    const again = await install({ id: 'demo' })
    expect(again.statusCode).toBe(409)
    expect(again.json().newPermissions.subscriptions).toEqual(['system'])
  })

  it('refuses a package whose version is not the one the index sent us to', async () => {
    // Otherwise the record says 9.9.9 and `updateAvailable` is false for ever.
    await app.close()
    const zip = packageOf(MANIFEST({ version: '9.9.9' }))
    await build({ zip, index: indexFor(zip, { version: '1.0.0' }) })
    const res = await install({ id: 'demo', consent: set() })
    expect(res.statusCode).toBe(422)
    expect(store.get().marketplace.installed.demo).toBeUndefined()
  })
})

describe('POST /api/marketplace/uninstall', () => {
  const uninstall = (payload: unknown) => app.inject({ method: 'POST', url: '/api/marketplace/uninstall', payload: payload as never })

  it('removes the folder and the record', async () => {
    await install({ id: 'demo', consent: set() })
    const res = await uninstall({ id: 'demo' })
    expect(res.statusCode).toBe(200)
    expect(catalog.entry('demo')).toBeUndefined()
    expect(store.get().marketplace.installed.demo).toBeUndefined()
    await expect(readFile(join(installedDir, 'demo', 'index.html'))).rejects.toThrow()
  })

  it('refuses while the widget is still placed, and says where', async () => {
    await install({ id: 'demo', consent: set() })
    await store.update((c) => ({
      ...c,
      pages: [{ ...c.pages[0], widgets: [...c.pages[0].widgets, { instanceId: 'demo-1', widgetId: 'demo', x: 0, y: 8, w: 8, h: 4, showTitle: true, settings: {} }] }],
    }))
    const res = await uninstall({ id: 'demo' })
    expect(res.statusCode).toBe(409)
    expect(res.json().places).toEqual([store.get().pages[0].name])
    expect(catalog.entry('demo')?.source).toBe('installed')
  })

  it('refuses one that is not installed', async () => {
    expect((await uninstall({ id: 'demo' })).statusCode).toBe(404)
    expect((await uninstall({ id: 'clock' })).statusCode).toBe(404)
  })
})

describe('usedBy', () => {
  it('names the pages and the bar a widget is still placed on', () => {
    const config = {
      ...DEFAULT_CONFIG,
      display: { ...DEFAULT_CONFIG.display, navWidgets: [{ instanceId: 'n1', widgetId: 'demo', slot: 'left' as const, settings: {} }] },
      pages: [
        { id: 'a', name: 'Accueil', widgets: [{ instanceId: 'x', widgetId: 'demo', x: 0, y: 0, w: 8, h: 4, showTitle: true, settings: {} }] },
        { id: 'b', name: 'Travail', widgets: [] },
      ],
    }
    expect(usedBy(config, 'demo')).toEqual(['Accueil', expect.any(String)])
    expect(usedBy(config, 'clock')).toEqual([])
  })
})
