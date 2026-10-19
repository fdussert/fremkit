import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOMEY_DECLARED_TYPE, migrateConfig, migrateHomeySecret, normalizeV3, renameCollisions, toV4,
} from '../src/config/migrate.js'
import type { SecretStore } from '../src/secrets/types.js'
import { ConfigStore } from '../src/config/store.js'
import { DEFAULT_CONFIG, validateLayout, type LayoutManifest } from '../src/config/schema.js'
import { V3ConfigSchema } from '../src/config/v3.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** A real-shaped v3 dashboard, with placeholder data: three pages, a bar, and every legacy quirk. */
const realText = readFileSync(fileURLToPath(new URL('./fixtures/config-v3-real.json', import.meta.url)), 'utf8')
const realFixture = JSON.parse(realText) as Record<string, any>

const v1 = {
  version: 1,
  display: { cols: 32, rows: 8, cell: 80, autoCycleSeconds: 30 },
  pages: [{ id: 'home', name: 'Home', widgets: [{ instanceId: 'clock-1', widgetId: 'clock', x: 4, y: 1, w: 8, h: 2, settings: { seconds: true } }] }],
}

describe('migrateConfig', () => {
  it('doubles the grid and every instance, and fills the new fields', () => {
    const c = migrateConfig(v1)
    expect(c.version).toBe(4)
    expect(c.theme).toBe('fremkit')
    expect(c.screens[0].display).toEqual({ cols: 64, rows: 16, cell: 40, autoCycleSeconds: 30 })
    expect(c.screens[0].pages[0].items[0]).toEqual({ instanceId: 'clock-1', x: 8, y: 2, w: 16, h: 4 })
    expect(c.widgets['clock-1']).toEqual({ widgetId: 'clock', showTitle: true, settings: { seconds: true } })
  })
  it('treats a config without a version as v1', () => {
    const { version, ...noVersion } = v1
    expect(version).toBe(1)
    expect(migrateConfig(noVersion).screens[0].display.cols).toBe(64)
  })
  it('accepts a v4 config unchanged', () => {
    const c4 = migrateConfig(v1)
    expect(migrateConfig(c4)).toEqual(c4)
  })
  it('keeps older dashboards opted out of Codex account and history reads', () => {
    const old = migrateConfig(v1)
    delete (old.privacy as Partial<typeof old.privacy>).codexAccount
    delete (old.privacy as Partial<typeof old.privacy>).codexHistorySources
    expect(migrateConfig(old).privacy).toMatchObject({
      codexAccount: false,
      codexHistorySources: [],
    })
    expect(migrateConfig(v1).privacy).toMatchObject({
      codexAccount: false,
      codexHistorySources: [],
    })
  })
  describe('labs.devices', () => {
    /** A v4 file as a release before the flag wrote it: no `labs` key at all. */
    const withoutLabs = (screens: Record<string, unknown>[]) => {
      const c = JSON.parse(JSON.stringify(migrateConfig(v1))) as Record<string, any>
      delete c.labs
      c.screens = screens
      return c
    }
    const edge = () => JSON.parse(JSON.stringify(migrateConfig(v1).screens[0])) as Record<string, any>
    const device = () => ({ ...edge(), id: 'kitchen', name: 'Kitchen', kind: 'device' })

    it('starts off for a fresh install and for an older file', () => {
      expect(DEFAULT_CONFIG.labs).toEqual({ devices: false, companion: false })
      expect(migrateConfig(v1).labs).toEqual({ devices: false, companion: false })
    })
    it('starts off for a v4 file with only the Edge', () => {
      expect(migrateConfig(withoutLabs([edge()])).labs.devices).toBe(false)
    })
    it('starts on for a v4 file with more than one screen', () => {
      expect(migrateConfig(withoutLabs([edge(), { ...edge(), id: 'edge-2', name: 'Second' }])).labs.devices).toBe(true)
    })
    it('starts on for a v4 file whose only screen is a device one', () => {
      expect(migrateConfig(withoutLabs([device()])).labs.devices).toBe(true)
    })
    it('keeps a stated value either way, whatever the screens', () => {
      const off = { ...withoutLabs([edge(), device()]), labs: { devices: false } }
      expect(migrateConfig(off).labs.devices).toBe(false)
      const on = { ...withoutLabs([edge()]), labs: { devices: true } }
      expect(migrateConfig(on).labs.devices).toBe(true)
    })
  })
  describe('labs.companion', () => {
    /** A v4 file holding these widgets, with `labs` as given (absent when undefined). */
    const v4 = (widgetIds: string[], labs?: Record<string, boolean>) => {
      const c = JSON.parse(JSON.stringify(migrateConfig(v1))) as Record<string, any>
      delete c.labs
      if (labs) c.labs = labs
      c.widgets = Object.fromEntries(widgetIds.map((id, i) => [`${id}-${i}`, { widgetId: id, showTitle: false, settings: {} }]))
      c.screens[0].pages[0].items = []
      c.screens[0].nav = []
      return c
    }

    it('starts off for a v4 file with no Fremplay, the devices switch stated or not', () => {
      expect(migrateConfig(v4(['clock'])).labs.companion).toBe(false)
      expect(migrateConfig(v4(['clock'], { devices: true })).labs).toEqual({ devices: true, companion: false })
    })
    it('starts on for a v4 file that already holds a Fremplay widget', () => {
      expect(migrateConfig(v4(['clock', 'fremplay'])).labs.companion).toBe(true)
      expect(migrateConfig(v4(['fremplay'], { devices: false })).labs).toEqual({ devices: false, companion: true })
    })
    it('keeps a stated value either way, whatever the widgets', () => {
      expect(migrateConfig(v4(['fremplay'], { devices: false, companion: false })).labs.companion).toBe(false)
      expect(migrateConfig(v4(['clock'], { devices: false, companion: true })).labs.companion).toBe(true)
    })
  })
  it('rejects an unknown version with a clear message', () => {
    // Translated now, so match either language rather than the French wording.
    expect(() => migrateConfig({ ...v1, version: 7 })).toThrow(/(version de config inconnue|unknown config version).*7/)
  })
})

