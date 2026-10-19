import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { FREMPLAY_WIDGET_ID } from '../src/companion/placement.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'

/**
 * The Fremplay widget: its manifest as the catalogue reads it, and `widgets/fremplay/logic.js`,
 * the pure half of the page — which state a snapshot puts on screen, and what the receiver does
 * next. The WebRTC half cannot run here; this is everything it decides with.
 */
const SHIPPED = fileURLToPath(new URL('../../widgets', import.meta.url))

interface Local {
  receiverId: string; sessionId: string | null; viewed: boolean; pending: boolean; live: boolean; connected: boolean
  lastOffer: string | null; hidden: boolean
}
interface Plan { hold: boolean; reset: boolean; view: boolean; answer: string | null; refused?: boolean }
interface Logic {
  stateOf(snapshot: unknown): string | null
  plan(snapshot: unknown, local: Local): Plan
  clock(seconds: unknown): string
  stepVolume(volume: unknown, step: number): number
  MAC_STEP: number
  volumeTarget(setting: unknown, volume: unknown): string
  stepLevel(level: unknown, step: number): number
  onMac(Peer: unknown): boolean
}

async function loadLogic(): Promise<Logic> {
  const src = await readFile(fileURLToPath(new URL('../../widgets/fremplay/logic.js', import.meta.url)), 'utf8')
  const scope: Record<string, unknown> = {}
  new Function('globalThis', src)(scope)
  expect(Object.keys(scope)).toEqual(['FremkitFremplay'])
  return scope.FremkitFremplay as Logic
}

const RECEIVER = '5b1f7c1e-8d4e-4b8a-9c39-0a6f2c1d7e01'
const OTHER = '9a0d3e44-3c1b-4f7e-8a2b-1f5e6d7c8b90'

function snap(over: { protocol?: number; paired?: number; connected?: number; tab?: Record<string, unknown> } = {}) {
  return {
    protocol: over.protocol ?? 2,
    extensions: { connected: over.connected ?? 1, paired: over.paired ?? 1 },
    tab: { state: 'idle', sessionId: null, device: null, meta: null, offers: {}, ...over.tab },
    pairing: null,
    reveal: null,
  }
}
const sharing = (sessionId: string, offers: Record<string, string> = {}, receivers?: string[]) =>
  snap({ tab: { state: 'sharing', sessionId, offers, ...(receivers ? { receivers } : {}), meta: { title: 'A film', host: 'video.example.com', currentTime: 0, duration: 60, paused: false, muted: true, volume: 1 } } })
const fresh = (over: Partial<Local> = {}): Local =>
  ({ receiverId: RECEIVER, sessionId: null, viewed: false, pending: false, live: false, connected: false, lastOffer: null, hidden: false, ...over })

describe('the fremplay manifest', () => {
  it('the fremplay manifest subscribes to and commands companion and volume, with its fit and volume settings', async () => {
    const cat = new WidgetCatalog(SHIPPED)
    await cat.scan()
    expect(cat.errors.filter((e) => e.id === 'fremplay')).toEqual([])
    const entry = cat.entry('fremplay')!
    expect(entry.source).toBe('builtin')
    const m = entry.manifest
    expect(m.id).toBe(FREMPLAY_WIDGET_ID)
    expect(m.name).toEqual({ fr: 'Fremplay', en: 'Fremplay' })
    expect(m.description).toEqual({ fr: expect.any(String), en: expect.any(String) })
    expect(m.subscriptions).toEqual(['companion', 'volume'])
    expect(m.commands).toEqual(['companion', 'volume'])
    expect(m.compact).toBeDefined()
    const fit = m.settingsSchema.fit as { type: string; default: unknown; options: { value: string }[] }
    expect(fit.type).toBe('enum')
    expect(fit.default).toBe('contain')
    expect(fit.options.map((o) => o.value)).toEqual(['contain', 'cover'])
    const target = m.settingsSchema.volumeTarget as { type: string; default: unknown; label: unknown; options: { value: string; label: unknown }[] }
    expect(target.type).toBe('enum')
    expect(target.default).toBe('mac')
    expect(target.label).toEqual({ fr: 'Boutons de volume', en: 'Volume buttons' })
    expect(target.options).toEqual([
      { value: 'mac', label: { fr: 'Mac', en: 'Mac' } },
      { value: 'video', label: { fr: 'Vidéo', en: 'Video' } },
    ])
  })

  it('loads its pure half from its own folder, before the script that uses it', async () => {
    const html = await readFile(fileURLToPath(new URL('../../widgets/fremplay/index.html', import.meta.url)), 'utf8')
    expect(html.indexOf('<script src="logic.js"></script>')).toBeGreaterThan(-1)
    expect(html.indexOf('<script src="logic.js"></script>')).toBeLessThan(html.indexOf('FremkitFremplay.'))
    // The receiver as the spike proved it: no ICE server, a muted inline video.
    expect(html).toContain('new RTCPeerConnection({ iceServers: [] })')
    expect(html).toMatch(/<video[^>]*\bmuted\b[^>]*>/)
    expect(html).toMatch(/<video[^>]*\bplaysinline\b[^>]*>/)
    expect(html).toMatch(/<video[^>]*\bautoplay\b[^>]*>/)
  })
})

