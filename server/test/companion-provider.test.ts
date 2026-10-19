import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import { DeviceStore } from '../src/devices/store.js'
import { CompanionPairing } from '../src/companion/pairing.js'
import { CompanionSession } from '../src/companion/session.js'
import type { ServerMessage, TabMeta } from '../src/companion/protocol.js'
import { createCompanionProvider, type CompanionProvider } from '../src/companion/provider.js'
import { createCompanion } from '../src/companion/index.js'
import { MAX_EXHAUSTED_REQUESTS } from '../src/companion/lock.js'
import { tr } from '../src/i18n.js'
import type { CommandContext } from '../src/providers/types.js'

const META: TabMeta = { title: 'A video', host: 'video.example.com', currentTime: 12, duration: 300, paused: false, muted: false, volume: 1 }
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 2122260223 127.0.0.1 54321 typ host\r\n'
const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const R1 = '00000000-0000-4000-8000-000000000001'
const ORIGIN = 'chrome-extension://lnckeodobpbbmfbdlpnegjpchgkehdlk'
const INSTALL = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4'
const LOCAL: CommandContext = { loopback: true, paired: false }
const PAIRED: CommandContext = { loopback: false, paired: true, deviceId: 'ipad-1' }

/** The Edge with a clock on page 0 and fremplay where `where` says. */
function configWith(where: 'page' | 'bar' | 'nowhere'): Config {
  const edge = DEFAULT_CONFIG.screens[0]
  return {
    ...DEFAULT_CONFIG,
    labs: { devices: false, companion: true },
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
      'play-1': { widgetId: 'fremplay', showTitle: false, settings: {} },
    },
    screens: [{
      ...edge,
      nav: where === 'bar' ? [{ instanceId: 'play-1', slot: 'left' }] : [],
      pages: [
        { id: 'home', name: 'Home', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }] },
        { id: 'video', name: 'Video', items: where === 'page' ? [{ instanceId: 'play-1', x: 0, y: 0, w: 16, h: 8 }] : [] },
      ],
    }],
  }
}

let dir: string
let store: DeviceStore
let pairing: CompanionPairing

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-companion-provider-'))
  store = new DeviceStore(join(dir, 'devices.json'))
  await store.load()
  pairing = new CompanionPairing(store)
})
afterEach(async () => {
  pairing.dispose()
  await rm(dir, { recursive: true, force: true })
})

function setup(where: 'page' | 'bar' | 'nowhere' = 'page') {
  let config = configWith(where)
  const sent: Array<{ to: string; msg: ServerMessage }> = []
  let provider!: CompanionProvider
  const session = new CompanionSession({
    send: (to, msg) => sent.push({ to, msg }),
    changed: () => provider.noteChange(),
    canShare: () => true,
  })
  provider = createCompanionProvider({ session, pairing, config: () => config })
  const start = (device: string, sessionId = S1) => session.onMessage(device, { type: 'tab.started', sessionId, meta: META })
  return { session, provider, sent, start, setConfig: (c: Config) => { config = c } }
}

