import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'

/**
 * Demo mode must never construct a real provider: each of them is replaced by a spy that throws,
 * so building a demo app proves none is called, and building a normal one proves the spies are
 * wired (it fails).
 */
const boom = (name: string) => vi.fn(() => { throw new Error(`real provider constructed in demo mode: ${name}`) })
const spies = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>))
function spy(name: string): ReturnType<typeof vi.fn> {
  spies[name] ??= boom(name)
  return spies[name]
}
vi.mock('../src/providers/system.js', async (orig) => ({ ...(await orig<object>()), createSystemProvider: spy('system') }))
vi.mock('../src/claude/providers.js', async (orig) => ({
  ...(await orig<object>()),
  createClaudeSessionsProvider: spy('claude-sessions'),
  createClaudeUsageProvider: spy('claude-usage'),
  createClaudeAccountProvider: spy('claude-account'),
}))
vi.mock('../src/claude/identity.js', async (orig) => ({ ...(await orig<object>()), createClaudeIdentityProvider: spy('claude-identity') }))
vi.mock('../src/providers/codex.js', async (orig) => ({ ...(await orig<object>()), createCodexProvider: spy('codex') }))
vi.mock('../src/dock/provider.js', async (orig) => ({ ...(await orig<object>()), createDockProvider: spy('dock') }))
vi.mock('../src/providers/disk-map.js', async (orig) => ({ ...(await orig<object>()), createDiskMapProvider: spy('disk-map') }))
vi.mock('../src/providers/shortcuts.js', async (orig) => ({ ...(await orig<object>()), createShortcutsProvider: spy('shortcuts') }))
vi.mock('../src/providers/service-status.js', async (orig) => ({ ...(await orig<object>()), createServiceStatusProvider: spy('service-status') }))
vi.mock('../src/brightness/provider.js', async (orig) => ({ ...(await orig<object>()), createBrightnessProvider: spy('brightness') }))
vi.mock('../src/providers/calendar.js', async (orig) => ({ ...(await orig<object>()), createCalendarProvider: spy('calendar') }))
vi.mock('../src/apps/icons.js', async (orig) => ({ ...(await orig<object>()), AppIcons: spy('app-icons') }))
vi.mock('../src/secrets/keychain.js', async (orig) => ({ ...(await orig<object>()), KeychainSecretStore: spy('keychain') }))

const { buildApp } = await import('../src/app.js')
const { createDemoProviders } = await import('../src/demo/providers.js')
const { demoConfig, prepareDemoDataDir, DEMO_MARKER, DemoDataDirError, DEMO_LEAVES_OUT } = await import('../src/demo/seed.js')
const { demoPublicFetch } = await import('../src/demo/fetch.js')
const { demoConnectionFetch } = await import('../src/demo/declared.js')
const { demoConnectionTypes } = await import('../src/demo/connections.js')
const { defaultConnectionTypes } = await import('../src/connections/types/index.js')
const { ConfigSchema } = await import('../src/config/schema.js')
const { errorCode } = await import('../src/providers/registry.js')

const WIDGETS = resolve(import.meta.dirname, '..', '..', 'widgets')
let dir: string
let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function demoApp(): Promise<FastifyInstance> {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-test-'))
  const { dir: dataDir } = await prepareDemoDataDir({ configured: join(dir, 'data'), liveDataDir: join(dir, 'live') })
  return buildApp({ accessToken: null, dataDir, widgetsDir: WIDGETS, demo: true, devicesPort: 0 })
}

/**
 * The built-in widgets' folders. Not a bare readdir: the Finder drops a `.DS_Store` into any
 * folder a person opens, and the main checkout is one.
 */
async function widgetFolders(readdir: typeof import('node:fs/promises').readdir): Promise<string[]> {
  const entries = await readdir(WIDGETS, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !DEMO_LEAVES_OUT.includes(e.name)).map((e) => e.name)
}

