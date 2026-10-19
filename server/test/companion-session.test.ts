import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompanionSession, META_PUBLISH_MS } from '../src/companion/session.js'
import type { ServerMessage, TabMeta } from '../src/companion/protocol.js'

const META: TabMeta = { title: 'A video', host: 'video.example.com', currentTime: 12, duration: 300, paused: false, muted: false, volume: 1 }
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 2122260223 127.0.0.1 54321 typ host\r\n'
const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const R = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const TOKEN = 'a'.repeat(43)
const INSTALL = '0b7d1c2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'

function setup(opts: { canShare?: boolean; paired?: number; enabled?: () => boolean } = {}) {
  let time = 1_000_000
  const sent: Array<{ to: string; msg: ServerMessage }> = []
  let changes = 0
  const session = new CompanionSession({
    now: () => time,
    send: (to, msg) => sent.push({ to, msg }),
    changed: () => { changes++ },
    canShare: () => opts.canShare ?? true,
    pairedCount: () => opts.paired ?? 2,
    ...(opts.enabled ? { enabled: opts.enabled } : {}),
  })
  const hello = (device: string, extra: object = {}) => {
    session.connect(device, `Browser ${device}`)
    session.onMessage(device, { type: 'hello', token: TOKEN, installId: INSTALL, protocol: 2, ...extra })
  }
  const start = (device: string, sessionId = S1) => session.onMessage(device, { type: 'tab.started', sessionId, meta: META })
  return {
    session,
    sent,
    hello,
    start,
    changes: () => changes,
    advance: (ms: number) => { time += ms },
    to: (device: string) => sent.filter((s) => s.to === device).map((s) => s.msg),
    clear: () => { sent.length = 0 },
  }
}

