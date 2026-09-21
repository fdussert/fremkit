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
import { ThemeCatalog } from '../src/themes/catalog.js'
import { ConnCache } from '../src/proxy/conn.js'
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
let themes: ThemeCatalog
let builtinThemesDir: string
let installedThemesDir: string
let installedDir: string
let requested: string[]
let connCache: ConnCache

interface Setup {
  zip?: Buffer
  index?: Record<string, unknown>
  offline?: boolean
  themeZip?: Buffer
  /** Per-widget packages, by id, when one zip for every URL is not enough. */
  zips?: Record<string, Buffer>
}

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
  connCache = new ConnCache()
  const registry = new Registry({
    url: INDEX_URL,
    isPrivate: async () => false,
    fetch: (async (url: string) => {
      requested.push(url)
      if (setup.offline) throw new Error('offline')
      if (url === INDEX_URL) return new Response(JSON.stringify(index))
      if (setup.themeZip && url.includes('/themes/')) return new Response(new Uint8Array(setup.themeZip))
      const named = /\/widgets\/([a-z0-9-]+)-/.exec(url)?.[1]
      if (named && setup.zips?.[named]) return new Response(new Uint8Array(setup.zips[named]))
      return new Response(new Uint8Array(zip))
    }) as never,
  })

  store = new ConfigStore(join(dir, 'fremkit.json'))
  await store.load()
  catalog = new WidgetCatalog(builtins, installedDir)
  builtinThemesDir = join(dir, 'builtin-themes')
  installedThemesDir = join(dir, 'themes')
  await mkdir(join(builtinThemesDir, 'fremkit'), { recursive: true })
  await writeFile(join(builtinThemesDir, 'fremkit', 'theme.json'), JSON.stringify({ id: 'fremkit', name: 'Fremkit', version: '1.0.0', tokens: {} }))
  themes = new ThemeCatalog(builtinThemesDir, installedThemesDir)
  await themes.scan()
  await catalog.scan()
  app = Fastify()
  await app.register(marketplaceRoutes, { store, catalog, themes, registry, installedDir, installedThemesDir, connCache })
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

  it('passes the category straight through, so the panel can shelve it', async () => {
    await app.close()
    const zip = packageOf()
    await build({ zip, index: { ...indexFor(zip), widgets: [
      { ...(indexFor(zip).widgets as Record<string, unknown>[])[0], category: 'home' },
    ] } })
    expect((await app.inject({ url: '/api/marketplace' })).json().widgets[0].category).toBe('home')
  })

  it('passes the changelog entry through, and builds the history from it', async () => {
    // Somebody two versions behind is being asked to accept both; showing only the newer one
    // makes an update read as smaller than it is.
    await app.close()
    const zip = packageOf()
    await build({ zip, index: { ...indexFor(zip), widgets: [{
      ...(indexFor(zip).widgets as Record<string, unknown>[])[0],
      version: '1.2.0',
      changes: 'Newest.',
      previous: [
        { version: '1.1.0', url: `https://${HOST}/widgets/demo-1.1.0.zip`, sha256: sha256(zip), size: zip.byteLength, changes: 'Middle.' },
        { version: '1.0.0', url: `https://${HOST}/widgets/demo-1.0.0.zip`, sha256: sha256(zip), size: zip.byteLength },
      ],
    }] } })
    const row = (await app.inject({ url: '/api/marketplace' })).json().widgets[0]
    expect(row.changes).toBe('Newest.')
    // Newest first, and the version nobody wrote anything about is left out rather than shown
    // as a blank line.
    expect(row.history).toEqual([
      { version: '1.2.0', changes: 'Newest.' },
      { version: '1.1.0', changes: 'Middle.' },
    ])
  })

  it('answers an empty history for a package that documented nothing', async () => {
    const row = (await app.inject({ url: '/api/marketplace' })).json().widgets[0]
    expect(row.changes).toBeUndefined()
    expect(row.history).toEqual([])
  })

  it('names the pages a widget is placed on, installed or not', async () => {
    // The whole point of the field: a dashboard built before a widget moved to the registry has
    // a tile of it, painted as missing, and this is what lets the admin offer the install.
    await store.update((config) => ({
      ...config,
      pages: [{ id: 'a', name: 'Accueil', widgets: [
        { instanceId: 'x', widgetId: 'demo', x: 0, y: 0, w: 8, h: 4, showTitle: true, settings: {} },
      ] }],
    }))
    const w = (await app.inject({ url: '/api/marketplace' })).json().widgets[0]
    expect(w.installed).toBe(false)
    expect(w.placedOn).toEqual(['Accueil'])
  })

  it('leaves it empty for a widget nothing places', async () => {
    const w = (await app.inject({ url: '/api/marketplace' })).json().widgets[0]
    expect(w.placedOn).toEqual([])
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

describe('GET /api/marketplace', () => {
  it('refuses a cross-site read, which would make the server go out onto the network', async () => {
    const res = await app.inject({ url: '/api/marketplace', headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.statusCode).toBe(403)
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

  it('says so even when it has a cached index to fall back on', async () => {
    // The fallback is right for a background read and wrong for a refresh: answering 200 with
    // the index it already had would say "read again, all fine" while nothing was read.
    let down = false
    const zip = packageOf()
    const index = indexFor(zip)
    const registry = new Registry({
      url: INDEX_URL, isPrivate: async () => false,
      fetch: (async () => {
        if (down) throw new Error('offline')
        return new Response(JSON.stringify(index))
      }) as never,
    })
    const one = Fastify()
    await one.register(marketplaceRoutes, { store, catalog, themes, registry, installedDir, installedThemesDir, connCache })
    expect((await one.inject({ url: '/api/marketplace' })).json().widgets).toHaveLength(1)

    down = true
    const refused = await one.inject({ method: 'POST', url: '/api/marketplace/refresh' })
    expect(refused.statusCode).toBe(503)
    // And the listing still shows what it last knew — the cache is not stale yet, so this one
    // does not even go out; either way the user is not shown an empty registry.
    const listing = (await one.inject({ url: '/api/marketplace' })).json()
    expect(listing.widgets).toHaveLength(1)
    await one.close()
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

  it('refuses an id a *broken* built-in owns, which has no catalogue entry at all', async () => {
    // A built-in whose manifest fails to parse used to free its id: the installed widget took
    // the name, and the next time the built-in was fixed two folders claimed it.
    await app.close()
    const zip = packageOf(MANIFEST({ id: 'broken' }))
    await build({ zip, index: indexFor(zip, { id: 'broken' }) })
    const folder = join(dir, 'builtins', 'broken')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'manifest.json'), '{ not json')
    await writeFile(join(folder, 'index.html'), '<html></html>')
    await catalog.scan()
    expect(catalog.entry('broken')).toBeUndefined()
    expect(catalog.errors.map((e) => e.id)).toContain('broken')

    const res = await install({ id: 'broken', consent: set() })
    expect(res.statusCode).toBe(409)
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

  it('refuses a second install of the same widget while the first is running', async () => {
    // Both would stage and both would rename, and which version survived would depend on the
    // order two renames happened to land in.
    await app.close()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let downloading!: () => void
    const reached = new Promise<void>((r) => { downloading = r })
    const zip = packageOf()
    const index = indexFor(zip)
    dir = await mkdtemp(join(tmpdir(), 'marketplace-'))
    installedDir = join(dir, 'widgets')
    const builtins = join(dir, 'builtins')
    await mkdir(builtins, { recursive: true })
    const registry = new Registry({
      url: INDEX_URL, isPrivate: async () => false,
      fetch: (async (url: string) => {
        if (url === INDEX_URL) return new Response(JSON.stringify(index))
        downloading()
        await gate
        return new Response(new Uint8Array(zip))
      }) as never,
    })
    store = new ConfigStore(join(dir, 'fremkit.json'))
    await store.load()
    catalog = new WidgetCatalog(builtins, installedDir)
  builtinThemesDir = join(dir, 'builtin-themes')
  installedThemesDir = join(dir, 'themes')
  await mkdir(join(builtinThemesDir, 'fremkit'), { recursive: true })
  await writeFile(join(builtinThemesDir, 'fremkit', 'theme.json'), JSON.stringify({ id: 'fremkit', name: 'Fremkit', version: '1.0.0', tokens: {} }))
  themes = new ThemeCatalog(builtinThemesDir, installedThemesDir)
  await themes.scan()
    await catalog.scan()
    app = Fastify()
    await app.register(marketplaceRoutes, { store, catalog, themes, registry, installedDir, installedThemesDir, connCache })

    const first = install({ id: 'demo', consent: set() })
    // Not a tick: the lock is taken when the route body runs, which is after Fastify has
    // routed the request. Waiting for the download to start is waiting for exactly that.
    await reached
    const second = await install({ id: 'demo', consent: set() })
    expect(second.statusCode).toBe(409)
    release()
    expect((await first).statusCode).toBe(200)
    // And the lock is released: a later one goes through.
    expect((await install({ id: 'demo', consent: set() })).statusCode).toBe(200)
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

describe('POST /api/marketplace/update-all', () => {
  const updateAll = (consent: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/marketplace/update-all', payload: { consent } as never })

  /**
   * Three installed widgets, each with a newer release waiting, and the registry serving what the
   * scenario needs: `good` updates, `liar` ships a package the index's hash does not describe,
   * `greedy` asks for a permission the consent will not cover.
   */
  async function threeWaiting(): Promise<void> {
    await app.close()
    dir = await mkdtemp(join(tmpdir(), 'marketplace-'))
    installedDir = join(dir, 'widgets')
    const builtins = join(dir, 'builtins')
    await mkdir(builtins, { recursive: true })

    const ONE = (id: string, over: Record<string, unknown> = {}) =>
      packageOf({ ...MANIFEST({ id, version: '1.0.0' }), ...over })
    const TWO = (id: string, over: Record<string, unknown> = {}) =>
      packageOf({ ...MANIFEST({ id, version: '2.0.0' }), ...over })

    const v1 = { good: ONE('good'), liar: ONE('liar'), greedy: ONE('greedy') }
    const v2 = { good: TWO('good'), liar: TWO('liar'), greedy: TWO('greedy', { subscriptions: ['system'] }) }

    const entry = (id: string, version: string, zip: Buffer): Record<string, unknown> => ({
      id, version, sdk: 1, name: id, description: 'D', icon: 'layout-grid',
      permissions: { subscriptions: [], commands: [], network: [] }, connections: [],
      size: zip.byteLength, sha256: sha256(zip), url: `https://${HOST}/widgets/${id}-${version}.zip`,
      publishedAt: '2026-09-18T12:00:00.000Z', previous: [],
    })

    let serving: 'v1' | 'v2' = 'v1'
    const registry = new Registry({
      url: INDEX_URL, isPrivate: async () => false,
      fetch: (async (url: string) => {
        if (url === INDEX_URL) {
          const set = serving === 'v1' ? v1 : v2
          const version = serving === 'v1' ? '1.0.0' : '2.0.0'
          return new Response(JSON.stringify({
            registry: 'fremkit-sietch', generatedAt: '2026-09-18T12:00:00.000Z', schema: 1,
            widgets: (['good', 'liar', 'greedy'] as const).map((id) => entry(id, version, set[id])),
          }))
        }
        const id = /widgets\/([a-z]+)-/.exec(url)?.[1] as keyof typeof v1
        // `liar` serves its *old* bytes at the new URL, so the hash will not match.
        if (serving === 'v2' && id === 'liar') return new Response(new Uint8Array(v1.liar))
        return new Response(new Uint8Array((serving === 'v1' ? v1 : v2)[id]))
      }) as never,
    })

    store = new ConfigStore(join(dir, 'fremkit.json'))
    await store.load()
    catalog = new WidgetCatalog(builtins, installedDir)
  builtinThemesDir = join(dir, 'builtin-themes')
  installedThemesDir = join(dir, 'themes')
  await mkdir(join(builtinThemesDir, 'fremkit'), { recursive: true })
  await writeFile(join(builtinThemesDir, 'fremkit', 'theme.json'), JSON.stringify({ id: 'fremkit', name: 'Fremkit', version: '1.0.0', tokens: {} }))
  themes = new ThemeCatalog(builtinThemesDir, installedThemesDir)
  await themes.scan()
    await catalog.scan()
    app = Fastify()
    await app.register(marketplaceRoutes, { store, catalog, themes, registry, installedDir, installedThemesDir, connCache })

    for (const id of ['good', 'liar', 'greedy']) {
      const res = await app.inject({ method: 'POST', url: '/api/marketplace/install', payload: { id, consent: set() } as never })
      expect(res.statusCode, id).toBe(200)
    }
    serving = 'v2'
    await app.inject({ method: 'POST', url: '/api/marketplace/refresh' })
  }

  it('answers one result per waiting widget and never stops on a failure', async () => {
    await threeWaiting()
    const res = await updateAll({ good: set(), liar: set(), greedy: set() })
    expect(res.statusCode).toBe(200)
    const results = res.json().results as { id: string; ok: boolean; error?: string; newPermissions?: { subscriptions: string[] } }[]
    expect(results.map((r) => r.id).sort()).toEqual(['good', 'greedy', 'liar'])

    const byId = Object.fromEntries(results.map((r) => [r.id, r]))
    expect(byId.good.ok).toBe(true)
    expect(byId.liar.ok).toBe(false)
    expect(byId.greedy.ok).toBe(false)
    expect(byId.greedy.newPermissions?.subscriptions).toEqual(['system'])

    // One record written: the other two are untouched at the version they were.
    const installed = store.get().marketplace.installed
    expect(installed.good.version).toBe('2.0.0')
    expect(installed.liar.version).toBe('1.0.0')
    expect(installed.greedy.version).toBe('1.0.0')
  })

  it('updates the one whose consent was given, in the same run', async () => {
    await threeWaiting()
    const res = await updateAll({ good: set(), greedy: set({ subscriptions: ['system'] }) })
    const byId = Object.fromEntries((res.json().results as { id: string; ok: boolean }[]).map((r) => [r.id, r]))
    expect(byId.greedy.ok).toBe(true)
    expect(store.get().marketplace.installed.greedy.consentedPermissions.subscriptions).toEqual(['system'])
  })

  it('answers nothing to update when nothing is waiting', async () => {
    const res = await updateAll()
    expect(res.statusCode).toBe(200)
    expect(res.json().results).toEqual([])
  })

  it('ignores a widget the caller lists but the server does not think is waiting', async () => {
    // The server decides what is out of date. A client naming something else is asking for an
    // install, and this is not the route for that.
    await install({ id: 'demo', consent: set() })
    const res = await updateAll({ demo: set(), ghost: set() })
    expect(res.json().results).toEqual([])
  })

  it('refuses a cross-site fetch and a body it cannot read', async () => {
    const cross = await app.inject({
      method: 'POST', url: '/api/marketplace/update-all',
      headers: { 'sec-fetch-site': 'cross-site' }, payload: { consent: {} } as never,
    })
    expect(cross.statusCode).toBe(403)
    const bad = await app.inject({ method: 'POST', url: '/api/marketplace/update-all', payload: { consent: { demo: 'yes' } } as never })
    expect(bad.statusCode).toBe(400)
  })

  it('answers 503 while the registry is unreachable', async () => {
    await app.close()
    await build({ offline: true })
    expect((await updateAll()).statusCode).toBe(503)
  })
})

describe('POST /api/marketplace/install-missing', () => {
  const installMissing = (consent: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/marketplace/install-missing', payload: { consent } as never })

  /** Puts a tile of `demo` on a page, which is what makes it missing rather than merely absent. */
  const place = (id: string) => store.update((config) => ({
    ...config,
    pages: [{ id: 'a', name: 'Accueil', widgets: [
      { instanceId: 'x', widgetId: id, x: 0, y: 0, w: 8, h: 4, showTitle: true, settings: {} },
    ] }],
  }))

  it('installs what a screen places and this machine does not have', async () => {
    await place('demo')
    const res = await installMissing({ demo: set({ subscriptions: ['system'] }) })
    expect(res.statusCode).toBe(200)
    expect(res.json().results).toEqual([{ id: 'demo', ok: true, version: '1.0.0' }])
    expect(await readFile(join(installedDir, 'demo', 'manifest.json'), 'utf8')).toContain('demo')
  })

  it('does nothing for a widget nothing places', async () => {
    const res = await installMissing({ demo: set({ subscriptions: ['system'] }) })
    expect(res.json().results).toEqual([])
  })

  it('leaves an already-installed widget alone, however many screens place it', async () => {
    await place('demo')
    await installMissing({ demo: set({ subscriptions: ['system'] }) })
    // The second run has nothing to do: what is missing is the server's answer about its own
    // catalogue, not a list the caller sent.
    const again = await installMissing({ demo: set({ subscriptions: ['system'] }) })
    expect(again.json().results).toEqual([])
  })

  it('refuses a widget whose consent was not the one shown, and says what it asks', async () => {
    // The package has to *ask* for something: the consent is checked against the manifest inside
    // the zip, never against the index entry that advertised it.
    await app.close()
    await build({ zip: packageOf(MANIFEST({ subscriptions: ['system'] })) })
    await place('demo')
    const res = await installMissing({})
    const [result] = res.json().results as { ok: boolean; newPermissions?: { subscriptions: string[] } }[]
    expect(result.ok).toBe(false)
    expect(result.newPermissions?.subscriptions).toEqual(['system'])
  })

  it('leaves out a widget that needs a newer Fremkit', async () => {
    // The panel does not list it in the dialog, so a result for it would name something the user
    // never saw and could do nothing about. "Update Fremkit" is already said on its own row.
    await app.close()
    const zip = packageOf()
    await build({ zip, index: { ...indexFor(zip), widgets: [
      { ...(indexFor(zip).widgets as Record<string, unknown>[])[0], sdk: SDK_VERSION + 1 },
    ] } })
    await place('demo')
    expect((await installMissing({ demo: set({ subscriptions: ['system'] }) })).json().results).toEqual([])
  })

  it('keeps a widget and a theme of the same id from sharing one record', async () => {
    // `marketplace.installed` is one map keyed by id. The two live in different folders and
    // neither shadows the other, so the name is allowed — the record is not, because it holds a
    // version and a grant.
    const zip = packageOf()
    await build({ zip, index: { ...indexFor(zip), themes: [] } })
    expect((await install({ id: 'demo', consent: set({ subscriptions: ['system'] }) })).statusCode).toBe(200)

    const themeJson = writeZip(
      [{ name: 'theme.json', data: Buffer.from(JSON.stringify({ id: 'demo', name: { fr: 'D', en: 'D' }, version: '1.0.0', tokens: {} })) }],
      new Date(Date.UTC(1980, 0, 1)),
    )
    await app.close()
    await build({
      zip,
      index: { ...indexFor(zip), themes: [{
        id: 'demo', version: '1.0.0', name: { fr: 'D', en: 'D' }, description: { fr: 'd', en: 'd' },
        tokens: { accent: '#fff', bg: '#000', surface: '#111', text: '#eee' },
        size: themeJson.byteLength, sha256: sha256(themeJson), url: `https://${HOST}/themes/demo-1.0.0.zip`,
        publishedAt: '2026-09-18T12:00:00.000Z', previous: [],
      }] },
      themeZip: themeJson,
    })
    await store.update((c) => ({ ...c, marketplace: { installed: { demo: {
      kind: 'widget' as const, sharedConnections: [], version: '1.0.0', registry: 'fremkit-sietch',
      consentedPermissions: { subscriptions: ['system'], commands: [], network: [] },
      installedAt: '2026-09-18T12:00:00.000Z',
    } } } }))

    const asTheme = await app.inject({ method: 'POST', url: '/api/marketplace/install', payload: { id: 'demo', kind: 'theme' } as never })
    expect(asTheme.statusCode).toBe(409)
    expect(asTheme.json().errors[0]).toMatch(/widget/i)

    // And the listing does not lend the widget's version to the theme.
    const body = (await app.inject({ url: '/api/marketplace' })).json()
    expect(body.themes[0]).toMatchObject({ id: 'demo', installed: false, installedVersion: null })
  })

  it('refuses a cross-site call and a malformed body', async () => {
    const cross = await app.inject({
      method: 'POST', url: '/api/marketplace/install-missing',
      headers: { 'sec-fetch-site': 'cross-site' }, payload: { consent: {} } as never,
    })
    expect(cross.statusCode).toBe(403)
    const bad = await app.inject({ method: 'POST', url: '/api/marketplace/install-missing', payload: { consent: { demo: 'yes' } } as never })
    expect(bad.statusCode).toBe(400)
  })

  it('answers 503 while the registry is unreachable', async () => {
    await app.close()
    await build({ offline: true })
    expect((await installMissing()).statusCode).toBe(503)
  })
})

describe('installing a widget that declares a connection', () => {
  const DECL = {
    name: 'Key Light', kind: 'host', scheme: 'http',
    fields: [{ key: 'host', label: { fr: 'Adresse', en: 'Address' } }],
    requests: [{ method: 'GET', path: '/elgato/lights' }],
  }

  async function withDecl(): Promise<void> {
    await app.close()
    const zip = packageOf({ ...MANIFEST(), connection: DECL })
    await build({
      zip,
      index: { ...indexFor(zip), widgets: [{
        ...(indexFor(zip).widgets as Record<string, unknown>[])[0],
        permissions: { subscriptions: [], commands: [], network: [], connection: DECL },
      }] },
    })
  }

  it('accepts the declaration the dialog rendered, rather than dropping it and asking again', async () => {
    // Found on a bench server: the consent body's schema had no `connection`, so the server
    // threw away the one part of the set the user had just agreed to, found it new again
    // against the package, and answered 409 for ever. The dialog reopened on the same text.
    await withDecl()
    const res = await install({ id: 'demo', consent: { ...set(), connection: DECL } })
    expect(res.statusCode).toBe(200)
    expect(store.get().marketplace.installed.demo.consentedPermissions.connection)
      .toMatchObject({ kind: 'host', scheme: 'http' })
  })

  it('still refuses when the package declares something the dialog did not show', async () => {
    await withDecl()
    const narrower = { ...DECL, requests: [{ method: 'GET', path: '/elgato/accessory-info' }] }
    const res = await install({ id: 'demo', consent: { ...set(), connection: narrower } })
    expect(res.statusCode).toBe(409)
    expect(res.json().newPermissions.connection).toBeDefined()
  })

  it('refuses a consent whose declaration the schema would not accept', async () => {
    await withDecl()
    const res = await install({ id: 'demo', consent: { ...set(), connection: { ...DECL, kind: 'nonsense' } } })
    expect(res.statusCode).toBe(400)
  })
})

describe('a listing whose declaration changed since it was granted', () => {
  const DECL = {
    name: 'Key Light', kind: 'host', scheme: 'http',
    fields: [{ key: 'host', label: { fr: 'Adresse', en: 'Address' } }],
    requests: [{ method: 'GET', path: '/elgato/lights' }],
  }
  const WIDER = { ...DECL, requests: [...DECL.requests, { method: 'POST', path: '/api/admin/**' }] }

  /**
   * The widget installed and its folder in place, the index advertising `advertised`, and the
   * *record* granting `DECL` — which is the shape of every update that changed its declaration.
   *
   * Installed against the advertised version so the folder is really there, then the grant is
   * narrowed back: rebuilding would give a fresh temp directory and take the folder with it.
   */
  async function installedThenChanged(advertised: Record<string, unknown>): Promise<void> {
    const zip = packageOf({ ...MANIFEST(), connection: advertised })
    await build({ zip, index: { ...indexFor(zip), widgets: [{
      ...(indexFor(zip).widgets as Record<string, unknown>[])[0],
      permissions: { subscriptions: [], commands: [], network: [], connection: advertised },
    }] } })
    expect((await install({ id: 'demo', consent: { ...set(), connection: advertised } })).statusCode).toBe(200)

    await store.update((c) => ({ ...c, marketplace: { installed: { demo: {
      ...c.marketplace.installed.demo,
      consentedPermissions: { subscriptions: [], commands: [], network: [], connection: DECL },
    } } } }))
  }

  it('says so in the listing, so a bulk dialog has something to render', async () => {
    // Without this every bulk path granted a changed declaration unseen: they build their
    // dialog from `newPermissions` and send the entry's own permissions.
    await installedThenChanged(WIDER)
    const row = (await app.inject({ url: '/api/marketplace' })).json().widgets[0]
    expect(row.consentNeeded).toBe(true)
    expect(row.newPermissions.connection).toMatchObject({ kind: 'host' })
    expect(row.newPermissions.connection.requests).toHaveLength(2)
  })

  it('says nothing when the declaration is the one that was granted', async () => {
    await installedThenChanged(DECL)
    const row = (await app.inject({ url: '/api/marketplace' })).json().widgets[0]
    expect(row.consentNeeded).toBe(false)
    expect(row.newPermissions.connection).toBeUndefined()
  })

  it('notices a scheme flipped to http, which is the quiet one', async () => {
    await installedThenChanged({ ...DECL, scheme: 'https' })
    const row = (await app.inject({ url: '/api/marketplace' })).json().widgets[0]
    expect(row.consentNeeded).toBe(true)
  })

  it('refuses a bulk consent that leaves the declaration out', async () => {
    // What "update all" would send if it built its consent from a set with no connection in it.
    await installedThenChanged(WIDER)
    // The record is put a version behind, so the entry counts as an update and the series
    // actually reaches this widget.
    await store.update((c) => ({
      ...c,
      marketplace: { installed: { demo: { ...c.marketplace.installed.demo, version: '0.9.0' } } },
    }))
    const res = await app.inject({
      method: 'POST', url: '/api/marketplace/update-all',
      payload: { consent: { demo: set() } } as never,
    })
    expect(res.statusCode).toBe(200)
    const [result] = res.json().results as { ok: boolean; newPermissions?: { connection?: unknown } }[]
    expect(result.ok).toBe(false)
    expect(result.newPermissions?.connection).toBeDefined()
  })
})

describe('POST /api/marketplace/share', () => {
  const share = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/marketplace/share', payload: body as never })

  const BEARER = {
    // Not `Homey`: that is a coded type's id, and a declaration may not wear one as its label.
    name: 'Homey Flows', kind: 'http-bearer', scheme: 'http',
    fields: [{ key: 'host', label: 'A' }, { key: 'token', label: 'K', secret: true }],
    requests: [{ method: 'GET', path: '/a' }],
  }
  const QUERY = {
    name: 'Homey Flows', kind: 'api-key-query', queryName: 'apikey', scheme: 'http',
    fields: [{ key: 'host', label: 'A' }, { key: 'token', label: 'K', secret: true }],
    requests: [{ method: 'GET', path: '/a' }],
  }

  /**
   * Two installed widgets: `owner` declares the connection, `demo` wants to share it.
   *
   * Both really installed, because the check compares the two *granted* declarations — an owner
   * that is not installed has none, and there would be nothing to compare against.
   */
  async function installed(demoDecl: Record<string, unknown> = BEARER): Promise<void> {
    await app.close()
    const demoZip = packageOf({ ...MANIFEST(), connection: demoDecl })
    const ownerZip = packageOf({ ...MANIFEST({ id: 'owner' }), connection: BEARER })
    const entry = (id: string, connection: unknown) => ({
      ...(indexFor(demoZip).widgets as Record<string, unknown>[])[0],
      id,
      url: `https://${HOST}/widgets/${id}-1.0.0.zip`,
      sha256: sha256(id === 'demo' ? demoZip : ownerZip),
      size: (id === 'demo' ? demoZip : ownerZip).byteLength,
      permissions: { subscriptions: [], commands: [], network: [], connection },
    })
    await build({
      zip: demoZip,
      zips: { demo: demoZip, owner: ownerZip },
      index: { ...indexFor(demoZip), widgets: [entry('demo', demoDecl), entry('owner', BEARER)] },
    })
    expect((await install({ id: 'demo', consent: { ...set(), connection: demoDecl } })).statusCode).toBe(200)
    expect((await install({ id: 'owner', consent: { ...set(), connection: BEARER } })).statusCode).toBe(200)

    await store.update((c) => ({
      ...c,
      connections: [
        { id: 'homey-x1', type: 'decl:owner:homey-flows', name: 'Homey', fields: { host: '192.168.1.40' } },
        { id: 'nas-1', type: 'synology', name: 'NAS', fields: { host: '192.168.1.9' } },
      ],
    }))
  }

  it('records a share on the widget, and takes it back', async () => {
    await installed()
    expect((await share({ id: 'demo', connectionId: 'homey-x1', allow: true })).statusCode).toBe(200)
    expect(store.get().marketplace.installed.demo.sharedConnections).toEqual(['homey-x1'])
    // No copy of the connection: there is still one credential, in one place.
    expect(store.get().connections).toHaveLength(2)

    expect((await share({ id: 'demo', connectionId: 'homey-x1', allow: false })).statusCode).toBe(200)
    expect(store.get().marketplace.installed.demo.sharedConnections).toEqual([])
  })

  it('refuses a connection that is not the shape this widget declares', async () => {
    // `demo` would put the value in a query string; the connection belongs to a bearer type.
    // The key would go into a URL — where it is logged — in a form the service never asked for.
    await installed(QUERY)
    const res = await share({ id: 'demo', connectionId: 'homey-x1', allow: true })
    expect(res.statusCode).toBe(409)
    expect(store.get().marketplace.installed.demo.sharedConnections).toEqual([])
  })

  it('refuses when the widget that declared the connection is no longer installed', async () => {
    // There is then no granted declaration to compare against, and "probably compatible" is not
    // a thing this decides on somebody's behalf.
    await installed()
    await app.inject({ method: 'POST', url: '/api/marketplace/uninstall', payload: { id: 'owner' } as never })
    const res = await share({ id: 'demo', connectionId: 'homey-x1', allow: true })
    expect(res.statusCode).toBe(409)
  })

  it('drops what the proxy cached for a connection when the share is taken back', async () => {
    // A revocation that left the answers readable would be a revocation in name only: the
    // widget was served from a cache keyed by connection, not by widget.
    await installed()
    await share({ id: 'demo', connectionId: 'homey-x1', allow: true })
    connCache.put('homey-x1', '/a', { status: 200, body: Buffer.from('cached'), json: false })
    expect(connCache.get('homey-x1', '/a', 60_000)).toBeDefined()

    await share({ id: 'demo', connectionId: 'homey-x1', allow: false })
    expect(connCache.get('homey-x1', '/a', 60_000)).toBeUndefined()
  })

  it('always allows taking a share back', async () => {
    // Revoking must not depend on anything still being compatible, or installed.
    await installed()
    expect((await share({ id: 'demo', connectionId: 'homey-x1', allow: true })).statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/api/marketplace/uninstall', payload: { id: 'owner' } as never })
    expect((await share({ id: 'demo', connectionId: 'homey-x1', allow: false })).statusCode).toBe(200)
    expect(store.get().marketplace.installed.demo.sharedConnections).toEqual([])
  })

  it('refuses to share a coded type, which a widget could never have asked for', async () => {
    await installed()
    const res = await share({ id: 'demo', connectionId: 'nas-1', allow: true })
    expect(res.statusCode).toBe(409)
    expect(store.get().marketplace.installed.demo.sharedConnections).toEqual([])
  })

  it('refuses for a widget that is not installed, and a malformed body', async () => {
    await installed()
    expect((await share({ id: 'ghost', connectionId: 'homey-x1', allow: true })).statusCode).toBe(404)
    expect((await share({ id: 'demo', connectionId: 'homey-x1' })).statusCode).toBe(400)
  })

  it('refuses a cross-site call', async () => {
    await installed()
    const res = await app.inject({
      method: 'POST', url: '/api/marketplace/share',
      headers: { 'sec-fetch-site': 'cross-site' },
      payload: { id: 'demo', connectionId: 'homey-x1', allow: true } as never,
    })
    expect(res.statusCode).toBe(403)
  })

  it('keeps what was shared across an update of the same widget', async () => {
    // A new version of a widget is not a different widget; the user agreed to that connection
    // for it, and making them agree again on every update would train them to click through.
    await installed()
    await share({ id: 'demo', connectionId: 'homey-x1', allow: true })
    await store.update((c) => ({
      ...c,
      marketplace: { installed: { demo: { ...c.marketplace.installed.demo, version: '0.9.0' } } },
    }))
    const res = await app.inject({ method: 'POST', url: '/api/marketplace/update', payload: { id: 'demo', consent: set({ subscriptions: ['system'] }) } as never })
    expect(res.statusCode).toBe(200)
    expect(store.get().marketplace.installed.demo.sharedConnections).toEqual(['homey-x1'])
  })
})

describe('themes', () => {
  const THEME = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'nuit', name: { fr: 'Nuit', en: 'Night' }, version: '1.0.0',
    description: { fr: 'Sombre', en: 'Dark' }, tokens: { bg: '#0d1117', accent: '#58a6ff' }, ...over,
  })

  const themeZip = (theme: Record<string, unknown> = THEME(), extra: { name: string; data: Buffer }[] = []): Buffer =>
    writeZip([
      { name: 'theme.json', data: Buffer.from(JSON.stringify(theme)) },
      ...extra,
    ], new Date(Date.UTC(1980, 0, 1)))

  const themeEntry = (zip: Buffer, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'nuit', version: '1.0.0', name: { fr: 'Nuit', en: 'Night' }, description: { fr: 'Sombre', en: 'Dark' },
    tokens: { accent: '#58a6ff', bg: '#0d1117', surface: '#161b22', text: '#e6edf3' },
    size: zip.byteLength, sha256: sha256(zip), url: `https://${HOST}/themes/nuit-1.0.0.zip`,
    publishedAt: '2026-09-18T12:00:00.000Z', previous: [], ...over,
  })

  /** A registry serving one widget and one theme, the theme's zip being whatever is passed. */
  async function withTheme(zip: Buffer, entry?: Record<string, unknown>): Promise<void> {
    await app.close()
    const widgetZip = packageOf()
    await build({
      zip: widgetZip,
      index: { ...indexFor(widgetZip), themes: [entry ?? themeEntry(zip)] },
      themeZip: zip,
    })
  }

  const installTheme = (over: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/marketplace/install', payload: { id: 'nuit', kind: 'theme', ...over } as never })

  it('lists the themes of the index beside the widgets', async () => {
    const zip = themeZip()
    await withTheme(zip)
    const body = (await app.inject({ url: '/api/marketplace' })).json()
    expect(body.themes).toHaveLength(1)
    expect(body.themes[0]).toMatchObject({ id: 'nuit', installed: false, updateAvailable: false, inUse: false })
    // Nothing to consent to and nothing that a newer Fremkit would be needed to run.
    expect(body.themes[0].consentNeeded).toBeUndefined()
    expect(body.themes[0].sdkTooNew).toBeUndefined()
    expect(body.themes[0].tokens.accent).toBe('#58a6ff')
  })

  it('installs one, with no dialog and an empty grant', async () => {
    const zip = themeZip()
    await withTheme(zip)
    const res = await installTheme()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, id: 'nuit', kind: 'theme', version: '1.0.0' })
    expect(JSON.parse(await readFile(join(installedThemesDir, 'nuit', 'theme.json'), 'utf8')).id).toBe('nuit')
    const record = store.get().marketplace.installed.nuit
    expect(record.kind).toBe('theme')
    expect(record.consentedPermissions).toEqual({ subscriptions: [], commands: [], network: [] })
    // And the screen can now choose it without a reload of the server.
    expect(themes.get('nuit')?.tokens.bg).toBe('#0d1117')
  })

  it('accepts a README beside the theme and nothing else', async () => {
    await withTheme(themeZip(THEME(), [{ name: 'README.md', data: Buffer.from('# Nuit') }]))
    expect((await installTheme()).statusCode).toBe(200)

    await withTheme(themeZip(THEME(), [{ name: 'index.html', data: Buffer.from('<html>') }]))
    const refused = await installTheme()
    expect(refused.statusCode).toBe(422)
  })

  it('refuses a theme whose id is not the one asked for', async () => {
    await withTheme(themeZip(THEME({ id: 'autre' })))
    expect((await installTheme()).statusCode).toBe(422)
  })

  it('refuses an id a built-in theme already owns', async () => {
    const zip = themeZip(THEME({ id: 'fremkit' }))
    await withTheme(zip, themeEntry(zip, { id: 'fremkit' }))
    const res = await app.inject({ method: 'POST', url: '/api/marketplace/install', payload: { id: 'fremkit', kind: 'theme' } as never })
    expect(res.statusCode).toBe(409)
  })

  it('refuses a theme.json the schema does not accept', async () => {
    // These values end up in a `style` attribute on `<html>` and inside every widget frame.
    await withTheme(themeZip(THEME({ tokens: { bg: 'red; background-image: url(https://evil.example.net/x)' } })))
    expect((await installTheme()).statusCode).toBe(422)
  })

  it('refuses a package whose version is not the release it came from', async () => {
    const zip = themeZip(THEME({ version: '9.9.9' }))
    await withTheme(zip)
    expect((await installTheme()).statusCode).toBe(422)
  })

  it('refuses a widget install over an installed theme of the same id', async () => {
    const zip = themeZip()
    await withTheme(zip)
    await installTheme()
    const asWidget = await app.inject({ method: 'POST', url: '/api/marketplace/install', payload: { id: 'nuit' } as never })
    // 404 would also be an honest answer (the index has no widget `nuit`), so the point is the
    // record: whatever happens, the theme's is still there and still a theme's.
    expect(asWidget.statusCode).not.toBe(200)
    expect(store.get().marketplace.installed.nuit.kind).toBe('theme')
  })

  it('does not call a theme installed when a widget of that id holds the record', async () => {
    const zip = themeZip()
    await withTheme(zip)
    await store.update((c) => ({ ...c, marketplace: { installed: { nuit: {
      kind: 'widget' as const, sharedConnections: [], version: '9.9.9', registry: 'fremkit-sietch',
      consentedPermissions: { subscriptions: [], commands: [], network: [] },
      installedAt: '2026-09-18T12:00:00.000Z',
    } } } }))
    const body = (await app.inject({ url: '/api/marketplace' })).json()
    expect(body.themes[0]).toMatchObject({ installed: false, installedVersion: null, updateAvailable: false })
    // And removing it is a 404 rather than a delete of somebody else's record.
    const gone = await app.inject({ method: 'POST', url: '/api/marketplace/uninstall', payload: { id: 'nuit', kind: 'theme' } as never })
    expect(gone.statusCode).toBe(404)
    expect(store.get().marketplace.installed.nuit.kind).toBe('widget')
  })

  it('removes one, and refuses while the screen is painted with it', async () => {
    const zip = themeZip()
    await withTheme(zip)
    await installTheme()

    await store.update((c) => ({ ...c, display: { ...c.display, theme: 'nuit' } }))
    const inUse = await app.inject({ method: 'POST', url: '/api/marketplace/uninstall', payload: { id: 'nuit', kind: 'theme' } as never })
    expect(inUse.statusCode).toBe(409)
    expect((await app.inject({ url: '/api/marketplace' })).json().themes[0].inUse).toBe(true)

    await store.update((c) => ({ ...c, display: { ...c.display, theme: 'fremkit' } }))
    const gone = await app.inject({ method: 'POST', url: '/api/marketplace/uninstall', payload: { id: 'nuit', kind: 'theme' } as never })
    expect(gone.statusCode).toBe(200)
    expect(store.get().marketplace.installed.nuit).toBeUndefined()
    expect(themes.get('nuit')).toBeUndefined()
  })

  it('updates one, and refuses an update of something not installed', async () => {
    const zip = themeZip()
    await withTheme(zip)
    const notYet = await app.inject({ method: 'POST', url: '/api/marketplace/update', payload: { id: 'nuit', kind: 'theme' } as never })
    expect(notYet.statusCode).toBe(409)

    await installTheme()
    const newer = themeZip(THEME({ version: '2.0.0', tokens: { bg: '#000000' } }))
    await app.close()
    const widgetZip = packageOf()
    await build({
      zip: widgetZip,
      index: { ...indexFor(widgetZip), themes: [themeEntry(newer, { version: '2.0.0', url: `https://${HOST}/themes/nuit-2.0.0.zip` })] },
      themeZip: newer,
    })
    // `build` gives a fresh store, so the record has to be put back before the update is asked for.
    await store.update((c) => ({ ...c, marketplace: { installed: { nuit: {
      kind: 'theme' as const, sharedConnections: [], version: '1.0.0', registry: 'fremkit-sietch',
      consentedPermissions: { subscriptions: [], commands: [], network: [] },
      installedAt: '2026-09-18T12:00:00.000Z',
    } } } }))
    const res = await app.inject({ method: 'POST', url: '/api/marketplace/update', payload: { id: 'nuit', kind: 'theme' } as never })
    expect(res.statusCode).toBe(200)
    expect(store.get().marketplace.installed.nuit.version).toBe('2.0.0')
  })
})
