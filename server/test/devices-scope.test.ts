import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { RemoteListener } from '../src/devices/listener.js'
import { deviceBrightnessView } from '../src/devices/service.js'
import { commandScope, deviceConfigView, iconInScope, instanceInScope, widgetInScope, type ScreenScope } from '../src/devices/scope.js'
import { ConfigSchema, type Config } from '../src/config/schema.js'
import { hasOpenssl, remote, tlsMaterial, TinyWs, upgrade } from './helpers/remote.js'

/**
 * Three screens: the Edge, and two device screens. Each shows its own clock and its own
 * service-status tile, so every cross-screen case has an instance of the right widget to name.
 */
const RAW_CONFIG = {
  version: 4,
  locale: 'en',
  secrets: { backend: 'file' },
  connections: [
    { id: 'ics-b', type: 'ics', name: 'B', fields: {} },
    { id: 'ics-edge', type: 'ics', name: 'Work', fields: {} },
  ],
  widgets: {
    'cal-b': { widgetId: 'cal', settings: { source: 'ics-b' } },
    'cal-edge': { widgetId: 'cal', settings: { source: 'ics-edge' } },
    'sc-b': { widgetId: 'shortcuts', settings: { buttons: [] } },
    'sc-edge': { widgetId: 'shortcuts', settings: { buttons: [] } },
    'clock-edge': { widgetId: 'clock', settings: {} },
    'clock-a': { widgetId: 'clock', settings: {} },
    'clock-b': { widgetId: 'clock', settings: {} },
    'status-edge': { widgetId: 'service-status', settings: { services: [] } },
    'status-a': { widgetId: 'service-status', settings: { services: [] } },
    'status-b': { widgetId: 'service-status', settings: { services: [] } },
    'only-edge': { widgetId: 'edgeonly', settings: {} },
    'docky-b': { widgetId: 'docky', settings: { links: [{ url: 'https://example.com/page' }], image: 'https://example.com/i.png' } },
    'clock-edge-link': { widgetId: 'clock', settings: { url: 'https://example.org/' } },
  },
  screens: [
    { id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16 }, nav: [],
      pages: [{ id: 'p', name: 'P', items: [
        { instanceId: 'clock-edge', x: 0, y: 0, w: 8, h: 4 },
        { instanceId: 'status-edge', x: 8, y: 0, w: 8, h: 4 },
        { instanceId: 'only-edge', x: 16, y: 0, w: 8, h: 4 },
        { instanceId: 'cal-edge', x: 24, y: 0, w: 8, h: 4 },
        { instanceId: 'sc-edge', x: 32, y: 0, w: 8, h: 4 },
        { instanceId: 'clock-edge-link', x: 40, y: 0, w: 8, h: 4 },
      ] }] },
    { id: 'tab-a', name: 'Tablet A', kind: 'device', display: { cols: 34, rows: 23 }, nav: [],
      pages: [{ id: 'p', name: 'P', items: [
        { instanceId: 'clock-a', x: 0, y: 0, w: 8, h: 4 },
        { instanceId: 'status-a', x: 8, y: 0, w: 8, h: 4 },
      ] }] },
    { id: 'tab-b', name: 'Tablet B', kind: 'device', display: { cols: 34, rows: 23 },
      nav: [{ instanceId: 'status-b' }],
      pages: [{ id: 'p', name: 'P', items: [
        { instanceId: 'clock-b', x: 0, y: 0, w: 8, h: 4 },
        { instanceId: 'docky-b', x: 8, y: 0, w: 8, h: 4 },
        { instanceId: 'cal-b', x: 16, y: 0, w: 8, h: 4 },
        { instanceId: 'sc-b', x: 24, y: 0, w: 8, h: 4 },
      ] }] },
  ],
}

const config = (): Config => ConfigSchema.parse(RAW_CONFIG)