describe('ConfigStore migration', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fremkit-mig-')) })

  it('rewrites a v1 file as v4 and keeps the original as .bak', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify(v1, null, 2))
    const cfg = await new ConfigStore(file).load()
    expect(cfg.version).toBe(4)
    expect(JSON.parse(await readFile(file, 'utf8')).screens[0].display.cell).toBe(40)
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(v1)
  })
  it('leaves a v4 file untouched (no .bak rewrite)', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify(migrateConfig(v1), null, 2))
    const before = await readFile(file, 'utf8')
    await new ConfigStore(file).load()
    expect(await readFile(file, 'utf8')).toBe(before)
    await expect(readFile(file + '.bak', 'utf8')).rejects.toThrow()
  })
  it('serves the defaults on an unknown version and leaves the file untouched', async () => {
    const file = join(dir, 'fremkit.json')
    const original = JSON.stringify({ ...v1, version: 7 })
    await writeFile(file, original)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = await new ConfigStore(file).load()
    const logged = err.mock.calls.join(' ')
    err.mockRestore()
    expect(cfg).toEqual(DEFAULT_CONFIG)
    // A file we cannot interpret is never rewritten: the next start retries against it.
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(await readdir(dir)).toEqual(['fremkit.json'])
    expect(logged).toMatch(/(version de config inconnue|unknown config version).*7/)
  })

  it('renames an unparsable file to .corrupt-<epoch> and recovers from the .bak', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, '{ not json')
    await writeFile(file + '.bak', JSON.stringify(migrateConfig(v1)))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = await new ConfigStore(file).load()
    err.mockRestore()
    expect(cfg.screens[0].pages[0].id).toBe('home')
    expect(JSON.parse(await readFile(file, 'utf8')).screens[0].pages[0].id).toBe('home')
    const corrupt = (await readdir(dir)).filter((f) => f.startsWith('fremkit.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
    expect(await readFile(join(dir, corrupt[0]), 'utf8')).toBe('{ not json')
  })

  it('never overwrites a pre-existing .corrupt file', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file + '.corrupt-1', 'first casualty')
    await writeFile(file, '{ not json either')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await new ConfigStore(file).load()
    err.mockRestore()
    expect(await readFile(file + '.corrupt-1', 'utf8')).toBe('first casualty')
    expect((await readdir(dir)).filter((f) => f.startsWith('fremkit.json.corrupt-'))).toHaveLength(2)
  })
})

