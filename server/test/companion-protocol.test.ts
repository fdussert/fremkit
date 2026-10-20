import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hostAddresses } from '../src/widgets/webrtc.js'
import {
  companionOrigins,
  COMPANION_EXTENSION_ID,
  shortExtensionId,
  ControlSchema,
  DevTabSchema,
  EXTENSION_ORIGIN_RE,
  FREMDEV_BUILD_MODULE,
  FREMDEV_FEATURES,
  FREMDEV_SLOW_MODULE,
  MAX_MESSAGE_BYTES,
  MAX_SDP,
  MetaSchema,
  PROTOCOL,
  isLocalSdp,
  parseAfterHello,
  parseExtensionMessage,
} from '../src/companion/protocol.js'

function sdp(...candidates: string[]): string {
  return ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', ...candidates.map((c) => `a=${c}`), ''].join('\r\n')
}

function host(address: string, type = 'host'): string {
  return `candidate:1 1 udp 2122260223 ${address} 54321 typ ${type} generation 0`
}

const meta = { title: 'A video', host: 'example.com', currentTime: 12.5, duration: 600, paused: false, muted: false, volume: 0.5 }
const token = randomBytes(32).toString('base64url')

describe('constants', () => {
  it('pins the protocol version, the size limits and the extension origin', () => {
    expect(PROTOCOL).toBe(2)
    expect(MAX_MESSAGE_BYTES).toBe(65_536)
    expect(MAX_SDP).toBe(32_000)
    expect(EXTENSION_ORIGIN_RE.test(`chrome-extension://${'a'.repeat(32)}`)).toBe(true)
    expect(EXTENSION_ORIGIN_RE.test(`chrome-extension://${'a'.repeat(31)}q`)).toBe(false)
    expect(EXTENSION_ORIGIN_RE.test(`chrome-extension://${'a'.repeat(32)}/x`)).toBe(false)
    expect(EXTENSION_ORIGIN_RE.test('https://example.com')).toBe(false)
  })
})

describe('isLocalSdp', () => {
  /** This Mac's addresses, as the server would read them from its interfaces. */
  const OWN = ['127.0.0.1', '::1', '192.168.1.20', 'fe80::1', 'fd12:3456::1']

  it("accepts host candidates on loopback, .local names and this Mac's own addresses", () => {
    const addresses = [
      '127.0.0.1', '127.8.9.10', '::1', '192.168.1.20', 'fe80::1', 'FE80::1', 'fe80::1%en0', 'fd12:3456::1',
      'f3a1c2d4-0000-4000-8000-123456789abc.local',
    ]
    for (const address of addresses) expect(isLocalSdp(sdp(host(address)), OWN), address).toBe(true)
  })

  it('refuses another host on the local network: the kiosk is never sent to probe it', () => {
    const lan = ['192.168.1.21', '10.1.2.3', '172.16.0.1', '169.254.9.9', 'fe80::2', 'fc00::1', 'fd12:3456::2']
    for (const address of lan) expect(isLocalSdp(sdp(host(address)), OWN), address).toBe(false)
    // Loopback and .local need no interface list.
    expect(isLocalSdp(sdp(host('127.0.0.1'), host('abcd.local')), [])).toBe(true)
  })

  it("reads this Mac's addresses from its interfaces by default", () => {
    for (const address of hostAddresses()) expect(isLocalSdp(sdp(host(address))), address).toBe(true)
    expect(isLocalSdp(sdp(host('198.51.100.7')))).toBe(false)
  })

  it('accepts an offer with no candidate at all', () => {
    expect(isLocalSdp(sdp())).toBe(true)
  })

  it('refuses srflx, relay and public host candidates', () => {
    expect(isLocalSdp(sdp(host('192.168.1.20', 'srflx')), OWN)).toBe(false)
    expect(isLocalSdp(sdp(host('192.168.1.20', 'relay')), OWN)).toBe(false)
    const outside = [
      '198.51.100.7', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '169.253.0.1', '128.0.0.1',
      '2001:db8::1', 'fec0::1', 'fe00::1', 'fe::1', '::', '::ffff:10.0.0.1', 'example.com', 'local',
      '10.0.0', '10.0.0.256', '010.0.0.1',
    ]
    for (const address of outside) expect(isLocalSdp(sdp(host(address)), OWN), address).toBe(false)
  })

  it('refuses the whole offer when one candidate is not local', () => {
    expect(isLocalSdp(sdp(host('192.168.1.20'), host('198.51.100.7')), OWN)).toBe(false)
  })

  it('refuses a candidate line it cannot read', () => {
    expect(isLocalSdp(sdp('candidate:1 1 udp 2122260223 192.168.1.20'))).toBe(false)
  })

  it('refuses text not starting with v=0 and text over 32000 chars', () => {
    expect(isLocalSdp('')).toBe(false)
    expect(isLocalSdp(' v=0\r\n')).toBe(false)
    expect(isLocalSdp('v=1\r\n')).toBe(false)
    expect(isLocalSdp('v=0\r\n' + 'a=x\r\n'.repeat(MAX_SDP))).toBe(false)
    expect(isLocalSdp('v=0\n' + 'x'.repeat(MAX_SDP - 4))).toBe(true)
    expect(isLocalSdp('v=0\n' + 'x'.repeat(MAX_SDP - 3))).toBe(false)
  })
})