describe('screen scope', () => {
  const a: ScreenScope = { kind: 'screen', screenId: 'tab-a' }
  const b: ScreenScope = { kind: 'screen', screenId: 'tab-b' }

  it('lets everything in for this Mac and nothing for a device with no screen', () => {
    expect(instanceInScope(config(), { kind: 'all' }, 'clock-b')).toBe(true)
    expect(instanceInScope(config(), { kind: 'none' }, 'clock-a')).toBe(false)
    expect(widgetInScope(config(), { kind: 'none' }, 'clock')).toBe(false)
  })

  it('narrows a device to the instances on its own screen, its bar included', () => {
    expect(instanceInScope(config(), a, 'clock-a')).toBe(true)
    expect(instanceInScope(config(), a, 'clock-b')).toBe(false)
    expect(instanceInScope(config(), a, 'clock-edge')).toBe(false)
    expect(instanceInScope(config(), b, 'status-b')).toBe(true)
    expect(instanceInScope(config(), b, 'constructor')).toBe(false)
    expect(widgetInScope(config(), a, 'clock')).toBe(true)
    expect(widgetInScope(config(), a, 'edgeonly')).toBe(false)
    expect(widgetInScope(config(), { kind: 'screen', screenId: 'gone' }, 'clock')).toBe(false)
  })

  it('scopes a command by its socket, failing closed', () => {
    const screenOf = (id: string) => (id === 'dev-a' ? 'tab-a' : null)
    expect(commandScope({ loopback: true, paired: false }, screenOf)).toEqual({ kind: 'all' })
    expect(commandScope({ loopback: false, paired: true, deviceId: 'dev-a' }, screenOf)).toEqual(a)
    expect(commandScope({ loopback: false, paired: true, deviceId: 'dev-x' }, screenOf)).toEqual({ kind: 'none' })
    expect(commandScope({ loopback: false, paired: true }, screenOf)).toEqual({ kind: 'none' })
    expect(commandScope({ loopback: false, paired: false }, screenOf)).toEqual({ kind: 'none' })
    expect(commandScope(undefined, screenOf)).toEqual({ kind: 'none' })
    expect(commandScope({ loopback: false, paired: true, deviceId: 'dev-a' }, () => { throw new Error('x') })).toEqual({ kind: 'none' })
  })
})

describe('deviceBrightnessView', () => {
  const snapshot = { kiosk: 'edge', screens: { edge: { value: 40 }, 'tab-a': { value: 70 }, 'tab-b': { value: 10 } } }
  it('keeps the device\'s own screen and hides every other, the Edge included', () => {
    expect(deviceBrightnessView(snapshot, 'tab-a')).toEqual({ kiosk: null, screens: { 'tab-a': { value: 70 } } })
    expect(deviceBrightnessView(snapshot, 'gone')).toEqual({ kiosk: null, screens: {} })
    expect(deviceBrightnessView(snapshot, null)).toBeNull()
    expect(deviceBrightnessView(snapshot, 'constructor')).toEqual({ kiosk: null, screens: {} })
  })
})

describe('iconInScope', () => {
  const b: ScreenScope = { kind: 'screen', screenId: 'tab-b' }
  const at = (raw: string) => new URL(raw)
  it('lets a device fetch only what its screen\'s settings point at', () => {
    // The origin of a link a setting holds, at any depth.
    expect(iconInScope(config(), b, at('https://example.com'), 'https://example.com', false)).toBe(true)
    expect(iconInScope(config(), b, at('https://example.com/other'), 'https://example.com/other', false)).toBe(true)
    // The exact image address only, for `?image=`.
    expect(iconInScope(config(), b, at('https://example.com/i.png'), ' https://example.com/i.png ', true)).toBe(true)
    expect(iconInScope(config(), b, at('https://example.com/j.png'), 'https://example.com/j.png', true)).toBe(false)
    // Another screen's link, an unrelated site, another scheme's origin.
    expect(iconInScope(config(), b, at('https://example.org'), 'https://example.org', false)).toBe(false)
    expect(iconInScope(config(), b, at('https://example.net'), 'https://example.net', false)).toBe(false)
    expect(iconInScope(config(), b, at('http://example.com'), 'http://example.com', false)).toBe(false)
  })
  it('lets this Mac fetch anything and a device with no screen nothing', () => {
    expect(iconInScope(config(), { kind: 'all' }, at('https://example.net'), 'https://example.net', false)).toBe(true)
    expect(iconInScope(config(), { kind: 'none' }, at('https://example.com'), 'https://example.com', false)).toBe(false)
  })
})