describe('CompanionSession', () => {
  it('answers hello with ready, and counts connected and paired extensions', () => {
    const t = setup({ paired: 3 })
    t.hello('a')
    expect(t.to('a')).toEqual([{ type: 'ready', protocol: 2, modules: { fremplay: true } }])
    expect(t.session.snapshot()).toEqual({
      protocol: 2,
      extensions: { connected: 1, paired: 3 },
      tab: { state: 'idle', sessionId: null, device: null, meta: null, offers: {}, receivers: [], refused: [] },
    })
    t.session.disconnect('a')
    expect(t.session.snapshot().extensions.connected).toBe(0)
  })

  it('accepts a share and reports it', () => {
    const t = setup()
    t.hello('a')
    t.clear()
    const before = t.changes()
    t.start('a')
    expect(t.to('a')).toEqual([{ type: 'tab.accepted', sessionId: S1 }])
    expect(t.changes()).toBeGreaterThan(before)
    expect(t.session.snapshot().tab).toEqual({ state: 'sharing', sessionId: S1, device: 'Browser a', meta: META, offers: {}, receivers: [], refused: [] })
  })

  it('a share from a second extension replaces the first and stops it', () => {
    const t = setup()
    t.hello('a')
    t.hello('b')
    t.start('a', S1)
    t.session.view(R(1), 'w1')
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: SDP })
    t.clear()
    t.start('b', S2)
    expect(t.to('a')).toEqual([{ type: 'tab.stop' }])
    // The receiver stays, its old offer goes, and the new sharer is asked for one.
    expect(t.to('b')).toEqual([{ type: 'tab.accepted', sessionId: S2 }, { type: 'tab.view', receiverId: R(1) }])
    expect(t.session.snapshot().tab).toMatchObject({ state: 'sharing', sessionId: S2, device: 'Browser b', offers: {} })
    // The first extension's messages about its old share are no longer heard.
    t.session.onMessage('a', { type: 'tab.meta', sessionId: S1, meta: { ...META, title: 'Old' } })
    t.session.onMessage('a', { type: 'tab.stopped', sessionId: S1 })
    expect(t.session.snapshot().tab).toMatchObject({ sessionId: S2, meta: META })
  })

  it('receivers registered while idle survive a tab.started and are asked for', () => {
    const t = setup()
    expect(t.session.view(R(1), 'w1')).toBe(true)
    expect(t.session.view(R(2), 'w2')).toBe(true)
    t.hello('a')
    t.clear()
    t.start('a')
    expect(t.to('a')).toEqual([
      { type: 'tab.accepted', sessionId: S1 },
      { type: 'tab.view', receiverId: R(1) },
      { type: 'tab.view', receiverId: R(2) },
    ])
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(2), sdp: SDP })
    expect(t.session.snapshot().tab.offers).toEqual({ [R(2)]: SDP })
  })

  it('a switch from A to B re-views every receiver to B, offers reset', () => {
    const t = setup()
    t.hello('a')
    t.hello('b')
    t.start('a', S1)
    t.session.view(R(1), 'w1')
    t.session.view(R(2), 'w2')
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: SDP })
    t.clear()
    t.start('b', S2)
    expect(t.to('b')).toEqual([
      { type: 'tab.accepted', sessionId: S2 },
      { type: 'tab.view', receiverId: R(1) },
      { type: 'tab.view', receiverId: R(2) },
    ])
    expect(t.session.snapshot().tab.offers).toEqual({})
    // The receivers are still bound to their instances.
    expect(t.session.view(R(1), 'w2')).toBe(false)
    expect(t.session.answer(R(1), 'w1', SDP)).toBe(false)
    t.session.onMessage('b', { type: 'tab.offer', sessionId: S2, receiverId: R(1), sdp: SDP })
    expect(t.session.answer(R(1), 'w1', SDP)).toBe(true)
  })

  it('tab.started is refused with noWidget when canShare is false', () => {
    const t = setup({ canShare: false })
    t.hello('a')
    t.clear()
    t.start('a')
    expect(t.to('a')).toEqual([{ type: 'tab.refused', sessionId: S1, reason: 'noWidget' }])
    expect(t.session.snapshot().tab.state).toBe('idle')
  })

  it('a protocol it does not speak gets ready with its own version, then every share is refused', () => {
    const t = setup()
    t.hello('a', { protocol: 3 })
    expect(t.to('a')).toEqual([{ type: 'ready', protocol: 2, modules: { fremplay: true } }])
    t.clear()
    t.start('a')
    expect(t.to('a')).toEqual([{ type: 'tab.refused', sessionId: S1, reason: 'protocol' }])
    expect(t.session.snapshot().tab.state).toBe('idle')
  })

  it('a view asks the sharing extension for an offer, which is published for that receiver', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    t.clear()
    expect(t.session.view(R(1), 'w1')).toBe(true)
    expect(t.to('a')).toEqual([{ type: 'tab.view', receiverId: R(1) }])
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: SDP })
    expect(t.session.snapshot().tab.offers).toEqual({ [R(1)]: SDP })
    // An offer for a receiver nobody registered is dropped.
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(2), sdp: SDP })
    expect(Object.keys(t.session.snapshot().tab.offers)).toEqual([R(1)])
  })

  it('a fifth view drops the oldest receiver of the same instance first, else refuses', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    expect(t.session.view(R(1), 'w1')).toBe(true)
    expect(t.session.view(R(2), 'w2')).toBe(true)
    expect(t.session.view(R(3), 'w1')).toBe(true)
    expect(t.session.view(R(4), 'w3')).toBe(true)
    t.clear()
    // w1 already has two: its oldest goes.
    expect(t.session.view(R(5), 'w1')).toBe(true)
    expect(t.to('a')).toEqual([{ type: 'tab.detach', receiverId: R(1) }, { type: 'tab.view', receiverId: R(5) }])
    t.clear()
    // w4 has none to give up.
    expect(t.session.view(R(6), 'w4')).toBe(false)
    expect(t.sent).toEqual([])
  })

  it('a view of a known receiver keeps it and asks again only when it has no offer', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    t.session.view(R(1), 'w1')
    t.session.view(R(2), 'w1')
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: SDP })
    t.clear()
    expect(t.session.view(R(1), 'w1')).toBe(true)
    expect(t.session.view(R(2), 'w1')).toBe(true)
    expect(t.to('a')).toEqual([{ type: 'tab.view', receiverId: R(2) }])
    expect(t.session.snapshot().tab.offers).toEqual({ [R(1)]: SDP })
    // Another instance cannot claim it.
    expect(t.session.view(R(1), 'w2')).toBe(false)
  })

  it('lists every receiver it knows, offer or not, and says so when one comes or goes', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    let before = t.changes()
    t.session.view(R(1), 'i1')
    expect(t.changes()).toBeGreaterThan(before)
    t.session.view(R(2), 'i1')
    expect(t.session.snapshot().tab.receivers).toEqual([R(1), R(2)])
    // A known receiver coming back is not news.
    before = t.changes()
    t.session.view(R(1), 'i1')
    expect(t.changes()).toBe(before)
    // A receiver with no offer leaving still changes what the snapshot lists.
    t.session.leave(R(1), 'i1')
    expect(t.changes()).toBeGreaterThan(before)
    expect(t.session.snapshot().tab.receivers).toEqual([R(2)])
  })

  it('answer from another instance than the receiver\'s is refused', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    t.session.view(R(1), 'w1')
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: SDP })
    t.clear()
    expect(t.session.answer(R(1), 'w2', SDP)).toBe(false)
    expect(t.session.answer(R(2), 'w1', SDP)).toBe(false)
    expect(t.sent).toEqual([])
    expect(t.session.answer(R(1), 'w1', SDP)).toBe(true)
    expect(t.to('a')).toEqual([{ type: 'tab.answer', receiverId: R(1), sdp: SDP }])
  })

  it('an answer that is not a local offer is refused', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    t.session.view(R(1), 'w1')
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: SDP })
    t.clear()
    expect(t.session.answer(R(1), 'w1', 'v=0\r\na=candidate:1 1 udp 1 198.51.100.7 5000 typ srflx\r\n')).toBe(false)
    expect(t.sent).toEqual([])
  })

  it('leave drops a receiver for its own instance only, and tells the extension', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    t.session.view(R(1), 'w1')
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: SDP })
    t.clear()
    t.session.leave(R(1), 'w2')
    expect(t.sent).toEqual([])
    t.session.leave(R(1), 'w1')
    expect(t.to('a')).toEqual([{ type: 'tab.detach', receiverId: R(1) }])
    expect(t.session.snapshot().tab.offers).toEqual({})
  })

  it('control is sent to the sharing device only', () => {
    const t = setup()
    t.hello('a')
    t.hello('b')
    expect(t.session.control({ action: 'toggle' })).toBe(false)
    t.start('b')
    t.clear()
    expect(t.session.control({ action: 'seek', delta: 10 })).toBe(true)
    expect(t.sent).toEqual([{ to: 'b', msg: { type: 'tab.control', action: 'seek', delta: 10 } }])
  })

  it('tab.stopped ends the share and its receivers', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    t.session.view(R(1), 'w1')
    t.session.onMessage('a', { type: 'tab.stopped', sessionId: S1 })
    expect(t.session.snapshot().tab).toEqual({ state: 'idle', sessionId: null, device: null, meta: null, offers: {}, receivers: [], refused: [] })
  })

  it('no meta for 10 s clears the share', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    t.advance(9_000)
    t.session.onMessage('a', { type: 'tab.meta', sessionId: S1, meta: { ...META, currentTime: 21 } })
    expect(t.session.snapshot().tab.meta?.currentTime).toBe(21)
    t.advance(9_999)
    t.session.tick()
    expect(t.session.snapshot().tab.state).toBe('sharing')
    t.advance(1)
    const before = t.changes()
    t.session.tick()
    expect(t.session.snapshot().tab.state).toBe('idle')
    expect(t.changes()).toBeGreaterThan(before)
  })

  it('a disconnect alone keeps the share until it goes stale', () => {
    const t = setup()
    t.hello('a')
    t.start('a')
    t.session.disconnect('a')
    expect(t.session.snapshot().tab.state).toBe('sharing')
  })

  it('hello with a session adopts it and keeps known receivers', () => {
    const t = setup()
    // A receiver that re-announced itself before the extension came back.
    expect(t.session.view(R(1), 'w1')).toBe(true)
    t.clear()
    t.hello('a', { session: { sessionId: S1, meta: META } })
    expect(t.to('a')).toEqual([
      { type: 'ready', protocol: 2, modules: { fremplay: true } },
      { type: 'tab.accepted', sessionId: S1 },
      { type: 'tab.view', receiverId: R(1) },
    ])
    expect(t.session.snapshot().tab).toMatchObject({ state: 'sharing', sessionId: S1, device: 'Browser a', meta: META })
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: SDP })
    // The extension's socket drops and comes back: same share, the receiver with an offer is kept as is.
    t.session.disconnect('a')
    t.clear()
    t.hello('a', { session: { sessionId: S1, meta: META } })
    expect(t.to('a')).toEqual([{ type: 'ready', protocol: 2, modules: { fremplay: true } }, { type: 'tab.accepted', sessionId: S1 }])
    expect(t.session.snapshot().tab.offers).toEqual({ [R(1)]: SDP })
  })

  it('hello with a session while another extension shares stops the newcomer\'s', () => {
    const t = setup()
    t.hello('a')
    t.start('a', S1)
    t.clear()
    t.hello('b', { session: { sessionId: S2, meta: META } })
    expect(t.to('b')).toEqual([{ type: 'ready', protocol: 2, modules: { fremplay: true } }, { type: 'tab.stop' }])
    expect(t.to('a')).toEqual([])
    expect(t.session.snapshot().tab.sessionId).toBe(S1)
  })

  it('revoking the sharing extension ends its share; revoking another leaves it running', () => {
    const t = setup()
    t.hello('a')
    t.hello('b')
    t.start('a')
    t.session.revoke('b')
    expect(t.session.snapshot()).toMatchObject({ extensions: { connected: 1 }, tab: { state: 'sharing', sessionId: S1 } })
    t.session.revoke('a')
    expect(t.session.snapshot()).toMatchObject({ extensions: { connected: 0 }, tab: { state: 'idle' } })
  })
})

