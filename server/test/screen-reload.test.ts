import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { generateToken } from '../src/http/access.js'
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import type { ConfigStore } from '../src/config/store.js'
import { parseScreenReload, SCREEN_RELOAD_CHANNEL, screenReloadRoutes, type ScreenReload } from '../src/config/screen-reload.js'
import { deviceHostView } from '../src/devices/service.js'
import { Hub } from '../src/ws/hub.js'
import { ProviderRegistry } from '../src/providers/registry.js'

const config = (): Config => ({
  ...DEFAULT_CONFIG,
  screens: [
    { ...DEFAULT_CONFIG.screens[0], id: 'edge' },
    { ...DEFAULT_CONFIG.screens[0], id: 'tablet', name: 'Tablet' },
  ],
})

let app: FastifyInstance | undefined
let dir: string | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function routeApp() {
  const sent: { channel: string; data: ScreenReload }[] = []
  app = Fastify()
  const store = { get: () => config() } as unknown as ConfigStore
  await app.register(screenReloadRoutes, { store, notify: (channel, data) => sent.push({ channel, data }), now: () => 1234 })
  return { app, sent }
}

describe('POST /api/screens/:id/reload', () => {
  it('tells the pages of that screen to reload, and keeps nothing', async () => {
    const { app, sent } = await routeApp()
    const res = await app.inject({ method: 'POST', url: '/api/screens/tablet/reload' })
    expect(res.statusCode).toBe(204)
    expect(sent).toEqual([{ channel: SCREEN_RELOAD_CHANNEL, data: { screenId: 'tablet', at: 1234 } }])
  })

  it('answers 404 for a screen that does not exist', async () => {
    const { app, sent } = await routeApp()
    expect((await app.inject({ method: 'POST', url: '/api/screens/nowhere/reload' })).statusCode).toBe(404)
    expect(sent).toEqual([])
  })

  it('answers 404 to a request that is not from this Mac', async () => {
    const { app, sent } = await routeApp()
    const res = await app.inject({ method: 'POST', url: '/api/screens/edge/reload', remoteAddress: '192.0.2.10' })
    expect(res.statusCode).toBe(404)
    expect(sent).toEqual([])
  })

  it('is behind the access secret like every route', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-reload-'))
    await mkdir(join(dir, 'widgets'), { recursive: true })
    await mkdir(join(dir, 'ui'), { recursive: true })
    await writeFile(join(dir, 'ui', 'index.html'), '<!doctype html><title>dash</title>')
    const token = generateToken()
    app = await buildApp({ accessToken: token, port: 4344, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), uiDist: join(dir, 'ui') })
    const host = '127.0.0.1:4344'
    const screenId = (await app.inject({ url: '/api/config', headers: { host, authorization: `Bearer ${token}` } })).json().screens[0].id
    const without = await app.inject({ method: 'POST', url: `/api/screens/${screenId}/reload`, headers: { host } })
    expect(without.statusCode).toBe(401)
    const withSecret = await app.inject({ method: 'POST', url: `/api/screens/${screenId}/reload`, headers: { host, authorization: `Bearer ${token}` } })
    expect(withSecret.statusCode).toBe(204)
  })
})

describe('parseScreenReload', () => {
  it('reads the message and refuses anything else', () => {
    expect(parseScreenReload({ screenId: 'a', at: 1 })).toEqual({ screenId: 'a', at: 1 })
    expect(parseScreenReload({ screenId: 'a', at: 1, extra: 'x' })).toEqual({ screenId: 'a', at: 1 })
    for (const bad of [null, 'a', {}, { screenId: 1, at: 1 }, { screenId: 'a' }]) expect(parseScreenReload(bad)).toBeNull()
  })
})

class FakeSocket extends EventEmitter {
  sent: any[] = []
  send(data: string) { this.sent.push(JSON.parse(data)) }
  receive(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))) }
  close() { this.emit('close') }
}

describe('a screen reload on the hub', () => {
  it('reaches a paired device only for its own screen, every local page, and no later subscriber', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d))
    hub = new Hub(registry)
    const screens: Record<string, string | null> = { 'dev-a': 'tablet', 'dev-b': 'other', 'dev-c': null }
    hub.setPolicy(() => ({ subscriptions: [], commands: [] }))
    hub.setHostView((id, channel, data) => deviceHostView(channel, data, screens[id] ?? null), ['brightness'])
    const sockets: Record<string, FakeSocket> = {}
    for (const id of Object.keys(screens)) {
      sockets[id] = new FakeSocket()
      hub.attach(sockets[id], { loopback: false, paired: true, deviceId: id })
    }
    const local = new FakeSocket()
    hub.attach(local, { loopback: true, paired: false })
    for (const s of [...Object.values(sockets), local]) s.receive({ type: 'subscribe', channel: SCREEN_RELOAD_CHANNEL })

    hub.notify(SCREEN_RELOAD_CHANNEL, { screenId: 'tablet', at: 1 })
    hub.notify(SCREEN_RELOAD_CHANNEL, { screenId: 'edge', at: 2 })

    const msg = (screenId: string, at: number) => ({ type: 'data', channel: SCREEN_RELOAD_CHANNEL, data: { screenId, at } })
    expect(sockets['dev-a'].sent).toEqual([msg('tablet', 1)])
    expect(sockets['dev-b'].sent).toEqual([])
    expect(sockets['dev-c'].sent).toEqual([])
    expect(local.sent).toEqual([msg('tablet', 1), msg('edge', 2)])

    // An event, not a state: a page that subscribes afterwards — the reloaded one — hears nothing.
    const later = new FakeSocket()
    hub.attach(later, { loopback: true, paired: false })
    later.receive({ type: 'subscribe', channel: SCREEN_RELOAD_CHANNEL })
    expect(later.sent).toEqual([])
    registry.stop()
  })

  it('is passed to a device view as the bare message, never anything else', () => {
    expect(deviceHostView(SCREEN_RELOAD_CHANNEL, { screenId: 's', at: 3, extra: 'x' }, 's')).toEqual({ screenId: 's', at: 3 })
    expect(deviceHostView(SCREEN_RELOAD_CHANNEL, { screenId: 's', at: 3 }, 't')).toBeNull()
    expect(deviceHostView(SCREEN_RELOAD_CHANNEL, { screenId: 's', at: 3 }, null)).toBeNull()
    expect(deviceHostView(SCREEN_RELOAD_CHANNEL, 'garbage', 's')).toBeNull()
  })
})
