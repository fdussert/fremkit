import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ConfigSchema, type Config } from '../src/config/schema.js'
import { ManifestSchema, type WidgetManifest } from '../src/widgets/manifest.js'
import { classifySetting } from '../src/share/settings.js'
import { assertShareable, buildLayout, ShareLeakError, type ShareDeps } from '../src/share/export.js'
import { readLayout, LayoutError, type ImportDeps } from '../src/share/import.js'
import { LAYOUT_FORMAT, LAYOUT_VERSION, MAX_SHARED_IMAGE_BYTES, layoutFilename, type LayoutFile } from '../src/share/format.js'
import { shareRedaction } from '../src/share/context.js'
import type { RedactionContext } from '../src/diagnostics/redact.js'

// Documentation-range fixtures only: nothing here names a real person, host or account.
const SECRET = 'sk-test-0123456789abcdefSECRET'
const HOST = '192.0.2.10'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

const manifest = (raw: object): WidgetManifest => ManifestSchema.parse({ name: 'x', version: '1.0.0', ...raw })

const MANIFESTS: Record<string, WidgetManifest> = {
  clock: manifest({
    id: 'clock', version: '2.1.0', minSize: [4, 2], defaultSize: [8, 4],
    settingsSchema: {
      format: { type: 'enum', label: 'Format', options: ['12h', '24h'] },
      seconds: { type: 'boolean', label: 'Seconds' },
      zone: { type: 'timezone', label: 'Zone' },
      color: { type: 'color', label: 'Colour' },
      label: { type: 'string', label: { fr: 'Libellé', en: 'Label' } },
    },
  }),
  calendar: manifest({
    id: 'calendar', minSize: [4, 2], defaultSize: [8, 4],
    settingsSchema: {
      source: { type: 'connection', label: 'Calendar', connectionType: 'ics' },
      days: { type: 'number', label: 'Days' },
      feeds: { type: 'connections', label: 'Feeds', connectionType: 'ics' },
    },
  }),
  shortcuts: manifest({
    id: 'shortcuts', minSize: [2, 1], defaultSize: [4, 2], compact: { width: 3 },
    settingsSchema: {
      items: { type: 'list', label: 'Items', itemSchema: { kind: { type: 'enum', label: 'Kind', options: ['app', 'url'] }, target: { type: 'string', label: 'Target' } } },
      flags: { type: 'list', label: 'Flags', itemSchema: { on: { type: 'boolean', label: 'On' } } },
    },
  }),
}

/** A dashboard that has every kind of thing a shared file must leave behind. */
function sampleConfig(): Config {
  return ConfigSchema.parse({
    version: 4,
    theme: 'edge',
    themeSchedule: { night: 'fremkit', latitude: 48.85, longitude: 2.35 },
    locale: 'en',
    connections: [{ id: 'cal-home', type: 'ics', name: 'Family agenda', fields: { url: `http://${HOST}/cal.ics` } }],
    privacy: { showAccountEmail: true },
    marketplace: { installed: { shortcuts: { version: '1.0.0', registry: 'sietch', consentedPermissions: {}, installedAt: '2026-01-01' } } },
    widgets: {
      'my-clock': { widgetId: 'clock', title: 'jane.doe@example.com', bgColor: '#112233', background: { image: 'upload-photo.png', dim: 0.4 }, settings: { format: '24h', seconds: true, zone: 'Europe/Paris', color: '#abcdef', label: 'Kitchen', unknown: 1 } },
      'cal-1': { widgetId: 'calendar', title: 'Agenda', settings: { source: 'cal-home', days: 7, feeds: ['cal-home'] } },
      'sc-1': { widgetId: 'shortcuts', settings: { items: [{ kind: 'url', target: `https://${HOST}/admin` }], flags: [{ on: true }] } },
    },
    screens: [
      {
        id: 'edge', name: 'Xeneon Edge', kind: 'edge',
        display: { cols: 64, rows: 16, cell: 40, background: { image: 'fremkit-wallpaper.png', fit: 'cover' } },
        nav: [{ instanceId: 'sc-1', slot: 'right' }],
        brightness: { dayNight: { enabled: true, latitude: 48.85, longitude: 2.35 } },
        pages: [
          { id: 'home', name: 'Home', items: [{ instanceId: 'my-clock', x: 0, y: 0, w: 8, h: 4 }, { instanceId: 'cal-1', x: 8, y: 0, w: 8, h: 4 }] },
          { id: 'two', name: 'Family agenda', items: [], background: { image: 'missing.png' } },
        ],
      },
      { id: 'ipad', name: 'Jane iPad', kind: 'device', display: { cols: 20, rows: 18, viewport: { width: 820, height: 1180 } }, pages: [{ id: 'p', name: 'Main', items: [{ instanceId: 'my-clock', x: 0, y: 0, w: 8, h: 4 }] }] },
    ],
  })
}