describe('CompanionSession refused offer', () => {
  it('refuses only that receiver\'s offer, naming it, when the offer names another host', () => {
    const t = setup()
    t.hello('a')
    t.start('a', S1)
    t.session.view(R(1), 'w1')
    t.session.view(R(2), 'w2')
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(2), sdp: 'v=0 local' })
    t.clear()
    const lan = 'v=0\r\na=candidate:1 1 udp 2122260223 198.51.100.7 54321 typ host\r\n'
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: lan })
    expect(t.to('a')).toEqual([{ type: 'tab.refused', sessionId: S1, reason: 'offer', receiverId: R(1) }])
    // The share and the other receiver go on; the refused one stays known, with no offer, so its
    // frame waits instead of asking again.
    expect(t.session.snapshot().tab).toMatchObject({ state: 'sharing', sessionId: S1, offers: { [R(2)]: 'v=0 local' }, receivers: [R(1), R(2)] })
  })

  it('lists a refused receiver until the share changes, and never asks the extension for it again', () => {
    const t = setup()
    t.hello('a')
    t.start('a', S1)
    t.session.view(R(1), 'w1')
    const lan = 'v=0\r\na=candidate:1 1 udp 2122260223 198.51.100.7 54321 typ host\r\n'
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: lan })
    expect(t.session.snapshot().tab).toMatchObject({ receivers: [R(1)], refused: [R(1)] })
    t.clear()
    // The frame's 10 s timer: leave, then view again. Neither reaches the extension.
    t.session.view(R(1), 'w1')
    t.session.leave(R(1), 'w1')
    t.session.view(R(1), 'w1')
    expect(t.to('a').filter((m) => m.type === 'tab.view')).toEqual([])
    expect(t.session.snapshot().tab.refused).toEqual([R(1)])
    // A bad offer for a receiver nobody registered is refused, not remembered.
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(3), sdp: lan })
    expect(t.session.snapshot().tab.refused).toEqual([R(1)])
    // A new share starts clean, and asks for the receiver again.
    t.clear()
    t.start('a', S2)
    expect(t.session.snapshot().tab.refused).toEqual([])
    expect(t.to('a')).toContainEqual({ type: 'tab.view', receiverId: R(1) })
    // And no share lists none.
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S2, receiverId: R(1), sdp: lan })
    expect(t.session.snapshot().tab.refused).toEqual([R(1)])
    t.session.onMessage('a', { type: 'tab.stopped', sessionId: S2 })
    expect(t.session.snapshot().tab).toMatchObject({ state: 'idle', refused: [] })
  })

  it('takes back a receiver\'s earlier offer when its new one is refused', () => {
    const t = setup()
    t.hello('a')
    t.start('a', S1)
    t.session.view(R(1), 'w1')
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: 'v=0 local' })
    expect(t.session.snapshot().tab.offers).toEqual({ [R(1)]: 'v=0 local' })
    const lan = 'v=0\r\na=candidate:1 1 udp 2122260223 198.51.100.7 54321 typ host\r\n'
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S1, receiverId: R(1), sdp: lan })
    expect(t.session.snapshot().tab).toMatchObject({ state: 'sharing', offers: {}, receivers: [R(1)] })
  })

  it('ignores a bad offer about a share that is not the current one', () => {
    const t = setup()
    t.hello('a')
    t.start('a', S1)
    t.clear()
    t.session.onMessage('a', { type: 'tab.offer', sessionId: S2, receiverId: R(1), sdp: 'v=1' })
    expect(t.to('a')).toEqual([])
    expect(t.session.snapshot().tab.state).toBe('sharing')
  })
})