describe('privacy settings on an older config', () => {
  const page = (widgets: object[]) => ({ id: 'home', name: 'Accueil', widgets })
  const widget = (widgetId: string) => ({ instanceId: 'a', widgetId, x: 0, y: 0, w: 8, h: 4 })

  it('starts off for a config that does not show the widget', () => {
    const cfg = migrateConfig({ version: 2, pages: [page([widget('clock')])] })
    expect(cfg.privacy.claudeAccountUsage).toBe(false)
  })

  it('starts on for a config that already shows it on a page', () => {
    // Those gauges were working before the opt-in existed; an upgrade must not blank them.
    const cfg = migrateConfig({ version: 2, pages: [page([widget('claude-usage')])] })
    expect(cfg.privacy.claudeAccountUsage).toBe(true)
  })

  it('starts on for a config that shows it in the navigation bar', () => {
    const cfg = migrateConfig({
      version: 2,
      display: { navWidgets: [{ instanceId: 'n1', widgetId: 'claude-usage' }] },
      pages: [page([widget('clock')])],
    })
    expect(cfg.privacy.claudeAccountUsage).toBe(true)
  })

  it('respects the field once the file carries it, either way', () => {
    const withWidget = (claudeAccountUsage: boolean) => migrateConfig({
      version: 2, privacy: { claudeAccountUsage }, pages: [page([widget('claude-usage')])],
    }).privacy.claudeAccountUsage
    // Turning it off on a dashboard that shows the widget is a choice, not a config to repair.
    expect(withWidget(false)).toBe(false)
    expect(withWidget(true)).toBe(true)
    expect(migrateConfig({ version: 2, privacy: { claudeAccountUsage: true }, pages: [page([widget('clock')])] })
      .privacy.claudeAccountUsage).toBe(true)
  })

  it('applies the same rule to a v1 file', () => {
    const v1page = (widgetId: string) => ({ id: 'home', name: 'Accueil', widgets: [{ instanceId: 'a', widgetId, x: 0, y: 0, w: 4, h: 2 }] })
    expect(migrateConfig({ version: 1, pages: [v1page('claude-usage')] }).privacy.claudeAccountUsage).toBe(true)
    expect(migrateConfig({ version: 1, pages: [v1page('clock')] }).privacy.claudeAccountUsage).toBe(false)
  })

  it('keeps inferring it for a v3 file, from a tile or from the bar', () => {
    const v3 = (display: object, widgetId: string) => migrateConfig({
      version: 3, display, pages: [page([widget(widgetId)])],
    }).privacy.claudeAccountUsage
    expect(v3({}, 'claude-usage')).toBe(true)
    expect(v3({ navWidgets: [{ instanceId: 'n1', widgetId: 'claude-usage' }] }, 'clock')).toBe(true)
    expect(v3({}, 'clock')).toBe(false)
    expect(migrateConfig(realFixture).privacy.claudeAccountUsage).toBe(true)
  })

  it('leaves a fresh install off', () => {
    expect(DEFAULT_CONFIG.privacy.claudeAccountUsage).toBe(false)
  })
  it('keeps macmon sampling off for existing configs and fresh installs', () => {
    const page = { id: 'home', name: 'Home', widgets: [{ instanceId: 'cpu-1', widgetId: 'cpu', x: 0, y: 0, w: 8, h: 4 }] }
    expect(migrateConfig({ version: 2, pages: [page] }).privacy.macmonTemperature).toBe(false)
    expect(migrateConfig({ ...DEFAULT_CONFIG, privacy: { claudeAccountUsage: false } }).privacy.macmonTemperature).toBe(false)
    expect(DEFAULT_CONFIG.privacy.macmonTemperature).toBe(false)
  })

  it('preserves explicit consent to macmon sampling', () => {
    expect(migrateConfig({ ...DEFAULT_CONFIG, privacy: { claudeAccountUsage: false, macmonTemperature: true } })
      .privacy.macmonTemperature).toBe(true)
  })
})