describe('demo mode', () => {
  it('builds without constructing a single real provider', async () => {
    app = await demoApp()
    for (const [name, fn] of Object.entries(spies)) expect(fn, name).not.toHaveBeenCalled()
    expect((await app.inject({ url: '/api/demo' })).json()).toEqual({ demo: true })
  })

  it('the spies are live: a normal build trips them', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-test-'))
    await expect(buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: WIDGETS, devicesPort: 0 })).rejects.toThrow(/real provider constructed/)
  })

  it('answers the weather widget through the proxy without the network', async () => {
    app = await demoApp()
    const geo = await app.inject({ url: '/api/proxy/weather?url=' + encodeURIComponent('https://geocoding-api.open-meteo.com/v1/search?name=paris&count=1') })
    expect(geo.statusCode).toBe(200)
    expect(geo.json().results[0].name).toBe('Paris')
    const forecast = await app.inject({ url: '/api/proxy/weather?url=' + encodeURIComponent('https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2') })
    expect(forecast.statusCode).toBe(200)
    expect(typeof forecast.json().current.temperature_2m).toBe('number')
  })

  it('keeps every other host off the wire', async () => {
    const res = await demoPublicFetch()('https://example.com/anything')
    expect(res.status).toBe(503)
  })

  it('publishes on every channel a built-in widget subscribes to, without an error', async () => {
    const config = ConfigSchema.parse(demoConfig())
    const providers = createDemoProviders({ config: () => config })
    const channels = new Set(providers.map((p) => p.channel))
    const { readdir } = await import('node:fs/promises')
    for (const id of await widgetFolders(readdir)) {
      const manifest = JSON.parse(await readFile(join(WIDGETS, id, 'manifest.json'), 'utf8')) as { subscriptions?: string[]; commands?: string[] }
      for (const channel of [...(manifest.subscriptions ?? []), ...(manifest.commands ?? [])]) {
        // `calendar:*` is the calendar connections', answered by the demo connection types.
        if (channel.endsWith(':*')) continue
        expect(channels, `${id} → ${channel}`).toContain(channel)
      }
    }
    for (const p of providers) {
      if (!p.poll) continue
      const data = await p.poll()
      expect(errorCode(data, false), p.channel).toBeNull()
    }
  })

  it('acts commands out on the fake state', async () => {
    const config = ConfigSchema.parse(demoConfig())
    const providers = createDemoProviders({ config: () => config })
    const spotify = providers.find((p) => p.channel === 'spotify')!
    expect(((await spotify.poll!()) as { state: string }).state).toBe('playing')
    await spotify.commands!.playPause({})
    expect(((await spotify.poll!()) as { state: string }).state).toBe('paused')
    const volume = providers.find((p) => p.channel === 'volume')!
    await volume.commands!.set({ level: 12 })
    expect(((await volume.poll!()) as { level: number }).level).toBe(12)
    const messages2FA = providers.find((p) => p.channel === 'messages-2fa')!
    await expect(messages2FA.commands!.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toMatchObject({ ok: false })
    const status = providers.find((p) => p.channel === 'service-status')!
    const probe = await status.commands!.probe({ instanceId: 'service-status-1' }) as { ok: boolean; results: unknown[] }
    expect(probe.ok).toBe(true)
    expect(probe.results).toHaveLength(4)
  })

  it("acts out the Sietch widgets' channels: Codex, local models, MuteDeck", async () => {
    const config = ConfigSchema.parse(demoConfig())
    const providers = createDemoProviders({ config: () => config })
    const poll = async (channel: string): Promise<any> => providers.find((p) => p.channel === channel)!.poll!()
    const codex = await poll('codex')
    expect(codex.quotas.data.buckets[0].primary.usedPercent).toBeGreaterThan(0)
    expect(codex.history.data.threads.length).toBeGreaterThan(1)
    const live = await poll('codex-live')
    // The widget matches a live session to a stored thread by id.
    for (const s of live.sessions) expect(codex.history.data.threads.map((t: { id: string }) => t.id)).toContain(s.id)
    expect((await poll('local-models')).loaded.data.length).toBeGreaterThan(0)
    const mutedeck = providers.find((p) => p.channel === 'mutedeck')!
    expect(await poll('mutedeck')).toMatchObject({ available: true, call: 'active', mute: 'active', video: 'active' })
    await mutedeck.commands!.toggleMute({})
    expect((await poll('mutedeck')).mute).toBe('inactive')
    await mutedeck.commands!.leave({})
    expect((await poll('mutedeck')).call).toBe('inactive')
  })

  it("keeps Codex behind the same privacy switches as the real provider", async () => {
    const config = ConfigSchema.parse({ ...demoConfig(), privacy: { ...demoConfig().privacy, codexAccount: false, codexHistorySources: [] } })
    const providers = createDemoProviders({ config: () => config })
    expect(((await providers.find((p) => p.channel === 'codex')!.poll!()) as { error: string }).error).toBe('unconfigured')
    expect(((await providers.find((p) => p.channel === 'codex-live')!.poll!()) as { error: string }).error).toBe('unconfigured')
  })

  it('publishes a Synology snapshot for the seeded NAS', async () => {
    const synology = demoConnectionTypes(defaultConnectionTypes()).find((t) => t.id === 'synology')!
    const provider = synology.createProvider!({ id: 'demo-nas', channel: 'synology:demo-nas', fields: {} } as never)
    const snap = await provider.poll!() as { error?: string; volumes: unknown[]; disks: unknown[]; cpu: number }
    expect(snap.error).toBeUndefined()
    expect(snap.volumes.length).toBeGreaterThan(0)
    expect(snap.disks.length).toBeGreaterThan(0)
    expect(ConfigSchema.parse(demoConfig()).connections.map((c) => c.type)).toContain('synology')
  })

  it('plays a Homey and a Key Light for the declared connections, and nothing else', async () => {
    const lan = demoConnectionFetch()
    const devices = await (await lan('http://192.0.2.20/api/manager/devices/device')).json() as Record<string, { capabilitiesObj: Record<string, { value: unknown }> }>
    expect(devices['demo-light-floor'].capabilitiesObj.onoff.value).toBe(false)
    await lan('http://192.0.2.20/api/manager/devices/device/demo-light-floor/capability/onoff', { method: 'PUT', body: JSON.stringify({ value: true }) })
    const after = await (await lan('http://192.0.2.20/api/manager/devices/device')).json() as typeof devices
    expect(after['demo-light-floor'].capabilitiesObj.onoff.value).toBe(true)
    expect(Object.keys(await (await lan('http://192.0.2.20/api/manager/flow/flow')).json() as object).length).toBeGreaterThan(2)
    expect((await lan('http://192.0.2.20/api/manager/flow/flow/demo-flow-movie/trigger', { method: 'POST', body: '{}' })).status).toBe(200)
    await lan('http://192.0.2.30:9123/elgato/lights', { method: 'PUT', body: JSON.stringify({ numberOfLights: 1, lights: [{ on: 0, brightness: 60, temperature: 200 }] }) })
    expect((await (await lan('http://192.0.2.30:9123/elgato/lights')).json() as { lights: unknown[] }).lights[0]).toEqual({ on: 0, brightness: 60, temperature: 200 })
    await expect(lan('https://example.com/anything')).rejects.toThrow(/no network/)
  })

  it("answers a declared connection's proxy and Test from the invented devices", async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-test-'))
    const dev = join(dir, 'widgets-dev')
    await mkdir(join(dev, 'lamp'), { recursive: true })
    await writeFile(join(dev, 'lamp', 'index.html'), '<!doctype html><title>lamp</title>')
    await writeFile(join(dev, 'lamp', 'manifest.json'), JSON.stringify({
      id: 'lamp', name: { fr: 'Lampe', en: 'Lamp' }, version: '1.0.0', sdk: 1, minSize: [4, 4], defaultSize: [8, 4],
      connection: {
        name: { fr: 'Lampe', en: 'Lamp' }, kind: 'host', scheme: 'http',
        fields: [{ key: 'host', label: { fr: 'Adresse', en: 'Address' }, required: true }],
        test: { method: 'GET', path: '/elgato/accessory-info', expect: 200 },
        requests: [{ method: 'GET', path: '/elgato/lights' }],
      },
      settingsSchema: { connection: { type: 'connection', connectionType: 'decl:lamp:lamp', label: { fr: 'Lampe', en: 'Lamp' } } },
    }))
    const { dir: dataDir } = await prepareDemoDataDir({ configured: join(dir, 'data'), liveDataDir: join(dir, 'live') })
    app = await buildApp({ accessToken: null, dataDir, widgetsDir: WIDGETS, widgetDevDir: dev, demo: true, devicesPort: 0 })
    const put = await app.inject({ method: 'PUT', url: '/api/connections/demo-lamp', payload: { type: 'decl:lamp:lamp', name: 'Lamp', fields: { host: '192.0.2.30:9123' } } })
    expect(put.statusCode, put.body).toBeLessThan(300)
    expect((await app.inject({ method: 'POST', url: '/api/connections/demo-lamp/test' })).json()).toMatchObject({ ok: true })
    const config = (await app.inject({ url: '/api/config' })).json()
    config.widgets['lamp-1'] = { widgetId: 'lamp', showTitle: false, settings: { connection: 'demo-lamp' } }
    config.screens[0].pages.push({ id: 'lamp', name: 'Lamp', items: [{ instanceId: 'lamp-1', x: 0, y: 0, w: 8, h: 4 }] })
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: config })).statusCode).toBeLessThan(300)
    const res = await app.inject({ method: 'POST', url: '/api/proxy/lamp/conn', payload: { instanceId: 'lamp-1', method: 'GET', path: '/elgato/lights' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().lights[0].on).toBe(1)
  })

  it('seeds a dashboard the config schema accepts, with every built-in on it', async () => {
    const config = ConfigSchema.parse(demoConfig())
    const { readdir } = await import('node:fs/promises')
    const shown = new Set(Object.values(config.widgets).map((w) => w.widgetId))
    for (const id of await widgetFolders(readdir)) expect(shown, id).toContain(id)
    expect(config.secrets.backend).toBe('file')
  })
})