const CTX: RedactionContext = { secrets: [SECRET], hosts: [HOST], names: ['Family agenda', 'Jane iPad'], machineNames: ['Janes-MacBook'], home: '/Users/jane', username: 'jane' }

function deps(config: Config, images: Record<string, Buffer> = { 'upload-photo.png': PNG }): ShareDeps & ImportDeps {
  return {
    config: () => config,
    manifest: (id) => MANIFESTS[id],
    source: (id) => (id === 'shortcuts' ? 'installed' : MANIFESTS[id] ? 'builtin' : undefined),
    readImage: async (name) => images[name] ?? null,
    redaction: async () => CTX,
    shippedBackground: 'fremkit-wallpaper.png',
  }
}

describe('classifySetting', () => {
  const f = MANIFESTS.clock.settingsSchema
  it('keeps closed values and refuses the wrong type', () => {
    expect(classifySetting(f.format, '24h')).toBe('keep')
    expect(classifySetting(f.format, 'other')).toBe('invalid')
    expect(classifySetting(f.seconds, true)).toBe('keep')
    expect(classifySetting(f.seconds, 'yes')).toBe('invalid')
    expect(classifySetting(f.zone, 'America/Argentina/Buenos_Aires')).toBe('keep')
    expect(classifySetting(f.zone, 'http://x')).toBe('invalid')
    expect(classifySetting(f.color, '#abcdef')).toBe('keep')
  })
  it('asks for free text, blanks connections, drops what the manifest does not declare', () => {
    expect(classifySetting(f.label, 'anything')).toBe('optional')
    expect(classifySetting(MANIFESTS.calendar.settingsSchema.source, 'cal-home')).toBe('connection')
    expect(classifySetting(MANIFESTS.calendar.settingsSchema.feeds, ['a'])).toBe('connection')
    expect(classifySetting(undefined, 1)).toBe('unknown')
  })
  it('reads a list by its item fields', () => {
    const s = MANIFESTS.shortcuts.settingsSchema
    expect(classifySetting(s.items, [{ kind: 'url', target: 'x' }])).toBe('optional')
    expect(classifySetting(s.flags, [{ on: true }])).toBe('keep')
    expect(classifySetting(s.flags, [{ on: true, extra: 'x' }])).toBe('invalid')
  })
})