describe('privacy.showAccountEmail on an older config', () => {
  const page = (widgets: object[]) => ({ id: 'home', name: 'Accueil', widgets })
  const widget = (widgetId: string) => ({ instanceId: 'a', widgetId, x: 0, y: 0, w: 8, h: 4 })

  it('starts off for every config written before it existed', () => {
    // Even next to the Claude opt-in being inferred on: reading the usage is not showing the e-mail.
    const v4 = migrateConfig({ ...migrateConfig(v1), privacy: { claudeAccountUsage: true } })
    // toMatchObject: other privacy keys arrive in other branches and must not break this.
    expect(v4.privacy).toMatchObject({ claudeAccountUsage: true, showAccountEmail: false })
    expect(migrateConfig({ version: 2, pages: [page([widget('claude-usage')])] }).privacy)
      .toMatchObject({ claudeAccountUsage: true, showAccountEmail: false })
    expect(migrateConfig(v1).privacy.showAccountEmail).toBe(false)
  })

  it('respects the field once the file carries it', () => {
    const v4 = (showAccountEmail: boolean) => migrateConfig({
      ...migrateConfig(v1), privacy: { claudeAccountUsage: false, showAccountEmail },
    }).privacy.showAccountEmail
    expect(v4(true)).toBe(true)
    expect(v4(false)).toBe(false)
  })

  it('leaves a v4 file without the field untouched on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-mig-'))
    const file = join(dir, 'fremkit.json')
    const { privacy: _privacy, ...rest } = migrateConfig(v1)
    const before = JSON.stringify({ ...rest, privacy: { claudeAccountUsage: false } }, null, 2)
    await writeFile(file, before)
    const cfg = await new ConfigStore(file).load()
    expect(cfg.privacy.showAccountEmail).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('never rewrites a file whose value it cannot read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-mig-'))
    const file = join(dir, 'fremkit.json')
    const original = JSON.stringify({ ...migrateConfig(v1), privacy: { claudeAccountUsage: false, showAccountEmail: 'yes' } })
    await writeFile(file, original)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new ConfigStore(file)
    const cfg = await store.load()
    err.mockRestore()
    expect(store.degraded).toBe(true)
    expect(cfg.privacy.showAccountEmail).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(await readdir(dir)).toEqual(['fremkit.json'])
  })
})

describe('renamed stored values', () => {
  const withModel = (model: string) => ({
    version: 2,
    connections: [{ id: 'bambu-1', type: 'bambu', name: 'Imprimante', fields: { host: '192.0.2.10', serial: 'P1', model } }],
    pages: [{ id: 'home', name: 'Accueil', widgets: [] }],
  })

  it('turns a Bambu model of "autre" into "other"', () => {
    // A French word had been written into the user's file, where every other stored value is
    // English. The two mean the same thing to cameraTransport(), so nobody loses a selection.
    const cfg = migrateConfig(withModel('autre'))
    expect(cfg.connections[0].fields.model).toBe('other')
  })

  it('leaves every other model alone', () => {
    for (const model of ['H2C', 'X1C', 'A1 mini', 'other', '']) {
      expect(migrateConfig(withModel(model)).connections[0].fields.model, model).toBe(model)
    }
  })

  it('touches no other type and no other field', () => {
    const cfg = migrateConfig({
      version: 2,
      connections: [{ id: 'gh-1', type: 'github', name: 'GitHub', fields: { host: 'autre' } }],
      pages: [{ id: 'home', name: 'Accueil', widgets: [] }],
    })
    expect(cfg.connections[0].fields.host).toBe('autre')
  })
})