describe('deviceConfigView', () => {
  it('keeps its screen, the instances it shows, and what drawing it takes', () => {
    const view = deviceConfigView(config(), 'tab-b')
    expect(Object.keys(view).sort()).toEqual(['labs', 'locale', 'screens', 'theme', 'version', 'widgets'])
    expect(view.screens.map((s) => s.id)).toEqual(['tab-b'])
    expect(Object.keys(view.widgets).sort()).toEqual(['cal-b', 'clock-b', 'docky-b', 'sc-b', 'status-b'])
  })
  it('carries the night theme id so the device follows the night theme, and no coordinates or times', () => {
    const cfg = ConfigSchema.parse({
      ...RAW_CONFIG,
      themeSchedule: { night: 'edge', schedule: 'sun', latitude: 48.85, longitude: 2.35, dayAt: '06:30', nightAt: '22:15' },
    })
    const view = deviceConfigView(cfg, 'tab-b')
    expect(view.themeSchedule).toEqual({ night: 'edge' })
    const text = JSON.stringify(view)
    for (const leak of ['latitude', 'longitude', '48.85', '2.35', 'dayAt', 'nightAt', '06:30', '22:15']) {
      expect(text).not.toContain(leak)
    }
    // No night theme on the Mac: none on the device either.
    expect(Object.hasOwn(deviceConfigView(config(), 'tab-b'), 'themeSchedule')).toBe(false)
  })
  it('carries labs.companion and nothing else of labs', () => {
    for (const companion of [true, false]) {
      const cfg = ConfigSchema.parse({ ...RAW_CONFIG, labs: { devices: true, companion } })
      const view = deviceConfigView(cfg, 'tab-b')
      expect(view.labs).toEqual({ companion })
      expect(Object.keys(view.labs)).toEqual(['companion'])
    }
    // Every key the schema gives `labs`, other than `companion`, stays on the Mac.
    const others = Object.keys(ConfigSchema.parse(RAW_CONFIG).labs).filter((k) => k !== 'companion')
    expect(others.length).toBeGreaterThan(0)
    const view = deviceConfigView(ConfigSchema.parse({ ...RAW_CONFIG, labs: { devices: true, companion: true } }), 'tab-b')
    for (const key of others) expect(Object.hasOwn(view.labs, key), key).toBe(false)
  })
  it('projects or deliberately withholds every top-level config key', () => {
    // A key main adds to the config is dropped from the device view without a word; this makes
    // the next one a decision. Withheld: hosts and accounts, the secrets backend, the privacy
    // switches, the marketplace records and the admin's experimental features are the Mac's own business.
    // `labs` is projected in part: `companion` only (see the next test).
    const projected = ['version', 'theme', 'themeSchedule', 'locale', 'widgets', 'screens', 'labs']
    const withheld = ['connections', 'secrets', 'privacy', 'marketplace']
    expect(Object.keys(ConfigSchema.shape).sort()).toEqual([...projected, ...withheld].sort())
  })
  it('has no screen and no instance for a device with none, or a screen that is gone', () => {
    for (const id of [null, 'gone']) {
      const view = deviceConfigView(config(), id)
      expect(view.screens).toEqual([])
      expect(view.widgets).toEqual({})
    }
  })
})

/** What a device must never read in the config, whatever its screen. */
const MAC_ONLY = ['connections', 'secrets', 'marketplace', 'privacy']