describe('buildLayout', () => {
  it('shares the layout and nothing that identifies anyone', async () => {
    const { file, report } = await buildLayout(deps(sampleConfig()), { scope: 'setup' })
    const text = JSON.stringify(file)
    for (const banned of [SECRET, HOST, 'example.com', 'cal-home', 'Family agenda', 'Jane iPad', 'my-clock', 'upload-photo', 'latitude', 'privacy', 'marketplace', 'connections', 'brightness', 'Kitchen']) {
      expect(text).not.toContain(banned)
    }
    expect(file.format).toBe(LAYOUT_FORMAT)
    expect(file.version).toBe(LAYOUT_VERSION)
    expect(file.theme).toEqual({ day: 'edge', night: 'fremkit' })
    expect(file.catalog).toEqual({
      clock: { version: '2.1.0', source: 'builtin' }, calendar: { version: '1.0.0', source: 'builtin' }, shortcuts: { version: '1.0.0', source: 'sietch' },
    })
    // Widgets are re-keyed; one widget on two screens stays one widget.
    expect(Object.keys(file.widgets)).toEqual(['w1', 'w2', 'w3'])
    expect(file.screens[1].pages[0].items[0].widget).toBe('w1')
    expect(file.widgets.w1.settings).toEqual({ format: '24h', seconds: true, zone: 'Europe/Paris', color: '#abcdef' })
    expect(file.widgets.w1.title).toBeUndefined()
    expect(file.widgets.w2.settings).toEqual({ days: 7 })
    expect(file.widgets.w2.title).toBe('Agenda')
    expect(file.widgets.w3.settings).toEqual({ flags: [{ on: true }] })
    // Names that match something identifying are replaced; the device screen's is one.
    expect(file.screens.map((s) => s.name)).toEqual(['Xeneon Edge', 'Screen 2'])
    expect(file.screens[0].pages.map((p) => p.name)).toEqual(['Home', 'Page 2'])
    expect(report.renamed).toEqual(expect.arrayContaining([{ kind: 'title', to: null }, { kind: 'page', to: 'Page 2' }, { kind: 'screen', to: 'Screen 2' }]))
    // The shipped wallpaper is named, the upload embedded, the missing one listed.
    expect(file.images['fremkit-wallpaper']).toEqual({ shipped: true })
    expect(file.images['image-2.png']).toEqual({ data: PNG.toString('base64') })
    expect(file.widgets.w1.background).toEqual({ image: 'image-2.png', dim: 0.4 })
    expect(file.screens[0].pages[1].background).toBeUndefined()
    expect(report.images.leftOut).toEqual([{ reason: 'missing' }])
    expect(file.screens[0].display).not.toHaveProperty('brightness')
    expect(file.screens[1].display.viewport).toEqual({ width: 820, height: 1180 })
    expect(report.removed.map((r) => [r.key, r.reason])).toEqual(expect.arrayContaining([
      ['unknown', 'unknown'], ['source', 'connection'], ['feeds', 'connection'],
    ]))
    // Free text is offered, not shared; one holding a host never even reaches the checkbox.
    expect(report.optional.map((o) => o.id)).toEqual(['my-clock:label'])
    expect(report.removed).toContainEqual(expect.objectContaining({ instanceId: 'sc-1', key: 'items', reason: 'personal' }))
  })

  it('carries an empty free-text field as is, without asking', async () => {
    const config = sampleConfig()
    config.widgets['my-clock'].settings.label = ''
    const { file, report } = await buildLayout(deps(config), { scope: 'setup' })
    expect(file.widgets.w1.settings.label).toBe('')
    expect(report.optional).toEqual([])
  })

  it('shares a ticked free-text setting', async () => {
    const { file, report } = await buildLayout(deps(sampleConfig()), { scope: 'setup', include: ['my-clock:label'] })
    expect(file.widgets.w1.settings.label).toBe('Kitchen')
    expect(report.optional[0].included).toBe(true)
  })

  it('exports one page, or one screen, and names the file after it', async () => {
    const page = await buildLayout(deps(sampleConfig()), { scope: 'page', screenId: 'edge', pageId: 'home' })
    expect(page.file.screens).toHaveLength(1)
    expect(page.file.screens[0].pages).toHaveLength(1)
    expect(page.file.screens[0].nav).toEqual([])
    expect(Object.keys(page.file.widgets)).toEqual(['w1', 'w2'])
    expect(page.filename).toBe('home.fremkit-layout.json')
    const screen = await buildLayout(deps(sampleConfig()), { scope: 'screen', screenId: 'edge' })
    expect(screen.file.screens[0].nav).toEqual([{ widget: 'w3', slot: 'right' }])
    expect(screen.filename).toBe('xeneon-edge.fremkit-layout.json')
    await expect(buildLayout(deps(sampleConfig()), { scope: 'screen', screenId: 'nope' })).rejects.toThrow()
  })

  it('leaves out images over the size cap', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_SHARED_IMAGE_BYTES)])
    const { file, report } = await buildLayout(deps(sampleConfig(), { 'upload-photo.png': big }), { scope: 'page', pageId: 'home' })
    // The screen's wallpaper is the shipped one: named, not embedded, so it is still there.
    expect(Object.keys(file.images)).toEqual(['fremkit-wallpaper'])
    expect(file.widgets.w1.background).toBeUndefined()
    expect(report.images.leftOut).toEqual([{ reason: 'tooLarge', bytes: big.length }])
  })

  it('the last net refuses a file that still carries something identifying', () => {
    const file = { format: LAYOUT_FORMAT, version: 1, scope: 'page', widgets: { w1: { widgetId: 'clock', showTitle: true, settings: { color: `see ${HOST}` } } }, catalog: {}, screens: [], images: {} } as unknown as LayoutFile
    expect(() => assertShareable(file, CTX)).toThrow(ShareLeakError)
    const clean = { ...file, widgets: { w1: { widgetId: 'clock', showTitle: true, settings: { color: '#abcdef' } } } } as unknown as LayoutFile
    expect(() => assertShareable(clean, CTX)).not.toThrow()
  })
})