describe('marketplace consent', () => {
  it('is empty in a config written before it existed, and left alone in one that has it', () => {
    const before = migrateConfig({ version: 2, pages: [{ id: 'p', name: 'P', widgets: [] }] })
    expect(before.marketplace).toEqual({ installed: {} })

    const record = {
      version: '1.0.0', registry: 'fremkit-sietch', installedAt: '2026-09-18T12:00:00.000Z',
      consentedPermissions: { subscriptions: ['synology:*'], commands: [], network: [] },
    }
    const kept = migrateConfig({
      version: 2, pages: [{ id: 'p', name: 'P', widgets: [] }],
      marketplace: { installed: { 'synology-storage': record } },
    })
    // `kind` is the one thing added: a record written before themes could be installed can only
    // ever have been a widget, and reading it as one is the whole of that migration.
    // `kind` and `sharedConnections` are what a record written before them reads as: a widget,
    // sharing nothing. Both are defaults rather than a migration step.
    expect(kept.marketplace.installed['synology-storage']).toEqual({ ...record, kind: 'widget', sharedConnections: [] })
  })

  it('reads a record written before themes could be installed as a widget', () => {
    const config = migrateConfig({
      version: 2, pages: [{ id: 'p', name: 'P', widgets: [] }],
      marketplace: { installed: {
        clock: { version: '1.0.0', registry: 'r', installedAt: 'x', consentedPermissions: { subscriptions: [], commands: [], network: [] } },
        nuit: { kind: 'theme', version: '1.0.0', registry: 'r', installedAt: 'x', consentedPermissions: { subscriptions: [], commands: [], network: [] } },
      } },
    })
    expect(config.marketplace.installed.clock.kind).toBe('widget')
    // And one that says what it is keeps saying it.
    expect(config.marketplace.installed.nuit.kind).toBe('theme')
  })

  it('is empty after a v1 migration, which predates the marketplace', () => {
    const v1 = migrateConfig({ display: { cols: 32, rows: 8, cell: 80, autoCycleSeconds: 0 }, pages: [{ id: 'p', name: 'P', widgets: [] }] })
    expect(v1.marketplace).toEqual({ installed: {} })
  })

  it('refuses a record that does not say what was granted', () => {
    expect(() => migrateConfig({
      version: 2, pages: [{ id: 'p', name: 'P', widgets: [] }],
      marketplace: { installed: { demo: { version: '1.0.0', registry: 'r', installedAt: 'x' } } },
    })).toThrow()
  })
})

describe('the Homey connection, v2 → v3', () => {
  /**
   * `homey` was a connection type written into Fremkit, with a provider polling a channel. It did
   * nothing a declaration cannot — one bearer header to a host on the LAN — and it cost the user
   * a second Homey connection, because `homey-flows` already declared its own and a Homey
   * invalidates the previous API key whenever a new one is issued.
   */
  const v2 = (over: Record<string, unknown> = {}) => ({
    version: 2,
    connections: [{ id: 'homey-1', type: 'homey', name: 'Maison', fields: { host: '192.0.2.30' } }],
    pages: [{ id: 'home', name: 'Accueil', widgets: [
      { instanceId: 'hd-1', widgetId: 'homey-devices', x: 0, y: 0, w: 24, h: 8, settings: { connection: 'homey-1', all: true } },
    ] }],
    ...over,
  })

  it('moves the type and leaves everything else where it was', () => {
    const cfg = migrateConfig(v2())
    expect(cfg.version).toBe(4)
    expect(cfg.connections[0]).toMatchObject({
      id: 'homey-1', type: HOMEY_DECLARED_TYPE, name: 'Maison', fields: { host: '192.0.2.30' },
    })
  })

  it('leaves the widget pointing at the same connection', () => {
    // The id is what an instance stores, and it does not change — so nothing has to be re-picked
    // on a dashboard that was already working.
    const cfg = migrateConfig(v2())
    expect(cfg.widgets['hd-1'].settings).toEqual({ connection: 'homey-1', all: true })
  })

  it('touches no other connection', () => {
    const cfg = migrateConfig(v2({
      connections: [
        { id: 'homey-1', type: 'homey', name: 'Maison', fields: { host: '192.0.2.30' } },
        { id: 'gh-1', type: 'github', name: 'GitHub', fields: {} },
        { id: 'flows-1', type: 'decl:homey-flows:homey-flows', name: 'Homey', fields: { host: '192.0.2.30' } },
      ],
    }))
    expect(cfg.connections.map((c) => c.type)).toEqual([
      HOMEY_DECLARED_TYPE, 'github', 'decl:homey-flows:homey-flows',
    ])
  })

  it('is idempotent: a v4 file is already done', () => {
    const once = migrateConfig(v2())
    expect(migrateConfig(once)).toEqual(once)
  })

  it('refuses a version it does not know', () => {
    expect(() => migrateConfig({ version: 5, pages: [{ id: 'p', name: 'P', widgets: [] }] })).toThrow()
  })
})