describe('MetaSchema', () => {
  it('accepts a well-formed meta', () => {
    expect(MetaSchema.safeParse(meta).success).toBe(true)
    expect(MetaSchema.safeParse({ ...meta, title: '', host: '192.0.2.7', currentTime: 0, volume: 1 }).success).toBe(true)
  })

  it('refuses a 301-char title, a negative time and a volume of 1.1', () => {
    expect(MetaSchema.safeParse({ ...meta, title: 'x'.repeat(300) }).success).toBe(true)
    expect(MetaSchema.safeParse({ ...meta, title: 'x'.repeat(301) }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, currentTime: -1 }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, duration: 604_801 }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, duration: Infinity }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, currentTime: NaN }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, volume: 1.1 }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, volume: -0.1 }).success).toBe(false)
  })

  it('refuses a host that is not a bare hostname', () => {
    for (const bad of ['', 'https://example.com', 'example.com:8080', 'example.com/path', 'a b.com', '[::1]', 'exa_mple.com', '-a.com', 'a'.repeat(254)]) {
      expect(MetaSchema.safeParse({ ...meta, host: bad }).success, bad).toBe(false)
    }
  })

  it('refuses extra keys and missing fields', () => {
    expect(MetaSchema.safeParse({ ...meta, url: 'https://example.com' }).success).toBe(false)
    const { muted: _muted, ...partial } = meta
    expect(MetaSchema.safeParse(partial).success).toBe(false)
  })
})

describe('ControlSchema', () => {
  it('requires delta for seek and value for volume', () => {
    expect(ControlSchema.safeParse({ action: 'seek' }).success).toBe(false)
    expect(ControlSchema.safeParse({ action: 'seek', delta: 10 }).success).toBe(true)
    expect(ControlSchema.safeParse({ action: 'seek', delta: -10 }).success).toBe(true)
    expect(ControlSchema.safeParse({ action: 'seek', delta: 5 }).success).toBe(false)
    expect(ControlSchema.safeParse({ action: 'volume' }).success).toBe(false)
    expect(ControlSchema.safeParse({ action: 'volume', value: 0.3 }).success).toBe(true)
    expect(ControlSchema.safeParse({ action: 'volume', value: 1.5 }).success).toBe(false)
  })

  it('accepts the plain actions and refuses unknown ones and extra keys', () => {
    for (const action of ['toggle', 'mute', 'stop', 'show']) expect(ControlSchema.safeParse({ action }).success, action).toBe(true)
    expect(ControlSchema.safeParse({ action: 'reload' }).success).toBe(false)
    expect(ControlSchema.safeParse({ action: 'toggle', url: 'x' }).success).toBe(false)
  })
})