describe('companion provider', () => {
  it('publishes on the companion channel', () => {
    expect(setup().provider.channel).toBe('companion')
  })

  it('commands are refused for a paired context and without context', async () => {
    const { provider } = setup()
    const payloads: Record<string, unknown> = {
      view: { receiverId: R1, instanceId: 'play-1' },
      answer: { receiverId: R1, instanceId: 'play-1', sdp: SDP },
      leave: { receiverId: R1, instanceId: 'play-1' },
      control: { action: 'toggle', instanceId: 'play-1' },
    }
    for (const [name, payload] of Object.entries(payloads)) {
      const cmd = provider.commands![name]
      await expect(cmd(payload, PAIRED)).rejects.toThrow(/machine/)
      await expect(cmd(payload)).rejects.toThrow(/machine/)
      await expect(cmd(payload, { loopback: false, paired: false })).rejects.toThrow(/machine/)
    }
  })

  it('takes the widget commands from this Mac and hands them to the session', async () => {
    const { provider, sent, start, session } = setup()
    start('ext')
    sent.length = 0
    expect(await provider.commands!.view({ receiverId: R1, instanceId: 'play-1' }, LOCAL)).toEqual({ ok: true })
    expect(sent).toEqual([{ to: 'ext', msg: { type: 'tab.view', receiverId: R1 } }])
    session.onMessage('ext', { type: 'tab.offer', sessionId: S1, receiverId: R1, sdp: SDP })
    expect((await provider.poll!()).tab.offers).toEqual({ [R1]: SDP })
    expect(await provider.commands!.answer({ receiverId: R1, instanceId: 'play-1', sdp: SDP }, LOCAL)).toEqual({ ok: true })
    expect(await provider.commands!.control({ action: 'seek', delta: 10, instanceId: 'play-1' }, LOCAL)).toEqual({ ok: true })
    expect(await provider.commands!.leave({ receiverId: R1, instanceId: 'play-1' }, LOCAL)).toEqual({ ok: true })
    expect(sent.slice(1)).toEqual([
      { to: 'ext', msg: { type: 'tab.answer', receiverId: R1, sdp: SDP } },
      { to: 'ext', msg: { type: 'tab.control', action: 'seek', delta: 10 } },
      { to: 'ext', msg: { type: 'tab.detach', receiverId: R1 } },
    ])
  })

  it('says why a command the session could not carry out did nothing', async () => {
    const { provider } = setup()
    const r = await provider.commands!.control({ action: 'toggle', instanceId: 'play-1' }, LOCAL) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toEqual(expect.any(String))
  })

  it('refuses a payload that is not exactly the command', async () => {
    const { provider } = setup()
    const bad: Array<[string, unknown]> = [
      ['view', { receiverId: R1 }],
      ['view', { receiverId: 'nope', instanceId: 'play-1' }],
      ['view', { receiverId: R1, instanceId: 'play-1', extra: 1 }],
      ['answer', { receiverId: R1, instanceId: 'play-1', sdp: 'x'.repeat(40_000) }],
      ['leave', undefined],
      ['control', { action: 'toggle' }],
      ['control', { action: 'seek', instanceId: 'play-1' }],
      ['control', { action: 'toggle', instanceId: 'play-1', extra: true }],
      ['control', { action: 'explode', instanceId: 'play-1' }],
    ]
    for (const [name, payload] of bad) {
      await expect(provider.commands![name](payload, LOCAL), `${name} ${JSON.stringify(payload)}`).rejects.toThrow()
    }
  })

  it('an accepted share on a page bumps reveal.seq once', async () => {
    const { provider, start, session } = setup('page')
    expect((await provider.poll!()).reveal).toBeNull()
    start('ext')
    expect((await provider.poll!()).reveal).toEqual({ seq: 1, screenId: 'edge', pageIndex: 1 })
    // The same share announced again, its meta, a viewer: still the one share.
    start('ext')
    session.onMessage('ext', { type: 'tab.meta', sessionId: S1, meta: { ...META, currentTime: 20 } })
    session.view(R1, 'play-1')
    expect((await provider.poll!()).reveal).toEqual({ seq: 1, screenId: 'edge', pageIndex: 1 })
    // A new tab is a new share, and the page comes forward again.
    start('ext', S2)
    expect((await provider.poll!()).reveal?.seq).toBe(2)
    // Stopped, then started again: once more.
    session.onMessage('ext', { type: 'tab.stopped', sessionId: S2 })
    expect((await provider.poll!()).reveal?.seq).toBe(2)
    start('ext', S1)
    expect((await provider.poll!()).reveal?.seq).toBe(3)
  })

  it('a share taken back through hello after a restart does not bump reveal.seq', async () => {
    const { provider, start, session } = setup('page')
    const resume = (sessionId: string) => session.onMessage('ext', {
      type: 'hello', token: 'unused-by-the-session', installId: INSTALL, protocol: 2, session: { sessionId, meta: META },
    })
    resume(S1)
    const snap = await provider.poll!()
    expect(snap.tab).toMatchObject({ state: 'sharing', sessionId: S1 })
    expect(snap.reveal).toBeNull()
    // The same share re-announced by a second hello is still the one already on screen.
    resume(S1)
    expect((await provider.poll!()).reveal).toBeNull()
    // A share the user starts afterwards is revealed as usual.
    session.onMessage('ext', { type: 'tab.stopped', sessionId: S1 })
    start('ext', S2)
    expect((await provider.poll!()).reveal).toEqual({ seq: 1, screenId: 'edge', pageIndex: 1 })
  })

  it('a share whose widget sits in the bar reveals no page', async () => {
    const { provider, start } = setup('bar')
    start('ext')
    const snap = await provider.poll!()
    expect(snap.tab.state).toBe('sharing')
    expect(snap.reveal).toBeNull()
  })

  it('reveals the page the widget is on when the share starts', async () => {
    const { provider, start, session, setConfig } = setup('bar')
    start('ext')
    session.onMessage('ext', { type: 'tab.stopped', sessionId: S1 })
    setConfig(configWith('page'))
    start('ext', S2)
    expect((await provider.poll!()).reveal).toEqual({ seq: 1, screenId: 'edge', pageIndex: 1 })
  })

  it('the snapshot carries the pending pairing request', async () => {
    const { provider } = setup()
    expect((await provider.poll!()).pairing).toBeNull()
    const r = pairing.request({ origin: ORIGIN, name: 'Chrome', installId: INSTALL, salt: 'S'.repeat(43) })
    if (typeof r === 'string') throw new Error(r)
    const snap = await provider.poll!()
    expect(snap.pairing).toEqual({ requestId: r.requestId, code: r.code, name: 'Chrome', extension: 'lnckeo', expiresAt: r.expiresAt, turnedAway: 0 })
    // Nothing the extension sent beyond its name and its id's first characters: not its whole
    // origin, not its install id.
    expect(JSON.stringify(snap)).not.toContain(ORIGIN)
    expect(JSON.stringify(snap)).not.toContain(INSTALL)
    expect(snap).toMatchObject({ protocol: 2, extensions: { connected: 0 }, tab: { state: 'idle' } })
  })
})