describe('the Homey key', () => {
  /** A secret store in memory, keyed exactly as the real ones are: `<connectionId>/<field>`. */
  function store(seed: Record<string, string> = {}): SecretStore & { all: Record<string, string> } {
    const all = { ...seed }
    return {
      all,
      get: async (k) => (Object.hasOwn(all, k) ? all[k] : null),
      set: async (k, v) => { all[k] = v },
      delete: async (k) => { delete all[k] },
    }
  }
  const migrated = () => migrateConfig({
    version: 2,
    connections: [{ id: 'homey-1', type: 'homey', name: 'Maison', fields: { host: '192.0.2.30' } }],
    pages: [{ id: 'p', name: 'P', widgets: [] }],
  })

  it('survives the migration under the name the declaration uses', async () => {
    // The coded type called it `apiKey`, the declaration calls it `token`. Without this the user
    // is asked to paste a key that is already on their Mac.
    const secrets = store({ 'homey-1/apiKey': 'abc123' })
    expect(await migrateHomeySecret(migrated(), secrets)).toBe(1)
    expect(secrets.all).toEqual({ 'homey-1/token': 'abc123' })
  })

  it('runs again on every start without doing anything twice', async () => {
    const secrets = store({ 'homey-1/apiKey': 'abc123' })
    const config = migrated()
    await migrateHomeySecret(config, secrets)
    expect(await migrateHomeySecret(config, secrets)).toBe(0)
    expect(secrets.all).toEqual({ 'homey-1/token': 'abc123' })
  })

  it('never overwrites a key that is already there', async () => {
    // A connection created fresh under the declared type, whose key has nothing to do with
    // whatever is left under the old name.
    const secrets = store({ 'homey-1/apiKey': 'old', 'homey-1/token': 'current' })
    expect(await migrateHomeySecret(migrated(), secrets)).toBe(0)
    expect(secrets.all['homey-1/token']).toBe('current')
  })

  it('leaves a connection with no key alone', async () => {
    const secrets = store()
    expect(await migrateHomeySecret(migrated(), secrets)).toBe(0)
    expect(secrets.all).toEqual({})
  })

  it('touches no other connection’s secrets', async () => {
    const secrets = store({ 'homey-1/apiKey': 'abc', 'gh-1/apiKey': 'ghp', 'flows-1/token': 'flow' })
    await migrateHomeySecret(migrateConfig({
      version: 2,
      connections: [
        { id: 'homey-1', type: 'homey', name: 'Maison', fields: { host: '192.0.2.30' } },
        { id: 'gh-1', type: 'github', name: 'GitHub', fields: {} },
      ],
      pages: [{ id: 'p', name: 'P', widgets: [] }],
    }), secrets)
    expect(secrets.all).toEqual({ 'homey-1/token': 'abc', 'gh-1/apiKey': 'ghp', 'flows-1/token': 'flow' })
  })
})