describe.skipIf(!hasOpenssl)('a paired device acts on its own screen only', () => {
  let dir: string
  let app: FastifyInstance
  let listener: RemoteListener
  let port: number
  let tokenA: string
  let tokenNone: string
  let tokenB: string
  const cookie = (t: string): Record<string, string> => ({ cookie: `fremkit_device=${t}` })

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-scope-'))
    const widget = async (id: string, manifest: Record<string, unknown>) => {
      await mkdir(join(dir, 'widgets', id), { recursive: true })
      await writeFile(join(dir, 'widgets', id, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', minSize: [4, 2], defaultSize: [8, 4], ...manifest }))
      await writeFile(join(dir, 'widgets', id, 'index.html'), '<!doctype html><title>w</title>')
    }
    await widget('clock', {})
    await widget('edgeonly', {})
    await widget('docky', { subscriptions: ['dock'] })
    await widget('cal', {
      subscriptions: ['calendar:*'], commands: ['calendar:*'],
      settingsSchema: { source: { type: 'connection', connectionType: 'ics', label: { fr: 'Source', en: 'Source' } } },
    })
    await widget('shortcuts', { commands: ['shortcuts'] })
    await widget('service-status', { commands: ['service-status'], compact: { width: 4 } })
    await mkdir(join(dir, 'data'), { recursive: true })
    await writeFile(join(dir, 'data', 'fremkit.json'), JSON.stringify(RAW_CONFIG))
    app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets') })
    listener = new RemoteListener(app, 0)
    const { key, cert } = await tlsMaterial()
    await listener.start(key, cert)
    port = listener.port
    app.pairing.setRemoteHosts(() => new Set([`127.0.0.1:${port}`]))
    ;({ token: tokenA } = await app.pairing.store.create('iPad A', { width: 1180, height: 820 }, 'tab-a'))
    ;({ token: tokenNone } = await app.pairing.store.create('iPad', { width: 1180, height: 820 }, null))
    ;({ token: tokenB } = await app.pairing.store.create('iPad B', { width: 1180, height: 820 }, 'tab-b'))
  })
  afterAll(async () => {
    await listener?.stop()
    await app?.pairing.store.touch('none')
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  })

  const conn = (token: string, widgetId: string, instanceId: string) => remote(port, {
    method: 'POST', path: `/api/proxy/${widgetId}/conn`,
    headers: { ...cookie(token), 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId, method: 'GET', path: '/x' }),
  })

  it('refuses the proxy on an instance of another screen, and on any instance for a device with no screen', async () => {
    for (const instanceId of ['clock-edge', 'clock-b']) {
      const res = await conn(tokenA, 'clock', instanceId)
      expect(res.status, instanceId).toBe(404)
    }
    for (const instanceId of ['clock-a', 'clock-edge']) {
      expect((await conn(tokenNone, 'clock', instanceId)).status, instanceId).toBe(404)
    }
  })

  it('lets the proxy through on an instance of its own screen', async () => {
    // Past the scope: refused further on, because the fixture's clock declares no connection.
    const res = await conn(tokenA, 'clock', 'clock-a')
    expect(res.status).toBe(403)
  })

  it('refuses the GET proxy for a widget its screen does not show', async () => {
    expect((await remote(port, { path: '/api/proxy/edgeonly', headers: cookie(tokenA) })).status).toBe(404)
    expect((await remote(port, { path: '/api/proxy/clock', headers: cookie(tokenNone) })).status).toBe(404)
    // Its own: past the scope, refused for the missing `url`.
    expect((await remote(port, { path: '/api/proxy/clock', headers: cookie(tokenA) })).status).toBe(400)
  })

  it('leaves the proxy alone for this Mac', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/proxy/clock/conn', payload: { instanceId: 'clock-b', method: 'GET', path: '/x' } })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/proxy/edgeonly' })).statusCode).toBe(400)
  })

  it('reads its own screen of the config, and nothing of the Mac\'s', async () => {
    const own = JSON.parse((await remote(port, { path: '/api/config', headers: cookie(tokenA) })).body)
    for (const key of MAC_ONLY) expect(own, key).not.toHaveProperty(key)
    expect(own.screens.map((s: { id: string }) => s.id)).toEqual(['tab-a'])
    expect(Object.keys(own.widgets).sort()).toEqual(['clock-a', 'status-a'])
    expect(own.locale).toBe('en')
    expect(typeof own.theme).toBe('string')

    const none = JSON.parse((await remote(port, { path: '/api/config', headers: cookie(tokenNone) })).body)
    for (const key of MAC_ONLY) expect(none, key).not.toHaveProperty(key)
    expect(none.screens).toEqual([])
    expect(none.widgets).toEqual({})

    // This Mac still reads all of it.
    const local = (await app.inject({ url: '/api/config' })).json()
    expect(local.screens).toHaveLength(3)
    expect(local).toHaveProperty('connections')
  })

  it('hears its own screen of the config on the WebSocket', async () => {
    const opened = await upgrade(port, { ...cookie(tokenA), origin: `https://127.0.0.1:${port}` })
    if (!('socket' in opened)) throw new Error(`no upgrade: ${opened.status}`)
    const ws = new TinyWs(opened.socket, opened.head)
    try {
      ws.send({ type: 'subscribe', channel: 'config' })
      const msg = await ws.next((m) => m.channel === 'config')
      for (const key of MAC_ONLY) expect(msg.data, key).not.toHaveProperty(key)
      expect(msg.data.screens.map((s: { id: string }) => s.id)).toEqual(['tab-a'])
    } finally {
      ws.close()
    }
  })

  it('reads only the catalogue of its own screen, without scan errors or un-narrowed asks', async () => {
    const res = JSON.parse((await remote(port, { path: '/api/widgets', headers: cookie(tokenA) })).body)
    expect(res.errors).toEqual([])
    expect(res.asks).toEqual({})
    expect(Object.keys(res.widgets).sort()).toEqual(['clock', 'service-status'])
    expect(Object.keys(res.sources).sort()).toEqual(['clock', 'service-status'])
    // Its bar counts: tablet B shows service-status only there.
    const b = JSON.parse((await remote(port, { path: '/api/widgets', headers: cookie(tokenB) })).body)
    expect(Object.keys(b.widgets).sort()).toEqual(['cal', 'clock', 'docky', 'service-status', 'shortcuts'])
    const none = JSON.parse((await remote(port, { path: '/api/widgets', headers: cookie(tokenNone) })).body)
    expect(none.widgets).toEqual({})
    expect(none.sources).toEqual({})
    // This Mac still reads all of it.
    expect(Object.keys((await app.inject({ url: '/api/widgets' })).json().widgets)).toContain('edgeonly')
  })

  it('is refused a favicon its screen does not point at, and every favicon without a screen', async () => {
    const icon = (token: string, query: string) => remote(port, { path: `/api/favicon?${query}`, headers: cookie(token) })
    const q = (k: string, v: string) => `${k}=${encodeURIComponent(v)}`
    // Refused before any lookup or fetch, so nothing here reaches the network.
    expect((await icon(tokenNone, q('url', 'https://example.com'))).status).toBe(403)
    expect((await icon(tokenA, q('url', 'https://example.com'))).status).toBe(403)
    expect((await icon(tokenB, q('url', 'https://example.org'))).status).toBe(403)
    expect((await icon(tokenB, q('url', 'https://example.net/x'))).status).toBe(403)
    expect((await icon(tokenB, q('image', 'https://example.com/j.png'))).status).toBe(403)
  })

  it('is refused app icons on the same terms as the list', async () => {
    const icon = (token: string) => remote(port, { path: '/api/apps/icon/com.example.none', headers: cookie(token) })
    expect((await icon(tokenA)).status).toBe(403)
    expect((await icon(tokenNone)).status).toBe(403)
    // Past the rule: no such application here, so no icon.
    expect((await icon(tokenB)).status).toBe(404)
    expect((await app.inject({ url: '/api/apps/icon/com.example.none' })).statusCode).toBe(404)
  })

  it('is refused the installed applications unless its screen shows a widget that may read them', async () => {
    // Tablet A shows no widget subscribing to `dock`; tablet B does.
    expect((await remote(port, { path: '/api/apps/installed', headers: cookie(tokenA) })).status).toBe(403)
    expect((await remote(port, { path: '/api/apps/installed', headers: cookie(tokenNone) })).status).toBe(403)
    expect((await remote(port, { path: '/api/apps/installed', headers: cookie(tokenB) })).status).not.toBe(403)
  })

  const openWs = async (token: string): Promise<TinyWs> => {
    const opened = await upgrade(port, { ...cookie(token), origin: `https://127.0.0.1:${port}` })
    if (!('socket' in opened)) throw new Error(`no upgrade: ${opened.status}`)
    return new TinyWs(opened.socket, opened.head)
  }
  let seq = 0
  const command = async (ws: TinyWs, channel: string, name: string, payload: unknown) => {
    const id = `c${++seq}`
    ws.send({ type: 'command', id, channel, name, payload })
    const msg = await ws.next((m) => m.id === id)
    // The id is ours; what the device can compare is everything else.
    const { id: _id, ...rest } = msg
    return rest
  }

  it('reaches only the connections its own screen uses on a per-connection channel', async () => {
    const ws = await openWs(tokenB)
    try {
      // Its calendar is bound to ics-b; ics-edge is the Edge's.
      ws.send({ type: 'subscribe', channel: 'calendar:ics-edge' })
      const refused = await ws.next((m) => m.type === 'error')
      expect(refused.id).toBeUndefined()
      // A command on another screen's connection reads exactly like one on a channel that does
      // not exist: nothing to enumerate ids with.
      const other = await command(ws, 'calendar:ics-edge', 'nope', {})
      const unknown = await command(ws, 'calendar:ics-zzzz', 'nope', {})
      const nowhere = await command(ws, 'nowhere:zz', 'nope', {})
      expect(other).toEqual(unknown)
      expect(other).toEqual(nowhere)
      expect(other.type).toBe('error')
      // Its own connection's channel is let through to the provider, which knows no such command.
      const own = await command(ws, 'calendar:ics-b', 'nope', {})
      expect(own).not.toEqual(other)
    } finally {
      ws.close()
    }
  })

  it('presses only the shortcuts of its own screen', async () => {
    const ws = await openWs(tokenB)
    try {
      const edge = await command(ws, 'shortcuts', 'open', { instanceId: 'sc-edge', index: 0 })
      const missing = await command(ws, 'shortcuts', 'open', { instanceId: 'sc-nope', index: 0 })
      expect(edge).toEqual(missing)
      expect(edge.result.ok).toBe(false)
      // Its own instance is found; it has no button 0, so nothing runs either way.
      const own = await command(ws, 'shortcuts', 'open', { instanceId: 'sc-b', index: 0 })
      expect(own.result.ok).toBe(false)
      expect(own).not.toEqual(edge)
    } finally {
      ws.close()
    }
  })

  it('follows the device to another screen over a live socket', async () => {
    const { device, token } = await app.pairing.store.create('Mover', { width: 1180, height: 820 }, 'tab-b')
    const ws = await openWs(token)
    try {
      ws.send({ type: 'subscribe', channel: 'config' })
      const first = await ws.next((m) => m.channel === 'config')
      expect(first.data.screens.map((s: { id: string }) => s.id)).toEqual(['tab-b'])
      ws.send({ type: 'subscribe', channel: 'dock' })
      expect((await conn(token, 'clock', 'clock-b')).status).toBe(403)

      const moved = await app.inject({ method: 'PATCH', url: `/api/devices/${device.id}`, payload: { screenId: 'tab-a' } })
      expect(moved.statusCode).toBe(200)
      const next = await ws.next((m) => m.channel === 'config')
      expect(next.data.screens.map((s: { id: string }) => s.id)).toEqual(['tab-a'])
      expect(Object.keys(next.data.widgets).sort()).toEqual(['clock-a', 'status-a'])
      await ws.next((m) => m.channel === 'device' && m.data?.screenId === 'tab-a')

      // tab-b's instances, channels and connections are gone with it.
      expect((await conn(token, 'clock', 'clock-b')).status).toBe(404)
      expect((await conn(token, 'clock', 'clock-a')).status).toBe(403)
      ws.send({ type: 'subscribe', channel: 'dock' })
      expect((await ws.next((m) => m.type === 'error' && m.id === undefined)).error).toBeTruthy()
      const probe = await command(ws, 'service-status', 'probe', { instanceId: 'status-b' })
      const none = await command(ws, 'service-status', 'probe', { instanceId: 'status-nope' })
      expect(probe).toEqual(none)
      expect((await command(ws, 'calendar:ics-b', 'nope', {})).type).toBe('error')
    } finally {
      ws.close()
    }
  })

  it('resolves a command only against the instances of its own screen', async () => {
    const opened = await upgrade(port, { ...cookie(tokenA), origin: `https://127.0.0.1:${port}` })
    if (!('socket' in opened)) throw new Error(`no upgrade: ${opened.status}`)
    const ws = new TinyWs(opened.socket, opened.head)
    try {
      const probe = async (id: string, instanceId: string) => {
        ws.send({ type: 'command', id, channel: 'service-status', name: 'probe', payload: { instanceId } })
        return ws.next((m) => m.id === id)
      }
      const unknown = (await probe('1', 'status-edge')).result
      expect(unknown.ok).toBe(false)
      expect((await probe('2', 'status-b')).result).toEqual(unknown)
      const own = (await probe('3', 'status-a')).result
      // Its own instance is found: whatever it answers, it is not "unknown instance".
      expect(own).not.toEqual(unknown)
    } finally {
      ws.close()
    }
  })
})