describe('createCompanion', () => {
  let app: FastifyInstance

  afterEach(async () => { await app?.close() })

  async function build(config: Config = configWith('page'), lockPath?: string) {
    app = Fastify()
    await app.register(fastifyWebsocket)
    const registry = { register: vi.fn(), refresh: vi.fn() }
    const companion = await createCompanion({ app, store, config: { get: () => config }, registry, lockPath })
    await app.ready()
    return { companion, registry }
  }

  it('registers the provider and the routes', async () => {
    const { companion, registry } = await build()
    expect(registry.register).toHaveBeenCalledWith(companion.provider)
    const res = await app.inject({ method: 'POST', url: '/api/companion/pair', headers: { origin: ORIGIN }, payload: { name: 'Chrome', installId: INSTALL, salt: 'S'.repeat(43) } })
    expect(res.statusCode).toBe(200)
    expect(companion.pairing.pending()?.name).toBe('Chrome')
  })

  it('refreshes the channel on every state change', async () => {
    const { companion, registry } = await build()
    registry.refresh.mockClear()
    companion.pairing.request({ origin: ORIGIN, name: 'Chrome', installId: INSTALL, salt: 'S'.repeat(43) })
    expect(registry.refresh).toHaveBeenCalledWith('companion')

    registry.refresh.mockClear()
    companion.session.connect('ext', 'Chrome')
    expect(registry.refresh).toHaveBeenCalledWith('companion')

    // `extensions.paired` follows the device store, connected or not.
    registry.refresh.mockClear()
    await store.createExtension({ name: 'Chrome', origin: ORIGIN, installId: INSTALL })
    expect(registry.refresh).toHaveBeenCalledWith('companion')
    expect((await companion.provider.poll!()).extensions.paired).toBe(1)
  })

  it('lets a share start only when the Edge holds the widget', async () => {
    let config = configWith('nowhere')
    const sent: ServerMessage[] = []
    app = Fastify()
    await app.register(fastifyWebsocket)
    const registry = { register: vi.fn(), refresh: vi.fn() }
    const companion = await createCompanion({ app, store, config: { get: () => config }, registry })
    const send = vi.spyOn(companion.sockets, 'send').mockImplementation((_id, msg) => { sent.push(msg) })
    companion.session.onMessage('ext', { type: 'tab.started', sessionId: S1, meta: META })
    expect(sent).toEqual([{ type: 'tab.refused', sessionId: S1, reason: 'noWidget' }])
    config = configWith('bar')
    companion.session.onMessage('ext', { type: 'tab.started', sessionId: S1, meta: META })
    expect(sent[1]).toEqual({ type: 'tab.accepted', sessionId: S1 })
    send.mockRestore()
  })

  it('ends the share when labs.companion goes off, and refuses one until it is back on', async () => {
    let config = configWith('page')
    const listeners: Array<(c: Config) => void> = []
    const sent: ServerMessage[] = []
    app = Fastify()
    await app.register(fastifyWebsocket)
    const registry = { register: vi.fn(), refresh: vi.fn() }
    const companion = await createCompanion({
      app, store, registry,
      config: { get: () => config, onChange: (cb) => { listeners.push(cb); return () => undefined } },
    })
    const set = (next: Config) => { config = next; for (const cb of listeners) cb(next) }
    const send = vi.spyOn(companion.sockets, 'send').mockImplementation((_id, msg) => { sent.push(msg) })
    companion.session.connect('ext', 'Chrome')
    companion.session.onMessage('ext', { type: 'tab.started', sessionId: S1, meta: META })
    expect(companion.session.snapshot().tab.state).toBe('sharing')
    sent.length = 0
    set({ ...configWith('page'), labs: { devices: false, companion: false } } as Config)
    expect(sent).toEqual([
      { type: 'ready', protocol: 2, modules: { fremplay: false } },
      { type: 'tab.refused', sessionId: S1, reason: 'disabled' },
    ])
    expect(companion.session.snapshot().tab.state).toBe('idle')
    // Another save with the switch still off says nothing more.
    sent.length = 0
    set({ ...configWith('page'), labs: { devices: true, companion: false } } as Config)
    expect(sent).toEqual([])
    companion.session.onMessage('ext', { type: 'tab.started', sessionId: S1, meta: META })
    expect(sent).toEqual([{ type: 'tab.refused', sessionId: S1, reason: 'disabled' }])
    set(configWith('page'))
    companion.session.onMessage('ext', { type: 'tab.started', sessionId: S1, meta: META })
    expect(sent.at(-1)).toEqual({ type: 'tab.accepted', sessionId: S1 })
    send.mockRestore()
  })

  it('stops listening once closed', async () => {
    const { companion, registry } = await build()
    await app.close()
    registry.refresh.mockClear()
    await store.createExtension({ name: 'Chrome', origin: ORIGIN, installId: INSTALL })
    companion.pairing.request({ origin: ORIGIN, name: 'Chrome', installId: INSTALL, salt: 'S'.repeat(43) })
    expect(registry.refresh).not.toHaveBeenCalled()
  })

  const ask = (installId: string = INSTALL) => app.inject({
    method: 'POST', url: '/api/companion/pair', headers: { origin: ORIGIN },
    payload: { name: 'Chrome', installId, salt: 'S'.repeat(43) },
  })

  it('refuses a request with 409 while labs.companion is off, with an extension paired or not', async () => {
    const off = { ...configWith('page'), labs: { devices: false, companion: false } } as Config
    await build(off)
    const res = await ask()
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: tr(off.locale, 'companion.disabled'), reason: 'disabled' })
    // Off is Fremplay off: an extension already paired is refused too (it stays in Devices).
    await store.createExtension({ name: 'Chrome', origin: ORIGIN, installId: INSTALL })
    const again = await ask()
    expect(again.statusCode).toBe(409)
    expect(again.json().reason).toBe('disabled')
    expect(store.list().filter((d) => d.kind === 'extension')).toHaveLength(1)
  })

  it('locks pairing after five requests refused for wrong codes, across a restart, until unlocked', async () => {
    const lockPath = join(dir, 'companion-lock.json')
    const { companion } = await build(configWith('page'), lockPath)
    for (let i = 0; i < MAX_EXHAUSTED_REQUESTS; i++) {
      const res = await ask(`6f1c2b8e-3d4a-4b5c-9d6e-${String(i).padStart(12, '0')}`)
      expect(res.statusCode, String(i)).toBe(200)
      const { requestId } = res.json()
      for (let n = 0; n < 3; n++) await companion.pairing.confirm(requestId, ORIGIN, 'N'.repeat(43), 'A'.repeat(43))
    }
    expect(companion.pairing.locked).toBe(true)
    const locked = await ask()
    expect(locked.statusCode).toBe(423)
    expect(locked.json()).toEqual({ error: tr(configWith('page').locale, 'companion.pairLocked'), reason: 'locked' })
    // A restart reads the flag back.
    await app.close()
    const again = await build(configWith('page'), lockPath)
    expect(again.companion.pairing.locked).toBe(true)
    expect((await ask()).statusCode).toBe(423)
    // Settings → Devices' Unlock pairing.
    expect((await app.inject({ method: 'POST', url: '/api/companion/unlock' })).statusCode).toBe(200)
    expect(again.companion.pairing.locked).toBe(false)
    expect((await ask()).statusCode).toBe(200)
    await app.close()
    expect((await build(configWith('page'), lockPath)).companion.pairing.locked).toBe(false)
  })
})