describe('the demo data folder', () => {
  it('is temporary unless named, and carries the marker', async () => {
    const prepared = await prepareDemoDataDir({ liveDataDir: '/nonexistent' })
    try {
      expect(prepared.temporary).toBe(true)
      expect(existsSync(join(prepared.dir, DEMO_MARKER))).toBe(true)
      expect(existsSync(join(prepared.dir, 'fremkit.json'))).toBe(true)
      // The calendars' required address, so the editor does not list them as broken.
      const stored = Object.keys(JSON.parse(await readFile(join(prepared.dir, 'secrets.json'), 'utf8')))
      expect(stored).toContain('demo-work/url')
      expect(stored).toContain('demo-nas/password')
    } finally {
      await rm(prepared.dir, { recursive: true, force: true })
    }
  })

  it('refuses the live folder, and a folder holding a real dashboard', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-test-'))
    await expect(prepareDemoDataDir({ configured: join(dir, 'live'), liveDataDir: join(dir, 'live') })).rejects.toBeInstanceOf(DemoDataDirError)
    await mkdir(join(dir, 'real'))
    await writeFile(join(dir, 'real', 'fremkit.json'), '{}')
    await expect(prepareDemoDataDir({ configured: join(dir, 'real'), liveDataDir: join(dir, 'live') })).rejects.toBeInstanceOf(DemoDataDirError)
    expect(await readFile(join(dir, 'real', 'fremkit.json'), 'utf8')).toBe('{}')
  })

  it('reuses a demo folder as it was left', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-test-'))
    const first = await prepareDemoDataDir({ configured: join(dir, 'd'), liveDataDir: join(dir, 'live') })
    await writeFile(join(first.dir, 'fremkit.json'), '{"edited":true}')
    await prepareDemoDataDir({ configured: join(dir, 'd'), liveDataDir: join(dir, 'live') })
    expect(await readFile(join(first.dir, 'fremkit.json'), 'utf8')).toBe('{"edited":true}')
  })
})