describe('parseExtensionMessage', () => {
  const sessionId = randomUUID()
  const receiverId = randomUUID()
  const installId = randomUUID()
  const parse = (m: unknown) => parseExtensionMessage(JSON.stringify(m))

  it('parses each message of the protocol', () => {
    const nonce = randomBytes(32).toString('base64url')
    expect(parse({ type: 'challenge', deviceId: installId, nonce })).toEqual({ type: 'challenge', deviceId: installId, nonce })
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL })).not.toBeNull()
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL, session: { sessionId, meta } })).not.toBeNull()
    expect(parse({ type: 'tab.started', sessionId, meta })).toMatchObject({ type: 'tab.started', sessionId })
    expect(parse({ type: 'tab.meta', sessionId, meta })).not.toBeNull()
    expect(parse({ type: 'tab.offer', sessionId, receiverId, sdp: sdp(host('127.0.0.1')) })).not.toBeNull()
    // Parsed even when it names another host: the session refuses it without closing the socket.
    expect(parse({ type: 'tab.offer', sessionId, receiverId, sdp: sdp(host('198.51.100.7')) })).not.toBeNull()
    expect(parse({ type: 'tab.stopped', sessionId })).toEqual({ type: 'tab.stopped', sessionId })
  })

  it('refuses unknown types, extra keys and oversize input', () => {
    expect(parse({ type: 'tab.unknown', sessionId })).toBeNull()
    expect(parse({ type: 'tab.stopped', sessionId, extra: 1 })).toBeNull()
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL, session: { sessionId, meta, extra: 1 } })).toBeNull()
    expect(parse({ type: 'tab.meta', sessionId, meta: { ...meta, url: 'x' } })).toBeNull()
    const padded = JSON.stringify({ type: 'tab.stopped', sessionId, pad: 'x'.repeat(MAX_MESSAGE_BYTES) })
    expect(parseExtensionMessage(padded)).toBeNull()
    // The limit is in bytes: 3-byte characters count three times.
    const wide = JSON.stringify({ type: 'tab.meta', sessionId, meta: { ...meta, title: '€'.repeat(300) } })
    expect(parseExtensionMessage(wide)).not.toBeNull()
    expect(parseExtensionMessage(wide + ' '.repeat(MAX_MESSAGE_BYTES))).toBeNull()
  })

  it('refuses malformed JSON and values that are not objects', () => {
    expect(parseExtensionMessage('{nope')).toBeNull()
    expect(parseExtensionMessage('')).toBeNull()
    expect(parseExtensionMessage('null')).toBeNull()
    expect(parseExtensionMessage('[]')).toBeNull()
  })

  it('refuses bad ids, a malformed token and a non-local offer', () => {
    expect(parse({ type: 'tab.stopped', sessionId: 'not-a-uuid' })).toBeNull()
    expect(parse({ type: 'hello', token: 'short', installId, protocol: PROTOCOL })).toBeNull()
    expect(parse({ type: 'hello', token, installId: 'x', protocol: PROTOCOL })).toBeNull()
    expect(parse({ type: 'hello', token, installId, protocol: 'one' })).toBeNull()
    expect(parse({ type: 'tab.offer', sessionId, receiverId: 'x', sdp: sdp() })).toBeNull()
  })

  it('lets a hello carry any protocol number, so the server can answer a version it does not speak', () => {
    expect(parse({ type: 'hello', token, installId, protocol: 3 })).toMatchObject({ protocol: 3 })
  })

  it('keeps a hello\'s modules list and still strips unknown keys', () => {
    const modules = ['fremplay', 'fremdev', 'fremfuture']
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL, modules, foo: 1 }))
      .toEqual({ type: 'hello', token, installId, protocol: PROTOCOL, modules })
  })

  it('keeps a hello with the cockpit\'s nine modules, and up to sixteen', () => {
    const nine = ['fremplay', 'fremdev', 'fremdev.report', 'fremdev.build', 'fremdev.open', 'fremdev.reload', 'fremdev.slow', 'fremdev.perf', 'fremdev.shot']
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL, modules: nine })).toEqual({ type: 'hello', token, installId, protocol: PROTOCOL, modules: nine })
    const sixteen = Array.from({ length: 16 }, (_, i) => `m${i}`)
    expect(parse({ type: 'modules', modules: sixteen })).toEqual({ type: 'modules', modules: sixteen })
  })

  it('still reads a hello whose modules it cannot read, as one without modules', () => {
    // A newer extension's seventeenth module, or a longer name: it connects, just not Fremdev-capable.
    const seventeen = Array.from({ length: 17 }, (_, i) => `m${i}`)
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL, modules: seventeen })).toEqual({ type: 'hello', token, installId, protocol: PROTOCOL })
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL, modules: ['x'.repeat(33)] })).toEqual({ type: 'hello', token, installId, protocol: PROTOCOL })
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL, modules: 'fremdev' })).toEqual({ type: 'hello', token, installId, protocol: PROTOCOL })
  })

  it('parses modules and ping', () => {
    expect(parse({ type: 'modules', modules: ['fremplay', 'fremdev'] })).toEqual({ type: 'modules', modules: ['fremplay', 'fremdev'] })
    expect(parse({ type: 'ping' })).toEqual({ type: 'ping' })
    expect(parse({ type: 'modules', modules: Array.from({ length: 17 }, (_, i) => `m${i}`) })).toBeNull()
    expect(parse({ type: 'modules', modules: ['x'.repeat(33)] })).toBeNull()
  })

  describe('dev.tabs', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      tabId: 1,
      app: 'My app',
      host: 'localhost:5173',
      errors: { total: 3, open: 1, seen: 0, last: { text: 'TypeError: x is undefined', at: 1_760_000_000_000 } },
      requests: { total: 10, open: 0, seen: 0, last: { path: '/api/items', status: 500, at: 1_760_000_000_000 } },
      history: [
        { kind: 'error', id: 3, text: 'TypeError: x is undefined', origin: '/src/app.js:12:5', n: 2, at: 1_760_000_000_000, state: 'open' },
        { kind: 'request', id: 2, method: 'POST', path: '/api/items', status: 500, n: 1, at: 1_759_999_999_000, state: 'seen' },
        { kind: 'limited', id: 1, n: 40, at: 1_759_999_998_000, state: 'resolved' },
      ],
      devServer: null,
      inFlight: 0,
      server: 'up',
      activity: 1_760_000_000_000,
      ...over,
    })
    const tabs = (rows: unknown[]) => parse({ type: 'dev.tabs', tabs: rows })

    it('parses a dev.tabs message with two rows', () => {
      expect(tabs([row(), row({ tabId: 2 })])?.type).toBe('dev.tabs')
      expect(tabs([row({ errors: { total: 0, open: 0, seen: 0, last: null }, requests: { total: 0, open: 0, seen: 0, last: null } })])).not.toBeNull()
      expect(tabs([row({ errors: { total: 3, open: 2, seen: 2, last: null } })])).not.toBeNull()
    })

    it('refuses 33 tabs, a long error text, an unknown key, open above total, seen above open or missing, and a path with a query', () => {
      expect(tabs(Array.from({ length: 33 }, (_, i) => row({ tabId: i })))).toBeNull()
      expect(tabs([row({ errors: { total: 1, open: 1, seen: 0, last: { text: 'x'.repeat(301), at: 1 } } })])).toBeNull()
      expect(tabs([row({ extra: 1 })])).toBeNull()
      expect(tabs([row({ errors: { total: 1, open: 2, seen: 0, last: null } })])).toBeNull()
      expect(tabs([row({ errors: { total: 2, open: 1, seen: 2, last: null } })])).toBeNull()
      expect(tabs([row({ requests: { total: 1, open: 1, last: null } })])).toBeNull()
      expect(tabs([row({ requests: { total: 1, open: 0, seen: 0, last: { path: '/a?b=1', status: 200, at: 1 } } })])).toBeNull()
      expect(tabs([row({ requests: { total: 1, open: 0, seen: 0, last: { path: '/a#b', status: 200, at: 1 } } })])).toBeNull()
      expect(tabs([row({ requests: { total: 1, open: 0, seen: 0, last: { path: 'a', status: 200, at: 1 } } })])).toBeNull()
      expect(tabs([row({ requests: { total: 1, open: 0, seen: 0, last: { path: '/a', status: 600, at: 1 } } })])).toBeNull()
      expect(tabs([row({ host: 'bad host/' })])).toBeNull()
      expect(tabs([row({ server: 'sideways' })])).toBeNull()
    })

    it('refuses a bad history: 21 entries, an unknown kind or state, a method outside the list, n of 0, a stack', () => {
      const entry = { kind: 'error', id: 1, text: 'x', origin: null, n: 1, at: 1, state: 'open' }
      const request = { kind: 'request', id: 1, method: 'GET', path: '/a', status: 404, n: 1, at: 1, state: 'open' }
      expect(tabs([row({ history: Array.from({ length: 20 }, () => entry) })])).not.toBeNull()
      expect(tabs([row({ history: Array.from({ length: 21 }, () => entry) })])).toBeNull()
      expect(tabs([row({ history: [{ ...entry, kind: 'warning' }] })])).toBeNull()
      expect(tabs([row({ history: [{ ...entry, state: 'gone' }] })])).toBeNull()
      expect(tabs([row({ history: [{ ...request, method: 'FOO' }] })])).toBeNull()
      expect(tabs([row({ history: [{ ...request, method: 'OTHER' }] })])).not.toBeNull()
      expect(tabs([row({ history: [{ ...request, path: '/a?token=1' }] })])).toBeNull()
      expect(tabs([row({ history: [{ ...entry, n: 0 }] })])).toBeNull()
      expect(tabs([row({ history: [{ ...entry, stack: ['f /a.js:1:2'] }] })])).toBeNull()
      expect(tabs([row({ history: [{ ...entry, text: 'x'.repeat(301) }] })])).toBeNull()
      expect(tabs([row({ history: [{ kind: 'limited', id: 1, n: 1, at: 1, state: 'open', text: 'x' }] })])).toBeNull()
    })

    it('takes a build entry with a file or none, and refuses line 0, a long file or an extra key', () => {
      const build = { kind: 'build', id: 4, text: 'Invalid end tag.', file: '~/app/src/App.vue', line: 12, col: 3, n: 1, at: 1, state: 'open' }
      expect(tabs([row({ history: [build] })])).not.toBeNull()
      expect(tabs([row({ history: [{ ...build, file: null, line: null, col: null }] })])).not.toBeNull()
      expect(tabs([row({ history: [{ ...build, line: 10_000_000, col: 10_000_000 }] })])).not.toBeNull()
      for (const bad of [
        { ...build, line: 0 },
        { ...build, col: 0 },
        { ...build, line: 10_000_001 },
        { ...build, line: 1.5 },
        { ...build, file: 'x'.repeat(301) },
        { ...build, text: 'x'.repeat(301) },
        { ...build, path: '/Users/example/app/src/App.vue' },
        (({ file: _, ...rest }) => rest)(build),
      ]) expect(tabs([row({ history: [bad] })]), JSON.stringify(bad)).toBeNull()
    })

    it('lists fremdev.build among the Fremdev features', () => {
      expect(FREMDEV_BUILD_MODULE).toBe('fremdev.build')
      expect(FREMDEV_FEATURES).toContain(FREMDEV_BUILD_MODULE)
    })

    it('lists fremdev.slow among the Fremdev features', () => {
      expect(FREMDEV_SLOW_MODULE).toBe('fremdev.slow')
      expect(FREMDEV_FEATURES).toContain(FREMDEV_SLOW_MODULE)
    })

    it('takes a slow entry from 1 s to an hour, and refuses one outside it, with a query or an extra key', () => {
      const slow = { kind: 'slow', id: 5, method: 'GET', path: '/api/items', ms: 1200, n: 2, at: 1, state: 'open' }
      expect(tabs([row({ history: [slow] })])).not.toBeNull()
      expect(tabs([row({ history: [{ ...slow, ms: 1000 }] })])).not.toBeNull()
      expect(tabs([row({ history: [{ ...slow, ms: 3_600_000, method: 'OTHER' }] })])).not.toBeNull()
      for (const bad of [
        { ...slow, ms: 999 },
        { ...slow, ms: 3_600_001 },
        { ...slow, ms: 1200.5 },
        { ...slow, method: 'FOO' },
        { ...slow, path: '/api/items?token=1' },
        { ...slow, path: 'api' },
        { ...slow, path: `/${'p'.repeat(300)}` },
        { ...slow, status: 200 },
        (({ ms: _, ...rest }) => rest)(slow),
      ]) expect(tabs([row({ history: [bad] })]), JSON.stringify(bad)).toBeNull()
    })

    it('reads a row without inFlight as 0, and takes 0 to 999', () => {
      const { inFlight: _, ...without } = row({ inFlight: 1 })
      expect(DevTabSchema.parse(without).inFlight).toBe(0)
      for (const n of [0, 1, 999]) expect(DevTabSchema.parse(row({ inFlight: n })).inFlight).toBe(n)
      for (const n of [-1, 1000, 1.5, '3']) expect(DevTabSchema.safeParse(row({ inFlight: n })).success, String(n)).toBe(false)
    })

    it('needs an entry id from 1 to 2 147 483 647', () => {
      const entry = { kind: 'error', id: 1, text: 'x', origin: null, n: 1, at: 1, state: 'open' }
      const { id: _, ...noId } = entry
      expect(tabs([row({ history: [{ ...entry, id: 2_147_483_647 }] })])).not.toBeNull()
      for (const bad of [noId, { ...entry, id: 0 }, { ...entry, id: 1.5 }, { ...entry, id: 2_147_483_648 }, { kind: 'limited', n: 1, at: 1, state: 'open' }]) {
        expect(tabs([row({ history: [bad] })]), JSON.stringify(bad)).toBeNull()
      }
    })

    it('reads a row without devServer as null, and refuses a kind outside the list', () => {
      const { devServer: _, ...without } = row()
      expect(DevTabSchema.parse(without).devServer).toBeNull()
      for (const kind of ['vite', 'next', 'webpack', null]) expect(DevTabSchema.parse(row({ devServer: kind })).devServer).toBe(kind)
      expect(DevTabSchema.safeParse(row({ devServer: 'parcel' })).success).toBe(false)
      expect(DevTabSchema.safeParse(row({ serverBase: '/' })).success).toBe(false)
    })

    it('reads a row from an extension that sends no history as an empty one', () => {
      const { history: _, ...older } = row()
      const parsed = tabs([older])
      expect(parsed?.type === 'dev.tabs' && parsed.tabs[0].history).toEqual([])
    })

    it('takes a host with an underscore, as a URL may carry one', () => {
      expect(tabs([row({ host: 'my_app.localhost:3000' })])?.type).toBe('dev.tabs')
    })

    describe('after hello (parseAfterHello)', () => {
      const after = (m: unknown) => parseAfterHello(typeof m === 'string' ? m : JSON.stringify(m))

      it('passes what parses, whatever its type', () => {
        expect(after({ type: 'dev.tabs', tabs: [row()] })).toEqual({ msg: { type: 'dev.tabs', tabs: [row()] }, dropped: 0 })
        expect(after({ type: 'tab.stopped', sessionId })).toEqual({ msg: { type: 'tab.stopped', sessionId }, dropped: 0 })
      })

      it('keeps the rows of a dev.tabs that do parse, and counts the others', () => {
        expect(after({ type: 'dev.tabs', tabs: [row(), row({ tabId: 2, host: 'bad host/' }), row({ tabId: 3 }), 'junk'] }))
          .toEqual({ msg: { type: 'dev.tabs', tabs: [row(), row({ tabId: 3 })] }, dropped: 2 })
      })

      it('drops a Fremdev message it cannot read, whole, rather than refuse it', () => {
        expect(after({ type: 'dev.tabs', tabs: Array.from({ length: 33 }, (_, i) => row({ tabId: i })) })).toEqual({ msg: null, dropped: 1 })
        expect(after({ type: 'dev.tabs', tabs: 'all' })).toEqual({ msg: null, dropped: 1 })
        expect(after({ type: 'dev.tabs', tabs: [], extra: 1 })).toEqual({ msg: null, dropped: 1 })
        expect(after({ type: 'modules', modules: ['x'.repeat(33)] })).toEqual({ msg: null, dropped: 1 })
        expect(after({ type: 'modules' })).toEqual({ msg: null, dropped: 1 })
        expect(after({ type: 'ping', extra: 1 })).toEqual({ msg: null, dropped: 1 })
      })

      it('passes a dev.report and drops one whose text is over 48 000 characters, keeping the socket', () => {
        const id = '33333333-3333-4333-8333-333333333333'
        const report = { type: 'dev.report', id, tabId: 7, text: 'x'.repeat(48_000) }
        expect(after(report)).toEqual({ msg: report, dropped: 0 })
        expect(after({ ...report, text: 'x'.repeat(48_001) })).toEqual({ msg: null, dropped: 1 })
        expect(after({ ...report, id: 'not-a-uuid' })).toEqual({ msg: null, dropped: 1 })
        expect(after({ ...report, extra: 1 })).toEqual({ msg: null, dropped: 1 })
      })

      it('passes a dev.open.done and drops one with an extra key or a non-boolean ok, keeping the socket', () => {
        const id = '33333333-3333-4333-8333-333333333333'
        const done = { type: 'dev.open.done', id, tabId: 7, ok: true }
        expect(after(done)).toEqual({ msg: done, dropped: 0 })
        expect(after({ ...done, extra: 1 })).toEqual({ msg: null, dropped: 1 })
        expect(after({ ...done, ok: 'yes' })).toEqual({ msg: null, dropped: 1 })
        expect(after({ ...done, id: 'not-a-uuid' })).toEqual({ msg: null, dropped: 1 })
      })

      it('still refuses anything else that does not parse, and what is not JSON or too big', () => {
        expect(after({ type: 'tab.meta', sessionId, meta: { ...meta, title: 'x'.repeat(301) } })).toBeNull()
        expect(after({ type: 'tab.nonsense' })).toBeNull()
        expect(after('not json')).toBeNull()
        expect(after('null')).toBeNull()
        expect(after(JSON.stringify({ type: 'ping' }) + ' '.repeat(MAX_MESSAGE_BYTES))).toBeNull()
      })
    })
  })
})

describe('companionOrigins (the extensions let in)', () => {
  it('lets in Companion alone by default', () => {
    expect([...companionOrigins({}).origins]).toEqual([`chrome-extension://${COMPANION_EXTENSION_ID}`])
    expect(COMPANION_EXTENSION_ID).toBe('lnckeodobpbbmfbdlpnegjpchgkehdlk')
  })

  it('adds the listed ids, trimmed, and sets aside what is not an id', () => {
    const { origins, ignored } = companionOrigins({ FREMKIT_COMPANION_EXTENSION_IDS: ` ${'a'.repeat(32)},,${'b'.repeat(31)}q, chrome-extension://${'c'.repeat(32)}, ${'D'.repeat(32)}` })
    expect([...origins].sort()).toEqual([`chrome-extension://${'a'.repeat(32)}`, `chrome-extension://${COMPANION_EXTENSION_ID}`].sort())
    expect(ignored).toHaveLength(3)
  })

  it('shortens an origin to the first six characters of its id', () => {
    expect(shortExtensionId(`chrome-extension://${COMPANION_EXTENSION_ID}`)).toBe('lnckeo')
  })
})