describe('CompanionSession tab.meta throttle', () => {
  afterEach(() => { vi.useRealTimers() })

  function sharing() {
    vi.useFakeTimers()
    let changes = 0
    const session = new CompanionSession({
      now: () => Date.now(),
      send: () => undefined,
      changed: () => { changes++ },
      canShare: () => true,
    })
    session.connect('a', 'Chrome')
    session.onMessage('a', { type: 'hello', token: TOKEN, installId: INSTALL, protocol: 2 })
    session.onMessage('a', { type: 'tab.started', sessionId: S1, meta: META })
    const meta = (currentTime: number, sessionId = S1) => session.onMessage('a', { type: 'tab.meta', sessionId, meta: { ...META, currentTime } })
    return { session, meta, changes: () => changes }
  }

  it('publishes at most 4 refreshes a second, the latest on the trailing edge', () => {
    expect(META_PUBLISH_MS).toBe(250)
    const t = sharing()
    const base = t.changes()
    // A flood: 100 refreshes within one second.
    for (let i = 0; i < 100; i++) {
      t.meta(i)
      vi.advanceTimersByTime(10)
    }
    vi.advanceTimersByTime(META_PUBLISH_MS)
    const published = t.changes() - base
    expect(published).toBeGreaterThanOrEqual(4)
    expect(published).toBeLessThanOrEqual(5)
    // Nothing is lost: the last one sent is the one shown.
    expect(t.session.snapshot().tab.meta?.currentTime).toBe(99)
  })

  it('publishes the first refresh at once, and coalesces the rest into one trailing publish', () => {
    const t = sharing()
    vi.advanceTimersByTime(META_PUBLISH_MS)
    const base = t.changes()
    t.meta(1)
    expect(t.changes()).toBe(base + 1)
    t.meta(2)
    t.meta(3)
    t.meta(4)
    expect(t.changes()).toBe(base + 1)
    vi.advanceTimersByTime(META_PUBLISH_MS - 1)
    expect(t.changes()).toBe(base + 1)
    vi.advanceTimersByTime(1)
    expect(t.changes()).toBe(base + 2)
    expect(t.session.snapshot().tab.meta?.currentTime).toBe(4)
    // Once a quarter second has gone by, the next one is published at once again.
    vi.advanceTimersByTime(META_PUBLISH_MS)
    t.meta(5)
    expect(t.changes()).toBe(base + 3)
  })

  it('drops the trailing publish of a share that ended', () => {
    const t = sharing()
    vi.advanceTimersByTime(META_PUBLISH_MS)
    t.meta(1)
    t.meta(2)
    t.session.onMessage('a', { type: 'tab.stopped', sessionId: S1 })
    const after = t.changes()
    vi.advanceTimersByTime(META_PUBLISH_MS * 4)
    expect(t.changes()).toBe(after)
    expect(t.session.snapshot().tab.state).toBe('idle')
  })

  it('a refresh for another session is not published', () => {
    const t = sharing()
    vi.advanceTimersByTime(META_PUBLISH_MS)
    const base = t.changes()
    t.meta(1, S2)
    vi.advanceTimersByTime(META_PUBLISH_MS)
    expect(t.changes()).toBe(base)
  })

  describe('with Fremplay off (labs.companion)', () => {
    it('says so in ready and refuses a new share with disabled', () => {
      const t = setup({ enabled: () => false })
      t.hello('a')
      expect(t.to('a')).toEqual([{ type: 'ready', protocol: 2, modules: { fremplay: false } }])
      t.clear()
      t.start('a')
      expect(t.to('a')).toEqual([{ type: 'tab.refused', sessionId: S1, reason: 'disabled' }])
      expect(t.session.snapshot().tab.state).toBe('idle')
    })

    it('refuses a share carried back by hello', () => {
      const t = setup({ enabled: () => false })
      t.hello('a', { session: { sessionId: S1, meta: META } })
      expect(t.to('a')).toEqual([
        { type: 'ready', protocol: 2, modules: { fremplay: false } },
        { type: 'tab.refused', sessionId: S1, reason: 'disabled' },
      ])
      expect(t.session.snapshot().tab.state).toBe('idle')
    })

    it('ends a running share when the switch goes off, and tells every extension', () => {
      let on = true
      const t = setup({ enabled: () => on })
      t.hello('a')
      t.hello('b')
      t.start('a')
      t.session.view(R(1), 'w1')
      t.clear()
      on = false
      t.session.switched()
      expect(t.to('a')).toEqual([
        { type: 'ready', protocol: 2, modules: { fremplay: false } },
        { type: 'tab.refused', sessionId: S1, reason: 'disabled' },
      ])
      expect(t.to('b')).toEqual([{ type: 'ready', protocol: 2, modules: { fremplay: false } }])
      expect(t.session.snapshot().tab).toMatchObject({ state: 'idle', receivers: [] })
      // Back on: the extensions hear it, and a share starts again.
      t.clear()
      on = true
      t.session.switched()
      expect(t.to('a')).toEqual([{ type: 'ready', protocol: 2, modules: { fremplay: true } }])
      t.start('a', S2)
      expect(t.session.snapshot().tab.state).toBe('sharing')
    })
  })
})