describe('the fremplay page as served', () => {
  it('gets the bridge first, at WebRTC\'s local level, with this Mac\'s addresses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-fremplay-'))
    const app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: SHIPPED })
    try {
      const res = await app.inject({ url: '/widgets/fremplay/index.html' })
      expect(res.statusCode).toBe(200)
      expect(res.body).toMatch(/^<!doctype html><script src="\/fremkit\.js" data-webrtc="local" data-webrtc-hosts="[0-9a-f.: ]*"><\/script>/)
      expect(res.body).toContain('127.0.0.1')
      // Its own markup never loads the bridge a second time.
      expect(res.body.split('/fremkit.js').length).toBe(2)
      // Every other built-in stays at `none`.
      expect((await app.inject({ url: '/widgets/clock/index.html' })).body).not.toContain('data-webrtc')
    } finally {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('fremplay/logic.js stateOf', () => {
  it('waits for a first snapshot rather than guessing', async () => {
    const { stateOf } = await loadLogic()
    expect(stateOf(undefined)).toBeNull()
    expect(stateOf(null)).toBeNull()
  })

  it('reads each state the spec names', async () => {
    const { stateOf } = await loadLogic()
    expect(stateOf(snap({ paired: 0, connected: 0 }))).toBe('unpaired')
    expect(stateOf(snap({ paired: 1, connected: 0 }))).toBe('offline')
    expect(stateOf(snap())).toBe('idle')
    expect(stateOf(sharing('s1'))).toBe('sharing')
  })

  it('says the protocol differs before anything else', async () => {
    const { stateOf } = await loadLogic()
    expect(stateOf({ ...sharing('s1'), protocol: 3 })).toBe('protocol')
    expect(stateOf({ ...snap({ paired: 0 }), protocol: 0 })).toBe('protocol')
  })

  it('keeps showing a share whose extension dropped its socket, since the share outlives it', async () => {
    const { stateOf } = await loadLogic()
    expect(stateOf({ ...sharing('s1'), extensions: { paired: 1, connected: 0 } })).toBe('sharing')
  })
})

describe('fremplay/logic.js plan', () => {
  it('asks to view once a share appears', async () => {
    const { plan } = await loadLogic()
    expect(plan(sharing('s1'), fresh())).toEqual({ hold: false, reset: true, view: true, answer: null })
    expect(plan(sharing('s1'), fresh({ sessionId: 's1', viewed: true }))).toEqual({ hold: false, reset: false, view: false, answer: null })
  })

  it('answers its own offer once, never another receiver’s', async () => {
    const { plan } = await loadLogic()
    const local = fresh({ sessionId: 's1', viewed: true })
    expect(plan(sharing('s1', { [OTHER]: 'v=0 theirs' }), local).answer).toBeNull()
    expect(plan(sharing('s1', { [RECEIVER]: 'v=0 mine' }), local).answer).toBe('v=0 mine')
    expect(plan(sharing('s1', { [RECEIVER]: 'v=0 mine' }), { ...local, lastOffer: 'v=0 mine', live: true }))
      .toEqual({ hold: false, reset: false, view: false, answer: null })
  })

  it('answers a new offer for the same receiver, which is the extension starting over', async () => {
    const { plan } = await loadLogic()
    const local = fresh({ sessionId: 's1', viewed: true, live: true, lastOffer: 'v=0 first' })
    expect(plan(sharing('s1', { [RECEIVER]: 'v=0 second' }), local).answer).toBe('v=0 second')
  })

  it('views again after its peer died, without answering the dead offer twice', async () => {
    const { plan } = await loadLogic()
    const local = fresh({ sessionId: 's1', viewed: false, live: false, lastOffer: 'v=0 dead' })
    expect(plan(sharing('s1', { [RECEIVER]: 'v=0 dead' }), local)).toEqual({ hold: false, reset: false, view: true, answer: null })
  })

  it('starts over when the share changes, forgetting the last offer', async () => {
    const { plan } = await loadLogic()
    const local = fresh({ sessionId: 's1', viewed: true, live: true, lastOffer: 'v=0 old' })
    // The session re-asks every receiver it knows on a direct switch: no view from here…
    expect(plan(sharing('s2', {}, [RECEIVER]), local)).toEqual({ hold: false, reset: true, view: false, answer: null })
    // …unless it does not know this one.
    expect(plan(sharing('s2', {}, [OTHER]), local)).toEqual({ hold: false, reset: true, view: true, answer: null })
    // A frame that was in no share views as usual.
    expect(plan(sharing('s2', {}, []), fresh())).toEqual({ hold: false, reset: true, view: true, answer: null })
    // The old offer text cannot be told from a new one by the server, so it is answered.
    expect(plan(sharing('s2', { [RECEIVER]: 'v=0 old' }), local)).toEqual({ hold: false, reset: true, view: false, answer: 'v=0 old' })
  })

  it('holds a connected peer through a snapshot without the share, and only that', async () => {
    const { plan } = await loadLogic()
    const local = fresh({ sessionId: 's1', viewed: true, live: true, connected: true })
    expect(plan(snap({ connected: 0 }), local)).toEqual({ hold: true, reset: false, view: false, answer: null })
    expect(plan(snap({ connected: 0 }), { ...local, connected: false })).toEqual({ hold: false, reset: true, view: false, answer: null })
  })

  it('views again with the same id when the server does not list it, once', async () => {
    const { plan } = await loadLogic()
    const local = fresh({ sessionId: 's1', viewed: true, live: true, connected: true, lastOffer: 'v=0 x' })
    expect(plan(sharing('s1', {}, []), local)).toEqual({ hold: false, reset: false, view: true, answer: null })
    expect(plan(sharing('s1', {}, []), { ...local, pending: true }).view).toBe(false)
    expect(plan(sharing('s1', {}, [RECEIVER]), local).view).toBe(false)
  })

  it('does nothing while hidden but notice the share ended', async () => {
    const { plan } = await loadLogic()
    expect(plan(sharing('s1', { [RECEIVER]: 'v=0 x' }), fresh({ hidden: true }))).toEqual({ hold: false, reset: true, view: false, answer: null })
    expect(plan(snap(), fresh({ sessionId: 's1', viewed: true, live: true }))).toEqual({ hold: false, reset: true, view: false, answer: null })
    expect(plan(snap(), fresh())).toEqual({ hold: false, reset: false, view: false, answer: null })
  })

  it('neither answers nor views once the server lists its receiver as refused', async () => {
    const { plan } = await loadLogic()
    const refused = (offers: Record<string, string> = {}) =>
      ({ ...sharing('s1', offers, [RECEIVER]), tab: { ...sharing('s1', offers, [RECEIVER]).tab, refused: [RECEIVER] } })
    const local = fresh({ sessionId: 's1', viewed: true })
    expect(plan(refused(), local)).toEqual({ hold: false, reset: false, view: false, answer: null, refused: true })
    expect(plan(refused({ [RECEIVER]: 'v=0 x' }), fresh({ sessionId: 's1' }))).toEqual({ hold: false, reset: false, view: false, answer: null, refused: true })
    // Another receiver's refusal is not this one's.
    const theirs = { ...sharing('s1', {}, [RECEIVER]), tab: { ...sharing('s1', {}, [RECEIVER]).tab, refused: [OTHER] } }
    expect(plan(theirs, fresh({ sessionId: 's1' })).refused).toBeUndefined()
  })

  it('never views under a protocol it does not speak', async () => {
    const { plan } = await loadLogic()
    expect(plan({ ...sharing('s1'), protocol: 3 }, fresh()).view).toBe(false)
  })
})

const SESSION_FOR_DEVICE = '3c2b1a09-8f7e-4d6c-9b5a-0e1f2d3c4b5a'

describe('fremplay on a paired device', () => {
  it('tells this Mac\'s frame from a device\'s by the peer connection the bridge left it', async () => {
    const FP = await loadLogic()
    // WebRTC at `local`: the bridge's guarded constructor.
    expect(FP.onMac(function RTCPeerConnection() {})).toBe(true)
    // At `none` (every remote request), the bridge locks it to undefined.
    expect(FP.onMac(undefined)).toBe(false)
    expect(FP.onMac(null)).toBe(false)
  })

  it('shows only that sentence on a device, and neither subscribes nor asks for anything', async () => {
    const page = await loadPage({ noPeer: true })
    expect(page.nodes.get('line')!.textContent).toBe("Fremplay ne s'affiche que sur l'Edge du Mac.")
    expect(page.stage.classes.has('elsewhere')).toBe(true)
    expect(page.subscribed).toEqual([])
    page.publish(sharing(SESSION_FOR_DEVICE, { [RECEIVER]: 'v=0' }))
    await page.settle()
    expect(page.commands).toEqual([])
    expect(page.peers).toEqual([])
  })

  it('says where it shows, in both languages, before subscribing to anything', async () => {
    const html = await readFile(fileURLToPath(new URL('../../widgets/fremplay/index.html', import.meta.url)), 'utf8')
    expect(html).toContain("elsewhere: { fr: 'Fremplay ne s\\'affiche que sur l\\'Edge du Mac.', en: 'Fremplay only shows on the Mac\\'s Edge.' }")
    const check = html.indexOf('if (!FP.onMac(')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(html.indexOf("Fremkit.subscribe('companion'"))
  })

  it('is served to a remote request without WebRTC\'s local level', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-fremplay-remote-'))
    const app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: SHIPPED })
    try {
      const { markRemoteSocket } = await import('../src/net/remote.js')
      app.addHook('onRequest', async (req) => { if (req.headers['x-test-remote'] === '1') markRemoteSocket(req.socket) })
      const res = await app.inject({ url: '/widgets/fremplay/index.html', headers: { 'x-test-remote': '1' } })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain('data-webrtc')
    } finally {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('fremplay/logic.js helpers', () => {
  it('writes a position as m:ss, or h:mm:ss past an hour', async () => {
    const { clock } = await loadLogic()
    expect(clock(0)).toBe('0:00')
    expect(clock(83.9)).toBe('1:23')
    expect(clock(3723)).toBe('1:02:03')
    expect(clock(Number.NaN)).toBe('0:00')
    expect(clock(-5)).toBe('0:00')
  })

  it('steps the volume by a tenth, inside 0..1, without float dust', async () => {
    const { stepVolume } = await loadLogic()
    expect(stepVolume(0.7, 0.1)).toBe(0.8)
    expect(stepVolume(0.95, 0.1)).toBe(1)
    expect(stepVolume(0.05, -0.1)).toBe(0)
    expect(stepVolume(0.3, -0.1)).toBe(0.2)
    expect(stepVolume(undefined, 0.1)).toBe(1)
  })

  it('drives the Mac by default, and the video when asked or when the Mac cannot be read', async () => {
    const { volumeTarget } = await loadLogic()
    expect(volumeTarget(undefined, { level: 40, muted: false })).toBe('mac')
    expect(volumeTarget('mac', { level: 40, muted: false })).toBe('mac')
    expect(volumeTarget('video', { level: 40, muted: false })).toBe('video')
    expect(volumeTarget('mac', null)).toBe('video')
    expect(volumeTarget('mac', { level: 40, muted: false, error: 'offline' })).toBe('video')
    expect(volumeTarget('mac', { muted: false })).toBe('video')
  })

  it('steps the Mac level by the volume widget\'s notch, inside 0..100', async () => {
    const { stepLevel, MAC_STEP } = await loadLogic()
    expect(MAC_STEP).toBe(5)
    expect(stepLevel(40, 5)).toBe(45)
    expect(stepLevel(98, 5)).toBe(100)
    expect(stepLevel(3, -5)).toBe(0)
    expect(stepLevel(undefined, 5)).toBe(5)
  })
})

/**
 * The page run for real against stubs: the host's bridge, the DOM nodes it touches and a
 * `RTCPeerConnection` that answers at once. What is checked is what the page says and what it
 * sends on `companion` — the media itself is Task 12's live check.
 */
interface StubNode {
  textContent: string; innerHTML: string; hidden: boolean; disabled: boolean
  dataset: Record<string, string>; attrs: Record<string, string>; classes: Set<string>
  srcObject: unknown
}

interface Page {
  nodes: Map<string, StubNode>
  buttons: Record<string, StubNode>
  stage: StubNode
  commands: [string, Record<string, unknown>][]
  /** What the page sent on `volume`. */
  volumeCommands: [string, Record<string, unknown>][]
  peers: { closed: boolean; remote: unknown; connectionState: string; onconnectionstatechange: unknown }[]
  publish(data: unknown): void
  publishVolume(data: unknown): void
  /** Lets the page's promise chains run. */
  settle(): Promise<void>
  tap(target?: StubNode): void
  setVisibility(state: 'visible' | 'hidden'): void
  fire(id: string, type: string): void
  reply: { view: unknown }
  /** The channels the page subscribed to. */
  subscribed: string[]
}

async function loadPage(opts: { compact?: boolean; settings?: Record<string, unknown>; noPeer?: boolean } = {}): Promise<Page> {
  const html = await readFile(fileURLToPath(new URL('../../widgets/fremplay/index.html', import.meta.url)), 'utf8')
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
  const logic = await loadLogic()

  const listeners = new Map<string, ((e: unknown) => void)[]>()
  const on = (key: string) => (type: string, fn: (e: unknown) => void) => {
    listeners.set(key + ':' + type, [...(listeners.get(key + ':' + type) ?? []), fn])
  }
  const node = (key: string): StubNode & Record<string, unknown> => {
    const classes = new Set<string>()
    const self = {
      textContent: '', innerHTML: '', hidden: false, disabled: false, srcObject: null as unknown,
      dataset: {} as Record<string, string>, attrs: {} as Record<string, string>, classes,
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        contains: (c: string) => classes.has(c),
        toggle: (c: string, force?: boolean) => {
          const want = force ?? !classes.has(c)
          if (want) classes.add(c); else classes.delete(c)
          return want
        },
      },
      setAttribute: (k: string, v: string) => { self.attrs[k] = v },
      addEventListener: on(key),
      play: () => Promise.resolve(),
      closest: (sel: string) => (sel === 'button' && self.dataset.a ? self : null),
    }
    return self
  }
  const nodes = new Map<string, ReturnType<typeof node>>()
  const byId = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, node(id))
    return nodes.get(id)!
  }
  const buttons: Record<string, ReturnType<typeof node>> = {}
  for (const a of ['back', 'toggle', 'fwd', 'voldown', 'volup', 'mute', 'fill', 'show', 'stop']) {
    buttons[a] = node('button-' + a)
    buttons[a].dataset.a = a
  }
  let visibility: 'visible' | 'hidden' = 'visible'
  const document = {
    get visibilityState() { return visibility },
    documentElement: { classList: { add: () => {}, remove: () => {} } },
    getElementById: byId,
    querySelectorAll: (sel: string) => (sel === '#controls button' ? Object.values(buttons) : []),
    addEventListener: on('document'),
  }
  const window = { addEventListener: on('window') }

  const commands: [string, Record<string, unknown>][] = []
  const reply: Page['reply'] = { view: { ok: true } }
  const subscribers: ((data: unknown) => void)[] = []
  const volumeSubscribers: ((data: unknown) => void)[] = []
  const volumeCommands: [string, Record<string, unknown>][] = []
  const subscribed: string[] = []
  const Fremkit = {
    settings: opts.settings ?? { fit: 'contain' },
    locale: 'fr',
    compact: opts.compact === true,
    whenReady: (cb: () => void) => cb(),
    subscribe: (channel: string, cb: (data: unknown) => void) => {
      subscribed.push(channel)
      if (channel === 'volume') volumeSubscribers.push(cb)
      else {
        expect(channel).toBe('companion')
        subscribers.push(cb)
      }
      return () => {}
    },
    onLocale: () => () => {},
    onSettings: () => () => {},
    sendCommand: (channel: string, name: string, payload: Record<string, unknown>) => {
      if (channel === 'volume') {
        volumeCommands.push([name, payload])
        return Promise.resolve({ ok: true })
      }
      expect(channel).toBe('companion')
      commands.push([name, payload])
      return Promise.resolve(name === 'view' ? reply.view : { ok: true })
    },
    t: (dict: Record<string, string>) => dict.fr,
  }

  const peers: Page['peers'] = []
  class FakePeer {
    closed = false
    remote: unknown = null
    localDescription: { type: string; sdp: string } | null = null
    iceGatheringState = 'complete'
    connectionState = 'new'
    ontrack: unknown = null
    onconnectionstatechange: unknown = null
    constructor(config: unknown) {
      expect(config).toEqual({ iceServers: [] })
      peers.push(this)
    }
    async setRemoteDescription(d: unknown) { this.remote = d }
    async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' } }
    async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d }
    close() { this.closed = true }
  }

  new Function(
    'document', 'window', 'Fremkit', 'FremkitFremplay', 'RTCPeerConnection', 'MediaStream', 'crypto',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', script,
  )(
    document, window, Fremkit, logic, opts.noPeer ? undefined : FakePeer, class {}, globalThis.crypto,
    (fn: () => void, ms: number) => setTimeout(fn, ms), (t: unknown) => clearTimeout(t as number),
    (fn: () => void, ms: number) => setInterval(fn, ms), (t: unknown) => clearInterval(t as number),
  )

  const fire = (key: string, type: string, e: unknown = {}) => (listeners.get(key + ':' + type) ?? []).forEach((fn) => fn(e))
  return {
    nodes, buttons, stage: byId('stage'), commands, volumeCommands, peers, reply, subscribed,
    publish: (data) => subscribers.forEach((cb) => cb(data)),
    publishVolume: (data) => volumeSubscribers.forEach((cb) => cb(data)),
    settle: async () => { for (let i = 0; i < 10; i++) await Promise.resolve() },
    tap: (target) => fire('stage', 'click', { target: target ?? byId('stage') }),
    setVisibility: (state) => { visibility = state; fire('document', 'visibilitychange') },
    fire: (id, type) => fire(id, type),
  }
}