describe('readLayout', () => {
  /** A config on the importer's side: a connection with an id a hostile file might guess. */
  const theirs = (): Config => ConfigSchema.parse({
    version: 4, locale: 'en',
    connections: [{ id: 'cal-1', type: 'ics', name: 'Mine', fields: {} }],
    screens: [{ id: 'edge', name: 'Edge', kind: 'edge', pages: [{ id: 'home', name: 'Home', items: [] }] }],
  })

  it('reads back what an export wrote, and lists the connections to choose', async () => {
    const { file } = await buildLayout(deps(sampleConfig()), { scope: 'setup' })
    const { layout, report } = readLayout(JSON.parse(JSON.stringify(file)), deps(theirs()))
    expect(report.scope).toBe('setup')
    expect(report.screens).toBe(2)
    expect(report.widgets.find((w) => w.widgetId === 'shortcuts')).toMatchObject({ status: 'installed', source: 'sietch' })
    expect(report.connections.map((c) => [c.widget, c.setting, c.multiple])).toEqual([['w2', 'source', false], ['w2', 'feeds', true]])
    expect(report.images.map((i) => i.key).sort()).toEqual(['fremkit-wallpaper', 'image-2.png'])
    expect(layout.widgets.w1.settings).toEqual({ format: '24h', seconds: true, zone: 'Europe/Paris', color: '#abcdef' })
  })

  it('refuses what is not a layout, a newer one, and a malformed one', () => {
    const d = deps(theirs())
    expect(() => readLayout({ hello: 1 }, d)).toThrow(LayoutError)
    expect(() => readLayout({ format: LAYOUT_FORMAT, version: LAYOUT_VERSION + 1, fremkit: '9.0.0' }, d)).toThrow('newer Fremkit (9.0.0)')
    expect(() => readLayout({ format: LAYOUT_FORMAT, version: LAYOUT_VERSION, scope: 'page', widgets: {}, screens: [] }, d)).toThrow(LayoutError)
  })

  it('distrusts a hostile file: connection ids, settings, geometry, images', () => {
    const hostile = {
      format: LAYOUT_FORMAT, version: LAYOUT_VERSION, scope: 'screen',
      widgets: {
        a: { widgetId: 'calendar', settings: { source: 'cal-1', days: 'cal-1', feeds: ['cal-1'] } },
        b: { widgetId: 'clock', settings: { format: '24h', label: 'cal-1', bogus: true }, background: { image: 'fake.png' } },
        c: { widgetId: 'clock', settings: {} },
        d: { widgetId: 'not-installed-anywhere', settings: {} },
      },
      screens: [{
        name: 'S', kind: 'edge', display: { cols: 64, rows: 16 },
        nav: [{ widget: 'b' }],
        pages: [{ name: 'P', items: [
          { widget: 'a', x: 0, y: 0, w: 8, h: 4 },
          { widget: 'b', x: 4, y: 0, w: 8, h: 4 },
          { widget: 'c', x: 60, y: 0, w: 8, h: 4 },
          { widget: 'd', x: 20, y: 0, w: 4, h: 4 },
        ] }],
      }],
      images: { 'fake.png': { data: Buffer.from('not an image').toString('base64') } },
    }
    const { layout, report } = readLayout(hostile, deps(theirs()))
    expect(layout.widgets.a.settings).toEqual({})
    expect(Object.keys(layout.widgets)).toEqual(['a'])
    expect(layout.screens[0].pages[0].items.map((i) => i.widget)).toEqual(['a'])
    expect(layout.screens[0].nav).toEqual([])
    expect(layout.images).toEqual({})
    expect(report.widgets.find((w) => w.widgetId === 'not-installed-anywhere')?.status).toBe('missing')
    expect(report.dropped.images).toBe(1)
    expect(report.dropped.placements).toBeGreaterThanOrEqual(2)
    // The connection settings were blanked on purpose and are asked about, not counted as lost.
    expect(report.dropped.settings).toBe(3)
  })
})