describe('renameCollisions', () => {
  it('keeps the first occurrence and numbers the later ones', () => {
    expect(renameCollisions(['a', 'b', 'a', 'a'])).toEqual(['a', 'b', 'a-2', 'a-3'])
  })
  it('skips a suffix another id already holds, wherever it sits', () => {
    expect(renameCollisions(['a', 'a-2', 'a'])).toEqual(['a', 'a-2', 'a-3'])
    // A later original keeps its id: the rename made before it reaching it never takes it.
    expect(renameCollisions(['a', 'a', 'a-2'])).toEqual(['a', 'a-3', 'a-2'])
  })
  it('stays within the 64 characters an instance id may have', () => {
    const long = 'x'.repeat(64)
    const renamed = renameCollisions([long, long])
    expect(renamed).toEqual([long, 'x'.repeat(62) + '-2'])
    expect(renamed[1]).toHaveLength(64)
  })
  it('changes nothing when every id is unique', () => {
    expect(renameCollisions(['clock-1', 'cpu-1'])).toEqual(['clock-1', 'cpu-1'])
  })
})

describe('v3 → v4', () => {
  /** `data/fremkit.example.json` as it shipped at v3; the file itself is rewritten as v4 later. */
  const example = {
    version: 3,
    display: {
      cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0,
      background: { image: 'fremkit-wallpaper.png', fit: 'cover' },
    },
    connections: [],
    secrets: { backend: 'keychain' },
    locale: 'en',
    pages: [{
      id: 'home', name: 'Home',
      widgets: [{ instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, showTitle: true, appearance: 'panel', settings: {} }],
    }],
  }

  it('migrates the v3 example', () => {
    const c = migrateConfig(example)
    expect(c.version).toBe(4)
    expect(c.theme).toBe('fremkit')
    expect(c.screens).toHaveLength(1)
    const [screen] = c.screens
    expect(screen).toMatchObject({ id: 'edge', name: 'Xeneon Edge', kind: 'edge' })
    expect(screen.display).toEqual({
      cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0,
      background: { image: 'fremkit-wallpaper.png', fit: 'cover' },
    })
    expect('theme' in screen.display).toBe(false)
    expect(screen.nav).toEqual([])
    expect(screen.pages).toEqual([{ id: 'home', name: 'Home', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }] }])
    expect(c.widgets).toEqual({ 'clock-1': { widgetId: 'clock', showTitle: true, settings: {} } })
  })

  it('keeps the named-page style on the Edge screen, and leaves dots absent', () => {
    const named = migrateConfig({ ...example, display: { ...example.display, navStyle: 'names' } })
    expect(named.screens[0].display.navStyle).toBe('names')
    expect('navStyle' in migrateConfig(example).screens[0].display).toBe(false)
    expect(() => migrateConfig({ ...example, display: { ...example.display, navStyle: 'tabs' } })).toThrow()
  })

  it('moves the theme to the top and keeps the rest of the display', () => {
    const c = migrateConfig(realFixture)
    expect(c.theme).toBe('edge')
    expect(c.screens[0].display).toEqual({
      cols: 64, rows: 17, cell: 40, autoCycleSeconds: 30, navHeight: 40, navOpacity: 0.6,
      tileOpacity: 0.8, adminGesture: 'longPress', background: { image: 'fremkit-wallpaper.png', fit: 'cover' },
    })
    // And the rest of the v2/v3 rewrites still happen on the way.
    expect(c.connections.find((x) => x.id === 'bambu-1')?.fields.model).toBe('other')
  })

  it('renders the real fixture identically', () => {
    const v3 = normalizeV3(V3ConfigSchema.parse(structuredClone(realFixture)))
    const c = migrateConfig(realFixture)
    const screen = c.screens.find((s) => s.id === 'edge')!
    expect(screen.pages.map((p) => p.id)).toEqual(v3.pages.map((p) => p.id))
    for (const page of v3.pages) {
      const migrated = screen.pages.find((p) => p.id === page.id)!
      expect(migrated.name).toBe(page.name)
      expect(migrated.items).toHaveLength(page.widgets.length)
      page.widgets.forEach((tile, i) => {
        const { instanceId: _id, x, y, w, h, ...rest } = tile
        const placement = migrated.items[i]
        expect({ x: placement.x, y: placement.y, w: placement.w, h: placement.h }, `${page.id}/${tile.instanceId}`).toEqual({ x, y, w, h })
        expect(c.widgets[placement.instanceId], `${page.id}/${tile.instanceId}`).toEqual(rest)
      })
    }
    const bar = v3.display.navWidgets ?? []
    expect(screen.nav).toHaveLength(bar.length)
    bar.forEach((entry, i) => {
      const item = screen.nav[i]
      expect(item.slot).toBe(entry.slot)
      expect(item.popup).toBe(entry.popup)
      expect(c.widgets[item.instanceId]).toEqual({ widgetId: entry.widgetId, showTitle: true, settings: entry.settings })
    })
    // Nothing lost, nothing invented: one widget per v3 tile and bar entry.
    const tiles = v3.pages.reduce((n, p) => n + p.widgets.length, 0)
    expect(Object.keys(c.widgets)).toHaveLength(tiles + bar.length)
  })

  it('renames the duplicate id on page 3 and the bar', () => {
    const c = migrateConfig(realFixture)
    const [home, work, media] = c.screens[0].pages
    // The first occurrence keeps its id, pages in order, then the bar.
    expect(home.items[0].instanceId).toBe('clock-1')
    expect(media.items[0].instanceId).toBe('clock-1-2')
    expect(work.items[1].instanceId).toBe('battery-1')
    expect(c.screens[0].nav.map((n) => n.instanceId)).toEqual(['battery-1-2', 'cpu-1'])
    // A v3 duplicate was two independent tiles: each keeps its own settings.
    expect(c.widgets['clock-1'].settings.seconds).toBe(false)
    expect(c.widgets['clock-1-2'].settings.seconds).toBe(true)
    expect(c.widgets['clock-1-2'].bgColor).toBe('#123456')
    expect(c.widgets['battery-1'].settings).toEqual({ showPercent: false })
    expect(c.widgets['battery-1'].accentMode).toBe('fill')
    expect(c.widgets['battery-1-2']).toEqual({ widgetId: 'battery', showTitle: true, settings: { showPercent: true } })
  })

  it('keeps opacity and converts appearance before the conversion', () => {
    const c = migrateConfig(realFixture)
    expect(c.widgets['weather-1'].opacity).toBe(0)
    expect(c.widgets['sysmon-1'].opacity).toBe(0.4)
    expect(c.widgets['claude-1']).toMatchObject({ accentMode: 'frame', accentColor: '#d9b36a', title: 'Usage' })
    expect(c.widgets['clock-1'].settings.cities).toEqual([
      { label: 'New York', timezone: 'America/New_York', hour12: false, seconds: false },
      { label: 'Tokyo', timezone: 'Asia/Tokyo', hour12: false, seconds: false },
    ])
    expect(JSON.stringify(c)).not.toMatch(/appearance|accentStyle|navWidgets/)
  })

  it('migrated configs pass validateLayout', () => {
    const navIds = new Set((realFixture.display.navWidgets as { widgetId: string }[]).map((n) => n.widgetId))
    const manifests = new Map<string, LayoutManifest>()
    for (const c of [migrateConfig(realFixture), migrateConfig(example)]) {
      for (const w of Object.values(c.widgets)) {
        manifests.set(w.widgetId, navIds.has(w.widgetId) ? { minSize: [1, 1], compact: { width: 4 } } : { minSize: [1, 1] })
      }
      expect(validateLayout(c, manifests)).toEqual([])
    }
  })

  it('toV4 builds one Edge screen from a parsed v3 config', () => {
    const c = toV4(normalizeV3(V3ConfigSchema.parse(structuredClone(example))))
    expect(c.screens.map((s) => s.id)).toEqual(['edge'])
    expect(c.widgets['clock-1'].widgetId).toBe('clock')
  })
})