const names = (page: Page) => page.commands.map(([name]) => name)

describe('the fremplay page', () => {
  it('says what is missing, one sentence each', async () => {
    const page = await loadPage()
    page.publish(snap({ paired: 0, connected: 0 }))
    expect(page.nodes.get('line')!.textContent).toBe('Installez Fremkit Companion dans Chrome, puis cliquez Connecter dans son menu')
    expect(page.nodes.get('sub')!.textContent).toContain('docs/companion.md')
    page.publish(snap({ paired: 1, connected: 0 }))
    expect(page.nodes.get('line')!.textContent).toBe('Navigateur fermé ou extension inactive')
    page.publish(snap())
    expect(page.nodes.get('line')!.textContent).toBe('Lancez une vidéo, puis cliquez l’icône Fremkit (⌃⇧F)')
    page.publish({ ...snap(), protocol: 3 })
    expect(page.nodes.get('line')!.textContent).toContain('mettez Fremkit à jour')
    expect(page.commands).toEqual([])
  })

  it('views a share with its own receiver id and nothing else, then answers its offer once', async () => {
    const page = await loadPage()
    page.publish(sharing('s1'))
    expect(page.commands).toHaveLength(1)
    const [name, payload] = page.commands[0]
    expect(name).toBe('view')
    // The host stamps `instanceId` itself: the page sends the receiver and nothing more.
    expect(Object.keys(payload)).toEqual(['receiverId'])
    const receiverId = payload.receiverId as string
    expect(receiverId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(page.nodes.get('line')!.textContent).toBe('A film')
    expect(page.nodes.get('mark')!.hidden).toBe(false)

    page.publish(sharing('s1', { [receiverId]: 'v=0 offer' }))
    await page.settle()
    expect(page.peers).toHaveLength(1)
    expect(page.peers[0].remote).toEqual({ type: 'offer', sdp: 'v=0 offer' })
    expect(page.commands[1]).toEqual(['answer', { receiverId, sdp: 'v=0 answer' }])
    page.publish(sharing('s1', { [receiverId]: 'v=0 offer' }))
    await page.settle()
    expect(names(page)).toEqual(['view', 'answer'])

    page.fire('video', 'playing')
    expect(page.stage.classes.has('playing')).toBe(true)
  })

  it('shows a refused view as the error line', async () => {
    const page = await loadPage()
    page.reply.view = { ok: false, error: 'ce lecteur ne peut pas regarder le partage' }
    page.publish(sharing('s1'))
    await page.settle()
    expect(page.nodes.get('sub')!.textContent).toBe('ce lecteur ne peut pas regarder le partage')
    expect(page.nodes.get('mark')!.hidden).toBe(true)
    // Not asked again on every snapshot.
    page.publish(sharing('s1'))
    expect(names(page)).toEqual(['view'])
  })

  it('leaves when hidden and views again when shown', async () => {
    const page = await loadPage()
    page.publish(sharing('s1'))
    page.setVisibility('hidden')
    expect(names(page)).toEqual(['view', 'leave'])
    page.publish(sharing('s1'))
    expect(names(page)).toEqual(['view', 'leave'])
    page.setVisibility('visible')
    expect(names(page)).toEqual(['view', 'leave', 'view'])
    page.fire('window', 'pagehide')
    expect(names(page)).toEqual(['view', 'leave', 'view', 'leave'])
  })

  it('gives up waiting after 10 s with an error line, and asks again', async () => {
    vi.useFakeTimers()
    try {
      const page = await loadPage()
      page.publish(sharing('s1'))
      await vi.advanceTimersByTimeAsync(9_999)
      expect(page.nodes.get('sub')!.textContent).toBe('')
      await vi.advanceTimersByTimeAsync(1)
      expect(page.nodes.get('sub')!.textContent).toBe('La vidéo n’arrive pas : arrêtez le partage puis relancez-le')
      expect(page.nodes.get('mark')!.hidden).toBe(true)
      expect(names(page)).toEqual(['view', 'leave', 'view'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops asking once its offer is refused, says so, and starts again with the next share', async () => {
    vi.useFakeTimers()
    try {
      const page = await loadPage()
      page.publish(sharing('s1'))
      const receiverId = page.commands[0][1].receiverId as string
      const refusedSnap = (sessionId: string) => {
        const s = sharing(sessionId, {}, [receiverId])
        return { ...s, tab: { ...s.tab, refused: [receiverId] } }
      }
      page.publish(refusedSnap('s1'))
      expect(page.nodes.get('sub')!.textContent).toBe('L’Edge a refusé cette connexion vidéo.')
      expect(page.nodes.get('mark')!.hidden).toBe(true)
      // The 10 s timer no longer rejoins: no leave, no view, however long it waits.
      await vi.advanceTimersByTimeAsync(35_000)
      page.publish(refusedSnap('s1'))
      expect(names(page)).toEqual(['view'])
      // Hidden and shown again: still refused, still not asking.
      page.setVisibility('hidden')
      page.setVisibility('visible')
      expect(names(page).filter((n) => n === 'view')).toEqual(['view'])
      // A new share clears it: the frame views again and the line goes.
      page.publish(sharing('s2', {}, []))
      expect(names(page).filter((n) => n === 'view')).toEqual(['view', 'view'])
      expect(page.nodes.get('sub')!.textContent).not.toBe('L’Edge a refusé cette connexion vidéo.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the controls on a tap and hides them after 4 s', async () => {
    vi.useFakeTimers()
    try {
      const page = await loadPage()
      page.publish(sharing('s1'))
      page.tap()
      expect(page.stage.classes.has('show')).toBe(true)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(page.stage.classes.has('show')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends the controls the provider takes', async () => {
    const page = await loadPage()
    page.publish(sharing('s1'))
    page.commands.length = 0
    page.tap()
    for (const a of ['back', 'fwd', 'toggle', 'voldown', 'mute', 'show', 'stop']) page.tap(page.buttons[a])
    expect(page.commands).toEqual([
      ['control', { action: 'seek', delta: -10 }],
      ['control', { action: 'seek', delta: 10 }],
      ['control', { action: 'toggle' }],
      ['control', { action: 'volume', value: 0.9 }],
      ['control', { action: 'mute' }],
      ['control', { action: 'show' }],
      ['control', { action: 'stop' }],
    ])
  })

  it('drives the Mac\'s output by default: − and + by 5 from the live level, mute from its state', async () => {
    const page = await loadPage()
    page.publishVolume({ level: 40, muted: false })
    page.publish(sharing('s1'))
    page.commands.length = 0
    page.tap()
    page.tap(page.buttons.volup)
    page.tap(page.buttons.volup)
    page.tap(page.buttons.voldown)
    // The icon reads the Mac, not the video's own `muted: true`.
    expect(page.buttons.mute.attrs['aria-label']).toBe('Couper le son')
    page.tap(page.buttons.mute)
    expect(page.buttons.mute.attrs['aria-label']).toBe('Rétablir le son')
    expect(page.volumeCommands).toEqual([
      ['set', { level: 45 }],
      ['set', { level: 50 }],
      ['set', { level: 45 }],
      ['mute', { muted: true }],
    ])
    expect(page.commands).toEqual([])
    // A new poll is the base again, and the ends hold.
    page.publishVolume({ level: 98, muted: false })
    page.tap(page.buttons.volup)
    page.publishVolume({ level: 2, muted: false })
    page.tap(page.buttons.voldown)
    expect(page.volumeCommands.slice(4)).toEqual([['set', { level: 100 }], ['set', { level: 0 }]])
  })

  it('keeps the Mac\'s volume buttons usable while the extension is away', async () => {
    const page = await loadPage()
    page.publishVolume({ level: 40, muted: false })
    page.publish({ ...sharing('s1'), extensions: { paired: 1, connected: 0 } })
    expect(page.buttons.toggle.disabled).toBe(true)
    expect(page.buttons.volup.disabled).toBe(false)
    expect(page.buttons.mute.disabled).toBe(false)
  })

  it('falls back to the video when the Mac\'s volume cannot be read', async () => {
    const page = await loadPage({ settings: { fit: 'contain', volumeTarget: 'mac' } })
    page.publishVolume({ level: 40, muted: false, error: 'offline' })
    page.publish(sharing('s1'))
    page.commands.length = 0
    page.tap()
    page.tap(page.buttons.voldown)
    page.tap(page.buttons.mute)
    expect(page.volumeCommands).toEqual([])
    expect(page.commands).toEqual([['control', { action: 'volume', value: 0.9 }], ['control', { action: 'mute' }]])
    expect(page.nodes.get('sub')!.textContent).toBe('')
  })

  it('drives the video when the setting says so, as before', async () => {
    const page = await loadPage({ settings: { fit: 'contain', volumeTarget: 'video' } })
    page.publishVolume({ level: 40, muted: false })
    page.publish(sharing('s1'))
    page.commands.length = 0
    page.tap()
    expect(page.buttons.mute.attrs['aria-label']).toBe('Rétablir le son')
    page.tap(page.buttons.volup)
    page.tap(page.buttons.voldown)
    page.tap(page.buttons.mute)
    expect(page.volumeCommands).toEqual([])
    expect(page.commands).toEqual([
      ['control', { action: 'volume', value: 1 }],
      ['control', { action: 'volume', value: 0.9 }],
      ['control', { action: 'mute' }],
    ])
  })

  it('a button under hidden controls only shows them', async () => {
    const page = await loadPage()
    page.publish(sharing('s1'))
    page.commands.length = 0
    page.tap(page.buttons.stop)
    expect(page.commands).toEqual([])
    expect(page.stage.classes.has('show')).toBe(true)
  })

  it('fills for the current share only, over the setting', async () => {
    const page = await loadPage({ settings: { fit: 'contain' } })
    page.publish(sharing('s1'))
    expect(page.stage.classes.has('cover')).toBe(false)
    page.tap()
    page.tap(page.buttons.fill)
    expect(page.stage.classes.has('cover')).toBe(true)
    expect(names(page)).toEqual(['view'])
    page.publish(sharing('s2'))
    expect(page.stage.classes.has('cover')).toBe(false)
  })

  it('honours the cover setting', async () => {
    const page = await loadPage({ settings: { fit: 'cover' } })
    page.publish(sharing('s1'))
    expect(page.stage.classes.has('cover')).toBe(true)
  })

  it('shows controls as unavailable while the extension is away', async () => {
    const page = await loadPage()
    page.publish({ ...sharing('s1'), extensions: { paired: 1, connected: 0 } })
    expect(page.buttons.toggle.disabled).toBe(true)
    expect(page.buttons.fill.disabled).toBe(false)
  })

  it('drops its peer when the share ends', async () => {
    const page = await loadPage()
    page.publish(sharing('s1'))
    const receiverId = page.commands[0][1].receiverId as string
    page.publish(sharing('s1', { [receiverId]: 'v=0 offer' }))
    await page.settle()
    page.publish(snap())
    expect(page.peers[0].closed).toBe(true)
    expect(page.nodes.get('line')!.textContent).toBe('Lancez une vidéo, puis cliquez l’icône Fremkit (⌃⇧F)')
  })

  it('compact: a live thumbnail with no tap of its own', async () => {
    const page = await loadPage({ compact: true })
    page.publish(sharing('s1'))
    expect(names(page)).toEqual(['view'])
    page.tap()
    expect(page.stage.classes.has('show')).toBe(false)
    expect(page.stage.classes.has('cover')).toBe(true)
  })

  /** A share watched to the point of a connected peer and a playing picture. */
  async function watching(page: Page) {
    page.publish(sharing('s1', {}, []))
    const receiverId = page.commands[0][1].receiverId as string
    page.publish(sharing('s1', { [receiverId]: 'v=0 offer' }, [receiverId]))
    await page.settle()
    connect(page.peers[0], 'connected')
    page.fire('video', 'playing')
    page.commands.length = 0
    return receiverId
  }
  function connect(peer: Page['peers'][number], state: string) {
    peer.connectionState = state
    ;(peer.onconnectionstatechange as () => void)()
  }

  it('server restart, empty snapshot first: keeps the picture, then views again with the same id', async () => {
    const page = await loadPage()
    const receiverId = await watching(page)
    // The new server knows no share yet, nor the extension.
    page.publish(snap({ connected: 0 }))
    expect(page.peers[0].closed).toBe(false)
    expect(page.stage.classes.has('playing')).toBe(true)
    expect(page.buttons.toggle.disabled).toBe(true)
    expect(page.commands).toEqual([])
    // The extension is back with its share; this frame is not among the receivers.
    page.publish(sharing('s1', {}, []))
    expect(page.commands).toEqual([['view', { receiverId }]])
    expect(page.peers[0].closed).toBe(false)
    expect(page.buttons.toggle.disabled).toBe(false)
    // Once, not on every snapshot until it shows up.
    page.publish(sharing('s1', {}, []))
    page.publish(sharing('s1', {}, [receiverId]))
    expect(names(page)).toEqual(['view'])
  })

  it('server restart, hello first: views again because the server does not list it', async () => {
    const page = await loadPage()
    const receiverId = await watching(page)
    page.publish(sharing('s1', {}, []))
    expect(page.commands).toEqual([['view', { receiverId }]])
    expect(page.peers[0].closed).toBe(false)
  })

  it('a share that really ended is let go when the peer drops', async () => {
    const page = await loadPage()
    await watching(page)
    page.publish(snap({ connected: 0 }))
    connect(page.peers[0], 'disconnected')
    expect(page.peers[0].closed).toBe(true)
    expect(page.nodes.get('line')!.textContent).toBe('Navigateur fermé ou extension inactive')
  })

  it('a share that really ended is let go when the extension is there and shares nothing', async () => {
    vi.useFakeTimers()
    try {
      const page = await loadPage()
      await watching(page)
      page.publish(snap({ connected: 1 }))
      expect(page.peers[0].closed).toBe(false)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(page.peers[0].closed).toBe(true)
      expect(page.stage.classes.has('playing')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a direct switch to another share sends no view: the session asked already', async () => {
    const page = await loadPage()
    const receiverId = await watching(page)
    page.publish(sharing('s2', {}, [receiverId]))
    expect(page.peers[0].closed).toBe(true)
    expect(page.commands).toEqual([])
    page.publish(sharing('s2', { [receiverId]: 'v=0 second' }, [receiverId]))
    await page.settle()
    expect(page.commands).toEqual([['answer', { receiverId, sdp: 'v=0 answer' }]])
  })
})