describe('layoutFilename', () => {
  it('makes a safe slug', () => {
    expect(layoutFilename('Bürö / Écran 2')).toBe('buro-ecran-2.fremkit-layout.json')
    expect(layoutFilename('…')).toBe('fremkit.fremkit-layout.json')
  })
})

describe('shareRedaction', () => {
  it('names the secrets, hosts, connections and devices, not the widget ids', async () => {
    const config = sampleConfig()
    const ctx = await shareRedaction(config, {
      secretsFor: async () => ({ token: SECRET }),
      devices: () => [{ name: 'Desk tablet' }, { name: 'clock' }],
      system: { machineNames: ['m'], home: '/Users/x', username: 'x' },
    })
    expect(ctx.secrets).toContain(SECRET)
    expect(ctx.hosts).toContain(HOST)
    expect(ctx.names).toEqual(expect.arrayContaining(['Family agenda', 'Desk tablet', 'Jane iPad']))
    expect(ctx.names).not.toContain('clock')
  })
})

describe('share routes', () => {
  let dir: string
  let app: FastifyInstance
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-share-'))
    const dataDir = join(dir, 'data')
    await mkdir(join(dataDir, 'backgrounds'), { recursive: true })
    await writeFile(join(dataDir, 'backgrounds', 'own.png'), PNG)
    await writeFile(join(dataDir, 'fremkit.json'), JSON.stringify({
      version: 4, locale: 'en',
      widgets: { w1: { widgetId: 'clock', settings: {}, background: { image: 'own.png' } } },
      screens: [{ id: 'edge', name: 'Edge', kind: 'edge', nav: [], pages: [{ id: 'home', name: 'Home', items: [{ instanceId: 'w1', x: 0, y: 0, w: 8, h: 4 }] }] }],
    }), 'utf8')
    app = await buildApp({ accessToken: null, dataDir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [] })
  })
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })

  it('previews an export with image sizes, not bytes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/share/export', payload: { scope: 'page', screen: 'edge', page: 'home' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.filename).toBe('home.fremkit-layout.json')
    expect(body.file.images['image-1.png']).toEqual({ bytes: PNG.length })
    expect(body.report.tiles).toBe(1)
  })

  it('downloads the file as an attachment, which the admin window saves', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/share/export?scope=setup' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="fremkit-setup.fremkit-layout.json"')
    const file = JSON.parse(res.body)
    expect(file.images['image-1.png'].data).toBe(PNG.toString('base64'))
  })

  it('reads a file back, and refuses a bad one in the config language', async () => {
    const file = JSON.parse((await app.inject({ method: 'GET', url: '/api/share/export?scope=screen' })).body)
    const ok = await app.inject({ method: 'POST', url: '/api/share/import', payload: file })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().report.widgets[0]).toMatchObject({ widgetId: 'clock', status: 'builtin' })
    expect(ok.json().shippedBackground).toBe('fremkit-wallpaper.png')
    const bad = await app.inject({ method: 'POST', url: '/api/share/import', payload: { format: 'nope' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('this file is not a Fremkit layout')
    const unknown = await app.inject({ method: 'POST', url: '/api/share/export', payload: { scope: 'screen', screen: 'nope' } })
    expect(unknown.statusCode).toBe(404)
  })

  it('refuses a request that is not from this Mac', async () => {
    for (const [method, url] of [['GET', '/api/share/export?scope=setup'], ['POST', '/api/share/export'], ['POST', '/api/share/import']] as const) {
      const res = await app.inject({ method, url, remoteAddress: '192.0.2.9', payload: method === 'POST' ? { scope: 'setup' } : undefined })
      expect(res.statusCode).toBe(404)
    }
  })
})
