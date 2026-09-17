import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { FastifyInstance } from 'fastify'
import { Hub } from '../src/ws/hub.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { buildApp } from '../src/app.js'
import { DockState, DOCK_STALE_MS, ICON_MISS_TTL_MS, MAX_ICON_MISSES, MAX_ICONS, normalizeDockApps } from '../src/dock/state.js'
import { createDockProvider } from '../src/dock/provider.js'

/** A 1×1 transparent PNG, the smallest valid icon payload. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const APPS = [
  { bundleId: 'com.example.mail', name: 'Mail', badge: '12', running: true },
  { bundleId: 'com.example.notes', name: 'Notes', badge: null, running: false },
]

describe('normalizeDockApps', () => {
  it('keeps well-formed apps and their order', () => {
    expect(normalizeDockApps(APPS)).toEqual(APPS)
  })

  it('drops an entry with a bad bundle id, a missing name or a non-array payload', () => {
    expect(normalizeDockApps([{ bundleId: '../etc', name: 'x', badge: null, running: true }])).toEqual([])
    expect(normalizeDockApps([{ bundleId: 'com.example.mail', badge: null, running: true }])).toEqual([])
    expect(normalizeDockApps('nope')).toEqual([])
    expect(normalizeDockApps(null)).toEqual([])
  })

  it('coerces a missing or odd badge to null and a missing running flag to false', () => {
    expect(normalizeDockApps([{ bundleId: 'com.example.mail', name: 'Mail', badge: 7 }])).toEqual([
      { bundleId: 'com.example.mail', name: 'Mail', badge: null, running: false },
    ])
  })

  it('caps the list so a rogue payload cannot fill memory', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ bundleId: `com.example.a${i}`, name: 'A', badge: null, running: true }))
    expect(normalizeDockApps(many)).toHaveLength(128)
  })
})

describe('DockState', () => {
  let now = 0
  const make = async () => new DockState({ iconsDir: join(await mkdtemp(join(tmpdir(), 'fremkit-dock-')), 'icons'), now: () => now })

  beforeEach(() => { now = 1_000_000 })

  it('is unavailable until the helper says something', async () => {
    const state = await make()
    expect(state.snapshot()).toEqual({ apps: [], available: false })
  })

  it('becomes available on the first update and stale after ten seconds of silence', async () => {
    const state = await make()
    state.update(APPS)
    expect(state.snapshot()).toEqual({ apps: APPS, available: true })
    now += DOCK_STALE_MS - 1
    expect(state.snapshot().available).toBe(true)
    now += 1
    expect(state.snapshot().available).toBe(false)
    // The apps stay, so the widget dims the row instead of blanking it.
    expect(state.snapshot().apps).toEqual(APPS)
  })

  it('publishes the same payload for a heartbeat that carries the same apps', async () => {
    const state = await make()
    state.update(APPS)
    const first = JSON.stringify(state.snapshot())
    // The helper repeats itself every four seconds; the registry must see no change.
    now += 4_000
    state.update(APPS)
    expect(JSON.stringify(state.snapshot())).toBe(first)
    expect(state.lastUpdatedAt()).toBe(1_004_000)
    // A real change still shows up.
    state.update([{ ...APPS[0], badge: '13' }, APPS[1]])
    expect(JSON.stringify(state.snapshot())).not.toBe(first)
  })

  it('stores an icon on disk and reads it back', async () => {
    const state = await make()
    await state.setIcon('com.example.mail', Buffer.from(PNG_BASE64, 'base64'))
    expect(state.knownIcons()).toEqual(['com.example.mail'])
    expect((await state.getIcon('com.example.mail'))?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await state.getIcon('com.example.notes')).toBeNull()
  })

  it('refuses an icon whose bundle id could escape the folder', async () => {
    const state = await make()
    await expect(state.setIcon('../../etc/passwd', Buffer.from(PNG_BASE64, 'base64'))).rejects.toThrow('identifiant de bundle invalide')
  })

  it('keeps at most 128 icons and ignores a new one past the cap', async () => {
    const state = await make()
    for (let i = 0; i < MAX_ICONS; i++) {
      expect(await state.setIcon(`com.example.a${i}`, Buffer.from(PNG_BASE64, 'base64'))).toBe(true)
    }
    expect(state.knownIcons()).toHaveLength(MAX_ICONS)
    expect(await state.setIcon('com.example.late', Buffer.from(PNG_BASE64, 'base64'))).toBe(false)
    expect(state.knownIcons()).toHaveLength(MAX_ICONS)
    // A bundle already held is refreshed, not refused.
    expect(await state.setIcon('com.example.a0', Buffer.from(PNG_BASE64, 'base64'))).toBe(true)
  })

  it('remembers an unknown icon for a while, and forgets the miss once one lands', async () => {
    const state = await make()
    expect(await state.getIcon('com.example.ghost')).toBeNull()
    // Written behind the cache's back: the miss is still held, so the disk is not consulted.
    await mkdir(join((state as unknown as { iconsDir: string }).iconsDir), { recursive: true })
    await writeFile(join((state as unknown as { iconsDir: string }).iconsDir, 'com.example.ghost.png'), Buffer.from(PNG_BASE64, 'base64'))
    expect(await state.getIcon('com.example.ghost')).toBeNull()
    now += ICON_MISS_TTL_MS + 1
    expect((await state.getIcon('com.example.ghost'))?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('sweeps expired misses and never remembers more than the cap', async () => {
    const state = await make()
    for (let i = 0; i < 10; i += 1) await state.getIcon(`com.example.early${i}`)
    expect(state.missCount()).toBe(10)
    // Past the TTL every earlier miss is swept when the next one is recorded.
    now += ICON_MISS_TTL_MS + 1
    await state.getIcon('com.example.later')
    expect(state.missCount()).toBe(1)
    for (let i = 0; i < MAX_ICON_MISSES + 50; i += 1) await state.getIcon(`com.example.flood${i}`)
    expect(state.missCount()).toBe(MAX_ICON_MISSES)
  })

  it('picks up the icons already on disk at boot', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'fremkit-dock-')), 'icons')
    const first = new DockState({ iconsDir: dir, now: () => now })
    await first.setIcon('com.example.mail', Buffer.from(PNG_BASE64, 'base64'))
    const second = new DockState({ iconsDir: dir, now: () => now })
    await second.loadIcons()
    expect(second.knownIcons()).toEqual(['com.example.mail'])
  })
})

describe('createDockProvider', () => {
  it('publishes the snapshot and activates an app by bundle id', async () => {
    let now = 5
    const state = new DockState({ iconsDir: join(await mkdtemp(join(tmpdir(), 'fremkit-dock-')), 'icons'), now: () => now })
    state.update(APPS)
    const activated: string[] = []
    const provider = createDockProvider(state, { activate: async (b) => { activated.push(b) } })
    expect(provider.channel).toBe('dock')
    expect(await provider.poll!()).toEqual({ apps: APPS, available: true })
    await provider.commands!.activate({ bundleId: 'com.example.mail' }, { loopback: true })
    expect(activated).toEqual(['com.example.mail'])
    await expect(provider.commands!.activate({ bundleId: '../etc' }, { loopback: true })).rejects.toThrow('identifiant de bundle invalide')
  })

  it('refuses activate from a socket that is not on this machine', async () => {
    const state = new DockState({ iconsDir: join(await mkdtemp(join(tmpdir(), 'fremkit-dock-')), 'icons') })
    const activated: string[] = []
    const provider = createDockProvider(state, { activate: async (b) => { activated.push(b) } })
    await expect(provider.commands!.activate({ bundleId: 'com.example.mail' }, { loopback: false }))
      .rejects.toThrow('commande réservée à cette machine')
    // No context at all is treated the same way: fail closed.
    await expect(provider.commands!.activate({ bundleId: 'com.example.mail' }))
      .rejects.toThrow('commande réservée à cette machine')
    expect(activated).toEqual([])
    await provider.commands!.activate({ bundleId: 'com.example.mail' }, { loopback: true })
    expect(activated).toEqual(['com.example.mail'])
  })
})

describe('the hub carries the socket origin into the dock command', () => {
  class FakeSocket extends EventEmitter {
    sent: unknown[] = []
    send(data: string) { this.sent.push(JSON.parse(data)) }
    receive(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))) }
  }

  const setup = async () => {
    const state = new DockState({ iconsDir: join(await mkdtemp(join(tmpdir(), 'fremkit-dock-')), 'icons') })
    const activated: string[] = []
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d))
    registry.register(createDockProvider(state, { activate: async (b) => { activated.push(b) } }))
    hub = new Hub(registry)
    return { hub, activated }
  }

  it('refuses activate from a remote socket and runs it from a local one', async () => {
    const { hub, activated } = await setup()
    const remote = new FakeSocket()
    hub.attach(remote, { loopback: false })
    remote.receive({ type: 'command', id: '1', channel: 'dock', name: 'activate', payload: { bundleId: 'com.example.mail' } })
    await new Promise((r) => setImmediate(r))
    expect(remote.sent).toEqual([{ type: 'error', id: '1', error: 'commande réservée à cette machine' }])
    expect(activated).toEqual([])

    const local = new FakeSocket()
    hub.attach(local, { loopback: true })
    local.receive({ type: 'command', id: '2', channel: 'dock', name: 'activate', payload: { bundleId: 'com.example.mail' } })
    await new Promise((r) => setImmediate(r))
    expect(activated).toEqual(['com.example.mail'])
  })

  it('treats a socket attached without an origin as remote', async () => {
    const { hub, activated } = await setup()
    const unknown = new FakeSocket()
    hub.attach(unknown)
    unknown.receive({ type: 'command', id: '1', channel: 'dock', name: 'activate', payload: { bundleId: 'com.example.mail' } })
    await new Promise((r) => setImmediate(r))
    expect(activated).toEqual([])
  })
})

describe('dock routes', () => {
  let app: FastifyInstance
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'fremkit-dockapp-'))
    await writeFile(join(dataDir, 'fremkit.json'), JSON.stringify({
      version: 2,
      display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
      connections: [], secrets: { backend: 'file' },
      pages: [{ id: 'home', name: 'Accueil', widgets: [] }],
    }), 'utf8')
    app = await buildApp({ dataDir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [], connectionTypes: [] })
  })
  afterEach(async () => { await app.close() })

  it('accepts a dock payload from the loopback and serves the icon back', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/hooks/dock', payload: { apps: APPS } })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: '/api/hooks/dock/icon', payload: { bundleId: 'com.example.mail', png: PNG_BASE64 } })).statusCode).toBe(204)
    const icon = await app.inject({ method: 'GET', url: '/api/apps/icon/com.example.mail' })
    expect(icon.statusCode).toBe(200)
    expect(icon.headers['content-type']).toBe('image/png')
    expect(icon.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect((await app.inject({ method: 'GET', url: '/api/apps/icon/com.example.unknown' })).statusCode).toBe(404)
  })

  it('refuses a request that did not come from this machine', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/hooks/dock', payload: { apps: APPS }, remoteAddress: '203.0.113.7' })
    expect(res.statusCode).toBe(403)
  })

  it('refuses an icon that is not a PNG and one that is too large', async () => {
    const notPng = Buffer.from('hello world').toString('base64')
    expect((await app.inject({ method: 'POST', url: '/api/hooks/dock/icon', payload: { bundleId: 'com.example.mail', png: notPng } })).statusCode).toBe(400)
    const huge = Buffer.alloc(600_000).toString('base64')
    expect((await app.inject({ method: 'POST', url: '/api/hooks/dock/icon', payload: { bundleId: 'com.example.mail', png: huge } })).statusCode).toBe(400)
  })

  it('answers 400 on a payload that is not a dock report', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/hooks/dock', payload: { nope: 1 } })).statusCode).toBe(400)
  })

  it('answers 200 without storing when the icon cache is full', async () => {
    const png = PNG_BASE64
    for (let i = 0; i < 128; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/hooks/dock/icon', payload: { bundleId: `com.example.a${i}`, png } })
      expect(res.statusCode).toBe(204)
    }
    const over = await app.inject({ method: 'POST', url: '/api/hooks/dock/icon', payload: { bundleId: 'com.example.late', png } })
    expect(over.statusCode).toBe(200)
    expect(over.json()).toMatchObject({ ignored: true })
    expect((await app.inject({ method: 'GET', url: '/api/apps/icon/com.example.late' })).statusCode).toBe(404)
  })

  it('refuses a bundle id with a path separator on the icon route', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/apps/icon/..%2F..%2Fetc%2Fpasswd' })).statusCode).toBe(400)
  })
})
