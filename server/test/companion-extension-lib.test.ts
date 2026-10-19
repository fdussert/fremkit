import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain JS modules outside server/, no declarations
import { cleanFrames, cleanState, cleanSurvey, control, cropRect, embeddedPlayer, pickVideo, pickedOrigin, placeFrame, survey, youtubeVolume } from '../../companion/lib/video.js'
// @ts-expect-error plain JS module
import { browserName } from '../../companion/lib/browser.js'
// @ts-expect-error plain JS module
import { IDLE_SLACK_MS, idleDelay } from '../../companion/lib/presence.js'
// @ts-expect-error plain JS module
import { closeOutcome, POLICY_CLOSE_CODE, refusalOf, REVOKED_CLOSE_CODE } from '../../companion/lib/link.js'
// @ts-expect-error plain JS module
import { fremplayBlocked, fremplaySwitch, SHARE_ERRORS, shareErrorKey } from '../../companion/lib/errors.js'
// @ts-expect-error plain JS module
import { localCandidatesOnly, loopbackAnswer, loopbackForMdns, offerSdp } from '../../companion/lib/sdp.js'
// @ts-expect-error plain JS module
import { expectedMac, newNonce, PROOF_LABEL, sameBytes, verifyProof } from '../../companion/lib/proof.js'
// @ts-expect-error plain JS module
import { handshake, PROOF_TIMEOUT_MS } from '../../companion/lib/handshake.js'
// @ts-expect-error plain JS module
import * as ext from '../../companion/lib/protocol.js'
// @ts-expect-error plain JS module
import { isOwnContext } from '../../companion/lib/sender.js'
// @ts-expect-error plain JS module
import { grantToReturn } from '../../companion/lib/grant.js'
// @ts-expect-error plain JS module
import { withVolumeHint } from '../../companion/lib/volume.js'
// @ts-expect-error plain JS module
import { navigationClearsRect } from '../../companion/lib/navigation.js'
// @ts-expect-error plain JS module
import * as pairProof from '../../companion/lib/pairProof.js'
import * as serverPairProof from '../src/companion/pairProof.js'
import { CompanionPairing, REQUEST_TTL_MS } from '../src/companion/pairing.js'
import { DeviceStore } from '../src/devices/store.js'
import { CODE_ALPHABET } from '../src/devices/codes.js'
import { isLocalSdp, parseExtensionMessage, PROOF_LABEL as SERVER_PROOF_LABEL, PROTOCOL } from '../src/companion/protocol.js'
import { HELLO_TIMEOUT_MS } from '../src/companion/socket.js'
import { COMPANION_NAMES } from '../src/companion/routes.js'
import { DEVICE_CLOSE_CODE } from '../src/ws/hub.js'

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b'
const RID = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const TOKEN = 'A'.repeat(43)
/** This Mac's addresses, as the server would list them, for the SDP checks. */
const OWN = ['127.0.0.1', '::1', '192.168.1.20', 'fe80::1']

type Rect = { x: number; y: number; w: number; h: number }
const frame = (frameId: number, result: unknown) => ({ frameId, result })
const top = (video: Rect | null, iframes: unknown[] = []) => ({
  href: 'https://example.com/watch', top: true, vw: 1000, vh: 500, title: 'T', video, iframes,
})

describe('pickVideo', () => {
  it('prefers the largest video across frames in top coordinates', () => {
    const frames = [
      frame(0, top({ x: 0, y: 0, w: 200, h: 100 }, [{ src: 'https://player.example.org/embed/1', x: 100, y: 50, w: 800, h: 400 }])),
      // The embedded player is 400x200 in its own viewport, shown at 800x400: scale 2.
      frame(7, { href: 'https://player.example.org/embed/1', top: false, vw: 400, vh: 200, title: '', video: { x: 0, y: 0, w: 400, h: 200 }, iframes: [] }),
    ]
    expect(pickVideo(frames)).toEqual({ frameId: 7, rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } })
  })

  it('prefers a video with a source over a larger empty one, in any frame', () => {
    const iframe = { src: 'https://player.example.org/embed/1', x: 0, y: 0, w: 1000, h: 500 }
    const child = (video: unknown) => frame(7, { href: iframe.src, top: false, vw: 1000, vh: 500, title: '', video, iframes: [] })
    // A big poster placeholder in the top frame, the playing video small in an embed.
    const frames = [frame(0, top({ x: 0, y: 0, w: 1000, h: 500, empty: true } as Rect, [iframe])), child({ x: 0, y: 0, w: 200, h: 100 })]
    expect(pickVideo(frames)).toEqual({ frameId: 7, rect: { x: 0, y: 0, w: 0.2, h: 0.2 } })
    // With nothing but empty ones, the largest still wins: an embed the user has not started.
    const unstarted = [frame(0, top({ x: 0, y: 0, w: 100, h: 50, empty: true } as Rect, [iframe])), child({ x: 0, y: 0, w: 500, h: 250, empty: true })]
    expect(pickVideo(unstarted)).toEqual({ frameId: 7, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } })
  })

  it('returns null when no frame has a visible video', () => {
    expect(pickVideo([frame(0, top(null))])).toBeNull()
    expect(pickVideo([])).toBeNull()
    expect(pickVideo([frame(0, null)])).toBeNull()
    // A video in a frame that cannot be placed is skipped, not guessed.
    expect(pickVideo([frame(0, top(null)), frame(3, { href: 'https://other.example/', top: false, vw: 10, vh: 10, title: '', video: { x: 0, y: 0, w: 10, h: 10 }, iframes: [] })])).toBeNull()
  })
})

describe('placeFrame', () => {
  const iframes = [
    { src: 'https://player.example.org/a', x: 0, y: 0, w: 100, h: 100 },
    { src: 'https://player.example.org/b', x: 0, y: 0, w: 300, h: 300 },
    { src: 'https://elsewhere.example.net/c', x: 0, y: 0, w: 900, h: 900 },
  ]
  it('matches by URL then by origin, else null', () => {
    expect(placeFrame({ href: 'https://player.example.org/a' }, iframes)).toBe(iframes[0])
    expect(placeFrame({ href: 'https://player.example.org/zzz' }, iframes)).toBe(iframes[1])
    expect(placeFrame({ href: 'https://nope.example.com/' }, iframes)).toBeNull()
    expect(placeFrame({ href: 'about:blank' }, iframes)).toBeNull()
  })
})

describe('cropRect', () => {
  it('keeps even dimensions within 1920x1080', () => {
    const c = cropRect({ x: 0, y: 0, w: 1, h: 1 }, 3840, 2160)
    expect(c.w).toBeLessThanOrEqual(1920)
    expect(c.h).toBeLessThanOrEqual(1080)
    expect(c.w % 2).toBe(0)
    expect(c.h % 2).toBe(0)
    expect(c).toMatchObject({ sx: 0, sy: 0, sw: 3840, sh: 2160, w: 1920, h: 1080 })
    const odd = cropRect({ x: 0.1, y: 0.1, w: 0.333, h: 0.333 }, 1001, 777)
    expect(odd.w % 2).toBe(0)
    expect(odd.h % 2).toBe(0)
  })
  it('crops only the visible part of a video scrolled partly out of view', () => {
    const left = cropRect({ x: -0.25, y: 0, w: 0.75, h: 0.5 }, 1000, 1000)
    expect(left).toMatchObject({ sx: 0, sw: 500, sy: 0, sh: 500 })
    const right = cropRect({ x: 0.75, y: 0.5, w: 0.5, h: 0.75 }, 1000, 1000)
    expect(right).toMatchObject({ sx: 750, sw: 250, sy: 500, sh: 500 })
  })
  it('refuses an implausible rectangle', () => {
    expect(cropRect({ x: 0.98, y: 0, w: 0.5, h: 0.5 }, 1000, 1000)).toBeNull()
    expect(cropRect({ x: -0.5, y: 0, w: 0.52, h: 0.5 }, 1000, 1000)).toBeNull()
    expect(cropRect({ x: 0, y: 0, w: 0.01, h: 0.5 }, 1000, 1000)).toBeNull()
    expect(cropRect(null, 1000, 1000)).toBeNull()
  })
})

describe('localCandidatesOnly', () => {
  const cand = (addr: string, typ: string, n: number) => `a=candidate:${n} 1 udp 2113937151 ${addr} 5000${n} typ ${typ} generation 0`
  const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 'm=video 9 UDP/TLS/RTP/SAVPF 96',
    cand('192.168.1.20', 'host', 1), cand('203.0.113.9', 'srflx', 2), cand('198.51.100.7', 'host', 3),
    cand('abcd-1234.local', 'host', 4), cand('10.0.0.5', 'relay', 5), cand('fe80::1', 'host', 6), cand('2001:db8::1', 'host', 7), ''].join('\r\n')

  it('removes srflx and public candidates', () => {
    expect(isLocalSdp(sdp)).toBe(false)
    const out = localCandidatesOnly(sdp)
    expect(out).toContain('192.168.1.20')
    expect(out).toContain('abcd-1234.local')
    expect(out).toContain('fe80::1')
    expect(out).not.toContain('203.0.113.9')
    expect(out).not.toContain('198.51.100.7')
    expect(out).not.toContain('2001:db8')
    expect(out).not.toContain('relay')
    expect(out).toContain('\r\n')
    expect(isLocalSdp(out, OWN)).toBe(true)
  })
})

describe('localCandidatesOnly agrees with the server isLocalSdp', () => {
  // The extension cannot list this Mac's addresses, so it keeps the private ranges; the server
  // narrows them to this Mac's own. A host candidate is its machine's own address, so what the
  // extension keeps passes.
  const addresses = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.20', '169.254.9.9',
    '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'fe80::1%en0',
    'f3a1c2d4-0000-4000-8000-123456789abc.local',
    '198.51.100.7', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '169.253.0.1', '128.0.0.1',
    '2001:db8::1', 'fec0::1', 'fe00::1', 'fe::1', '::', '::ffff:10.0.0.1', 'example.com', 'local',
    '10.0.0', '10.0.0.256', '010.0.0.1', '10.999.1.1', '10.0.0.1.1', 'fe80:zz', 'fe80::1::2', 'fe80:1:2:3:4:5:6:7:8',
    'fe80:1:2:3:4:5:6:7', 'fe80:1:2:3:4:5:6::', ':fe80::1', 'fe80::1:', 'fe80:::1', 'fe80::12345', 'fd00::1.2.3.4', 'fd00::1.2.3.400',
  ]
  it.each(addresses)('%s', (address) => {
    const line = `a=candidate:1 1 udp 2122260223 ${address} 54321 typ host generation 0`
    const offer = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', line, ''].join('\r\n')
    const kept = localCandidatesOnly(offer).includes(line)
    // Kept: the server takes it as long as it is this Mac's (a host candidate always is).
    if (kept) expect(isLocalSdp(offer, [address.split('%')[0]]), address).toBe(true)
    // Dropped: the server would have refused it too.
    else expect(isLocalSdp(offer, OWN), address).toBe(false)
  })
})

describe('loopbackForMdns', () => {
  // As Chrome writes an offscreen document's offer: its address hidden behind an mDNS name.
  const MDNS = 'a=candidate:680590759 1 udp 2113937151 01d56785-bba5-4960-bb7d-61791c640b67.local 60466 typ host generation 0 network-cost 999'
  const offer = (...lines: string[]) => ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', ...lines, 'a=mid:0', ''].join('\r\n')

  it('writes an mDNS host candidate on 127.0.0.1 and leaves every other line alone', () => {
    const real = 'a=candidate:2 1 udp 2113937151 192.168.1.20 50001 typ host generation 0'
    const out = loopbackForMdns(offer(MDNS, real))
    expect(out).toBe(offer(
      'a=candidate:680590759 1 udp 2113937151 127.0.0.1 60466 typ host generation 0 network-cost 999', real))
    expect(isLocalSdp(out, OWN)).toBe(true)
    expect(loopbackForMdns(out)).toBe(out)
  })

  it('touches only host candidates', () => {
    const srflx = 'a=candidate:3 1 udp 1677729535 abcd.local 50002 typ srflx raddr 0.0.0.0 rport 0'
    expect(loopbackForMdns(offer(srflx))).toBe(offer(srflx))
    const bare = ['v=0', 'a=candidate:4 1 udp 1 abcd.local 50003 typ host'].join('\n')
    expect(loopbackForMdns(bare)).toBe('v=0\na=candidate:4 1 udp 1 127.0.0.1 50003 typ host')
  })

  /**
   * What the offscreen document sends is what the Fremplay widget dials: run through the bridge's
   * `local` wrapper, an mDNS-only offer keeps no candidate, and the rewritten one keeps it. Seen in
   * a real run (Chrome offerer, WKWebView answerer configured like the kiosk): without the rewrite
   * the connection stays `new`, with it it connects.
   */
  it('gives the wrapped receiver a candidate it keeps, where the mDNS name gives it none', async () => {
    const bridge = await readFile(fileURLToPath(new URL('../src/bridge/fremkit.js', import.meta.url)), 'utf8')
    const remote: string[] = []
    class Native {
      setRemoteDescription(d: { sdp: string }) { remote.push(d.sdp); return Promise.resolve() }
    }
    const attrs: Record<string, string> = { 'data-webrtc': 'local', 'data-webrtc-hosts': '127.0.0.1 ::1 192.0.2.10' }
    const window: Record<string, unknown> = { RTCPeerConnection: Native, parent: { postMessage: () => {} }, addEventListener: () => {} }
    const document = {
      currentScript: { getAttribute: (n: string) => attrs[n] ?? null },
      documentElement: { classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {}, removeProperty: () => {} } },
      head: { firstChild: null, insertBefore: () => {}, appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {}, textContent: '' }),
      querySelector: () => null,
      addEventListener: () => {},
      dispatchEvent: () => {},
    }
    new Function('window', 'document', 'console', bridge)(window, document, console)
    const RTC = window.RTCPeerConnection as new (c: unknown) => { setRemoteDescription(d: unknown): Promise<void> }
    const kept = (sdp: string) => sdp.split('\r\n').filter((l) => l.startsWith('a=candidate'))

    await new RTC({ iceServers: [] }).setRemoteDescription({ type: 'offer', sdp: localCandidatesOnly(offer(MDNS)) })
    expect(kept(remote[0])).toEqual([])
    await new RTC({ iceServers: [] }).setRemoteDescription({ type: 'offer', sdp: offerSdp(offer(MDNS)) })
    expect(kept(remote[1])).toEqual(['a=candidate:680590759 1 udp 2113937151 127.0.0.1 60466 typ host generation 0 network-cost 999'])
  })

})

describe('offerSdp (what the offscreen document sends)', () => {
  const offer = (...lines: string[]) => ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', ...lines, 'a=mid:0', ''].join('\r\n')
  it('drops what is not local, then writes mDNS names on loopback', () => {
    const mdns = 'a=candidate:1 1 udp 2113937151 0b7d1c2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e.local 60466 typ host generation 0'
    const lan = 'a=candidate:2 1 udp 2113937151 192.168.1.20 50001 typ host generation 0'
    const srflx = 'a=candidate:3 1 udp 1677729535 203.0.113.9 50002 typ srflx raddr 0.0.0.0 rport 0'
    const out = offerSdp(offer(mdns, lan, srflx))
    expect(out).toBe(offer('a=candidate:1 1 udp 2113937151 127.0.0.1 60466 typ host generation 0', lan))
    expect(isLocalSdp(out, OWN)).toBe(true)
    // The extension keeps the private ranges; the server takes only this Mac's own addresses.
    expect(isLocalSdp(out, ['127.0.0.1'])).toBe(false)
  })
})

describe('loopbackAnswer (what the offscreen document applies)', () => {
  const answer = (c: string, ...lines: string[]) => ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', c, ...lines, 'a=mid:0', ''].join('\r\n')
  const cand = (address: string, typ = 'host') => `a=candidate:1 1 udp 2122260223 ${address} 54321 typ ${typ} generation 0`

  it.each([
    ['127.0.0.1', true], ['127.1.2.3', true], ['::1', true], ['::1'.toUpperCase(), true],
    ['f3a1c2d4-0000-4000-8000-123456789abc.local', true],
    ['192.168.1.20', false], ['10.0.0.5', false], ['169.254.9.9', false], ['fe80::1', false], ['fd12::1', false],
    ['198.51.100.7', false], ['2001:db8::1', false], ['128.0.0.1', false], ['0.0.0.0', false], ['::', false],
    ['127.0.0', false], ['127.0.0.256', false], ['0127.0.0.1', false], ['.local', false], ['evil.example.com', false],
  ])('candidate %s kept: %s', (address, kept) => {
    const out = loopbackAnswer(answer('c=IN IP4 0.0.0.0', cand(address)))
    expect(out).not.toBeNull()
    expect(out.includes(cand(address))).toBe(kept)
  })

  it('drops every candidate type but host, even on loopback', () => {
    for (const typ of ['srflx', 'prflx', 'relay']) {
      expect(loopbackAnswer(answer('c=IN IP4 0.0.0.0', cand('127.0.0.1', typ)))).toBe(answer('c=IN IP4 0.0.0.0'))
    }
  })

  it.each([
    ['c=IN IP4 0.0.0.0', true], ['c=IN IP4 127.0.0.1', true], ['c=IN IP4 127.9.9.9', true],
    ['c=IN IP6 ::1', true], ['c=IN IP6 ::', true],
    ['c=IN IP4 192.168.1.20', false], ['c=IN IP4 198.51.100.7', false], ['c=IN IP6 2001:db8::1', false],
    ['c=IN IP6 fe80::1', false], ['c=IN IP4 example.com', false], ['c=IN IP4', false], ['c=garbage', false],
  ])('connection line %s accepted: %s', (c, ok) => {
    expect(loopbackAnswer(answer(c, cand('127.0.0.1'))) !== null).toBe(ok)
  })

  it('refuses the answer when any one of several c= lines points elsewhere', () => {
    expect(loopbackAnswer(answer('c=IN IP4 0.0.0.0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 198.51.100.7'))).toBeNull()
  })

  it('keeps every other line and the line endings', () => {
    const sdp = answer('c=IN IP4 0.0.0.0', 'a=ice-ufrag:abcd', cand('127.0.0.1'), cand('192.0.2.10'), 'a=end-of-candidates')
    expect(loopbackAnswer(sdp)).toBe(answer('c=IN IP4 0.0.0.0', 'a=ice-ufrag:abcd', cand('127.0.0.1'), 'a=end-of-candidates'))
    expect(loopbackAnswer(42)).toBeNull()
  })
})

/** Bytes 0..31 as the token, 32..63 as the nonce. The same vector is in companion-socket.test.ts, run through the server's proofMac. */
const PROOF_VECTOR = {
  token: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  nonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  mac: 'GBxF4yvVJMBOdFy_XX8CFPUkR962kYga-wTrWEAEOus',
}

describe('the server proof, from the extension side', () => {
  it('signs the label the server signs', () => {
    expect(PROOF_LABEL).toBe(SERVER_PROOF_LABEL)
  })

  it('computes the fixed vector the server test pins', async () => {
    expect(await expectedMac(PROOF_VECTOR.token, PROOF_VECTOR.nonce)).toBe(PROOF_VECTOR.mac)
    expect(await verifyProof(PROOF_VECTOR.token, PROOF_VECTOR.nonce, PROOF_VECTOR.mac)).toBe(true)
  })

  it('refuses a wrong mac, a mac for another nonce or token, and garbage', async () => {
    const { token, nonce, mac } = PROOF_VECTOR
    const flipped = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)
    expect(await verifyProof(token, nonce, flipped)).toBe(false)
    expect(await verifyProof(token, newNonce(), mac)).toBe(false)
    expect(await verifyProof(newNonce(), nonce, mac)).toBe(false)
    for (const bad of ['', mac.slice(1), mac + 'AA', 'not base64!', null, 42]) {
      expect(await verifyProof(token, nonce, bad), String(bad)).toBe(false)
    }
  })

  it('compares bytes without caring where they differ', () => {
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
    expect(sameBytes(null, new Uint8Array([1]))).toBe(false)
  })

  it('makes a fresh 32-byte base64url nonce each time', () => {
    const a = newNonce()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newNonce()).not.toBe(a)
  })
})

describe('handshake (the socket opening)', () => {
  const DEVICE = '0b7d1c2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
  const { token, nonce, mac } = PROOF_VECTOR

  function run(opts: { timeoutMs?: number } = {}) {
    const sent: string[] = []
    let impostor = 0
    const hs = handshake({
      socket: { send: (s: string) => sent.push(s) },
      deviceId: DEVICE,
      token,
      nonce,
      hello: () => ext.hello(token, ID),
      onImpostor: () => { impostor++ },
      ...opts,
    })
    return { hs, sent, impostors: () => impostor, leaked: () => sent.some((s) => s.includes(token)) }
  }

  it('gives up on the proof before the server gives up on the whole handshake', () => {
    expect(PROOF_TIMEOUT_MS).toBe(4_000)
    expect(PROOF_TIMEOUT_MS).toBeLessThan(HELLO_TIMEOUT_MS)
  })

  it('sends a challenge the server parses, and no token', () => {
    const t = run()
    t.hs.open()
    expect(t.sent).toHaveLength(1)
    expect(JSON.parse(t.sent[0])).toEqual({ type: 'challenge', deviceId: DEVICE, nonce })
    expect(parseExtensionMessage(t.sent[0])).not.toBeNull()
    expect(t.leaked()).toBe(false)
    t.hs.cancel()
  })

  it('sends hello with the token only after a valid proof', async () => {
    const t = run()
    t.hs.open()
    await t.hs.receive({ type: 'proof', mac })
    expect(t.hs.proven).toBe(true)
    expect(t.sent).toHaveLength(2)
    expect(JSON.parse(t.sent[1])).toMatchObject({ type: 'hello', token, protocol: PROTOCOL })
    expect(t.impostors()).toBe(0)
  })

  it.each([
    ['a wrong mac', { type: 'proof', mac: 'A'.repeat(43) }],
    ['a proof with no mac', { type: 'proof' }],
    ['ready before any proof', { type: 'ready', protocol: PROTOCOL }],
    ['something that is not JSON', null],
  ])('never writes the token after %s, and calls it an impostor', async (_label, msg) => {
    const t = run()
    t.hs.open()
    await t.hs.receive(msg)
    // Even a valid proof after that changes nothing: the socket is done.
    await t.hs.receive({ type: 'proof', mac })
    expect(t.leaked()).toBe(false)
    expect(t.hs.proven).toBe(false)
    expect(t.impostors()).toBe(1)
  })

  it('calls it an impostor when no proof comes in time, and a late one sends nothing', async () => {
    const t = run({ timeoutMs: 20 })
    t.hs.open()
    await new Promise((r) => setTimeout(r, 40))
    expect(t.impostors()).toBe(1)
    await t.hs.receive({ type: 'proof', mac })
    expect(t.leaked()).toBe(false)
  })

  it('a second message while the proof is being checked is an impostor too', async () => {
    const t = run()
    t.hs.open()
    const checking = t.hs.receive({ type: 'proof', mac })
    await t.hs.receive({ type: 'proof', mac })
    await checking
    expect(t.leaked()).toBe(false)
    expect(t.impostors()).toBe(1)
  })

  it('a socket closed before the proof sends nothing and accuses no one', async () => {
    const t = run({ timeoutMs: 20 })
    t.hs.open()
    t.hs.cancel()
    await new Promise((r) => setTimeout(r, 40))
    expect(t.impostors()).toBe(0)
    expect(t.leaked()).toBe(false)
  })
})

describe('protocol builders', () => {
  const meta = { title: 'x'.repeat(400), host: 'example.com', currentTime: 3, duration: Infinity, paused: false, muted: false, volume: 0.5 }
  it('produce messages the server parseExtensionMessage accepts', () => {
    expect(ext.PROTOCOL).toBe(PROTOCOL)
    const sdp = 'v=0\r\na=candidate:1 1 udp 1 127.0.0.1 50000 typ host\r\n'
    const msgs = [
      ext.hello(TOKEN, ID),
      ext.hello(TOKEN, ID, { sessionId: RID, meta }),
      ext.started(ID, meta),
      ext.meta(ID, meta),
      ext.offer(ID, RID, sdp),
      ext.stopped(ID),
    ]
    for (const m of msgs) expect(parseExtensionMessage(JSON.stringify(m)), JSON.stringify(m).slice(0, 80)).not.toBeNull()
  })
  it('clamps odd page values into a valid meta', () => {
    const m = ext.cleanMeta({ ...meta, currentTime: NaN, volume: 7, host: 'EXAMPLE.com' })
    expect(m.title).toHaveLength(300)
    expect(m.duration).toBe(0)
    expect(m.currentTime).toBe(0)
    expect(m.volume).toBe(1)
    expect(ext.cleanMeta({ ...meta, duration: 1e9 }).duration).toBe(604800)
  })
  it('derives a host from a URL', () => {
    expect(ext.hostOf('https://www.example.com:8080/a?b')).toBe('www.example.com')
    expect(ext.hostOf('garbage')).toBe('unknown')
  })
})

// Minimal fakes: survey and control only touch these members.
const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h, top: y, left: x, bottom: y + h, right: x + w })
function fakeVideo(w: number, h: number, extra: Record<string, unknown> = {}) {
  const el: any = { clientWidth: w, clientHeight: h, paused: true, currentTime: 50, duration: 100, volume: 0.5, muted: false,
    currentSrc: 'https://example.com/v.mp4', readyState: 4,
    getBoundingClientRect: () => box(10, 20, w, h), play() { el.paused = false }, pause() { el.paused = true }, ...extra }
  return el
}
function install(videos: any[], iframes: any[] = [], movie: any = null, isTop = true) {
  const g = globalThis as any
  const win: any = { innerWidth: 1000, innerHeight: 500 }
  win.top = isTop ? win : {}
  g.window = win
  g.innerWidth = 1000
  g.innerHeight = 500
  g.location = { href: 'https://example.com/watch' }
  g.document = {
    title: 'Page',
    querySelectorAll: (s: string) => (s === 'video' ? videos : s === 'iframe' ? iframes : []),
    getElementById: (id: string) => (id === 'movie_player' ? movie : null),
  }
}

describe('survey (in-page)', () => {
  it('reports the largest visible video and the iframes of the top frame', () => {
    install([fakeVideo(100, 50), fakeVideo(400, 200), fakeVideo(0, 0, { getBoundingClientRect: () => box(0, 0, 0, 0) })],
      [{ src: 'https://p.example.org/e', getBoundingClientRect: () => box(5, 6, 300, 200) },
        { src: 'https://q.example.org/e', allow: 'autoplay; fullscreen', getBoundingClientRect: () => box(0, 0, 50, 50) },
        { src: 'https://r.example.org/e', allowFullscreen: true, getBoundingClientRect: () => box(0, 0, 60, 60) }])
    const r = survey()
    expect(r).toMatchObject({ href: 'https://example.com/watch', top: true, vw: 1000, vh: 500, title: 'Page', video: { x: 10, y: 20, w: 400, h: 200 } })
    expect(r.iframes).toEqual([
      { src: 'https://p.example.org/e', fs: false, x: 5, y: 6, w: 300, h: 200 },
      { src: 'https://q.example.org/e', fs: true, x: 0, y: 0, w: 50, h: 50 },
      { src: 'https://r.example.org/e', fs: true, x: 0, y: 0, w: 60, h: 60 },
    ])
  })
  it('counts a visible video that has no source yet (an embed not started), marked empty', () => {
    const none = { currentSrc: '', readyState: 0 }
    install([fakeVideo(100, 50, none), fakeVideo(1000, 500, none)])
    expect(survey().video).toEqual({ x: 10, y: 20, w: 1000, h: 500, empty: true })
  })
  it('prefers a smaller video with a source over a large empty placeholder', () => {
    install([fakeVideo(1000, 500, { currentSrc: '', readyState: 0 }), fakeVideo(100, 50, { paused: false })])
    expect(survey().video).toEqual({ x: 10, y: 20, w: 100, h: 50 })
    // A stream (srcObject) or a src set without a load yet count as a source too.
    install([fakeVideo(1000, 500, { currentSrc: '', readyState: 0 }), fakeVideo(100, 50, { currentSrc: '', readyState: 0, srcObject: {} })])
    expect(survey().video).toEqual({ x: 10, y: 20, w: 100, h: 50 })
    install([fakeVideo(1000, 500, { currentSrc: '', readyState: 0 }), fakeVideo(100, 50, { currentSrc: '', readyState: 0, src: 'https://example.com/v.mp4' })])
    expect(survey().video).toEqual({ x: 10, y: 20, w: 100, h: 50 })
  })
  it('gives no iframes from a child frame and null without a video', () => {
    install([], [{ src: 'https://p.example.org/e', getBoundingClientRect: () => box(5, 6, 300, 200) }], null, false)
    const r = survey()
    expect(r.video).toBeNull()
    expect(r.top).toBe(false)
    expect(r.iframes).toEqual([])
  })
})

describe('control (in-page)', () => {
  it('toggles, seeks within bounds, sets volume and mutes the element', () => {
    const v = fakeVideo(400, 200)
    install([fakeVideo(10, 10), v])
    expect(control('toggle')).toMatchObject({ paused: false })
    expect(control('seek', { delta: 10 })).toMatchObject({ currentTime: 60 })
    v.currentTime = 95
    expect(control('seek', { delta: 10 }).currentTime).toBe(100)
    v.currentTime = 4
    expect(control('seek', { delta: -10 }).currentTime).toBe(0)
    expect(control('volume', { value: 0.25 })).toMatchObject({ volume: 0.25, muted: false })
    expect(control('mute')).toMatchObject({ muted: true })
    expect(control('mute')).toMatchObject({ muted: false })
    expect(control(null)).toMatchObject({ paused: false, duration: 100 })
  })
  it('acts on the same video survey picks: one with a source before a larger empty one', () => {
    const playing = fakeVideo(100, 50)
    install([fakeVideo(1000, 500, { currentSrc: '', readyState: 0 }), playing])
    control('toggle')
    expect(playing.paused).toBe(false)
  })
  it('acts on the element only, whatever YouTube player the page has', () => {
    const yt = { setVolume: () => { throw new Error('not from the isolated world') } }
    const v = fakeVideo(400, 200)
    install([v], [], yt)
    expect(control('volume', { value: 0.8 })).toMatchObject({ volume: 0.8, muted: false })
    expect(control('mute')).toMatchObject({ muted: true })
  })
  it('returns null with no video and a finite duration for a live stream', () => {
    install([])
    expect(control('toggle')).toBeNull()
    install([fakeVideo(10, 10, { duration: Infinity })])
    expect(control(null)!.duration).toBe(0)
  })
})

describe('youtubeVolume (the one main-world call)', () => {
  it("goes through YouTube's player and says only whether it took it", () => {
    let vol = 40, muted = true
    const yt = { getVolume: () => vol, setVolume: (n: number) => { vol = n }, isMuted: () => muted, mute: () => { muted = true }, unMute: () => { muted = false } }
    install([fakeVideo(400, 200)], [], yt)
    expect(youtubeVolume('volume', 0.8)).toBe(true)
    expect(vol).toBe(80)
    expect(muted).toBe(false)
    expect(youtubeVolume('volume', 7)).toBe(true)
    expect(vol).toBe(100)
    expect(youtubeVolume('mute')).toBe(true)
    expect(muted).toBe(true)
    expect(youtubeVolume('seek', 10)).toBe(false)
  })
  it('is false without a player, or with one that throws', () => {
    install([fakeVideo(400, 200)])
    expect(youtubeVolume('volume', 0.5)).toBe(false)
    install([fakeVideo(400, 200)], [], { setVolume: () => { throw new Error('page') }, unMute: () => {} })
    expect(youtubeVolume('volume', 0.5)).toBe(false)
  })
})

describe('what the page reports is cleaned before use', () => {
  it('drops a report that is not one, and bounds the rest', () => {
    for (const bad of [null, 'x', 42, {}, { vw: NaN, vh: 500 }, { vw: 1000, vh: 0 }, { vw: Infinity, vh: 500 }]) {
      expect(cleanSurvey(bad)).toBeNull()
    }
    const r = cleanSurvey({
      href: 'h'.repeat(5000), top: 'yes', vw: 1000, vh: 500, title: 't'.repeat(1000), extra: 'dropped',
      video: { x: NaN, y: 0, w: 10, h: 10 }, iframes: [{ src: 'https://p.example.org/e', fs: true, x: 0, y: 0, w: 10, h: 10 }],
    })
    expect(r).toEqual({ href: '', top: false, vw: 1000, vh: 500, title: 't'.repeat(300), video: null, iframes: [] })
    const t = cleanSurvey({
      href: 'https://example.com/', top: true, vw: 1000, vh: 500, title: 7, video: { x: 1, y: 2, w: 3, h: 4 },
      iframes: [
        { src: 'https://p.example.org/e', fs: 1, x: 0, y: 0, w: 10, h: 10 },
        { src: 42, x: 0, y: 0, w: 10, h: 10 },
        { src: 'https://q.example.org/e', x: 0, y: 0, w: -1, h: 10 },
        { src: 'https://r.example.org/e', x: 1e12, y: 0, w: 10, h: 10 },
        null,
        ...Array.from({ length: 200 }, () => ({ src: 'https://s.example.org/e', x: 0, y: 0, w: 1, h: 1 })),
      ],
    })!
    expect(t.title).toBe('')
    expect(t.video).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    // `empty` is kept only as `true`; any other value is dropped.
    expect(cleanSurvey({ ...t, video: { x: 1, y: 2, w: 3, h: 4, empty: true } })!.video).toEqual({ x: 1, y: 2, w: 3, h: 4, empty: true })
    expect(cleanSurvey({ ...t, video: { x: 1, y: 2, w: 3, h: 4, empty: 'yes' } })!.video).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    expect(t.iframes[0]).toEqual({ src: 'https://p.example.org/e', fs: false, x: 0, y: 0, w: 10, h: 10 })
    expect(t.iframes.length).toBeLessThanOrEqual(100)
    expect(t.iframes.every((f: { src: string }) => typeof f.src === 'string')).toBe(true)
  })
  it('keeps only frames with a usable id', () => {
    const ok = { href: 'https://example.com/', top: true, vw: 1000, vh: 500, title: '', video: null, iframes: [] }
    expect(cleanFrames(null)).toEqual([])
    expect(cleanFrames([{ frameId: 0, result: ok }, { frameId: -1, result: ok }, { frameId: '2', result: ok }, null, { frameId: 3, result: 'junk' }]))
      .toEqual([{ frameId: 0, result: ok }, { frameId: 3, result: null }])
  })
  it('gives the picker nothing to choke on', () => {
    const frames = cleanFrames([{ frameId: 0, result: { href: 'https://example.com/', top: true, vw: 1000, vh: 500, video: { x: 0, y: 0, w: Infinity, h: 1 } } }])
    expect(pickVideo(frames)).toBeNull()
    expect(embeddedPlayer(frames, null)).toBeNull()
  })
  it('bounds a control state as the server schema does', () => {
    expect(cleanState(null)).toBeNull()
    expect(cleanState('x')).toBeNull()
    expect(cleanState({ paused: 'no', currentTime: -5, duration: Infinity, volume: 3, muted: 1, title: 'dropped' }))
      .toEqual({ paused: true, currentTime: 0, duration: 0, volume: 1, muted: false })
    expect(cleanState({ paused: false, currentTime: 1e9, duration: 60, volume: 0.25, muted: true }))
      .toEqual({ paused: false, currentTime: 604800, duration: 60, volume: 0.25, muted: true })
  })
})

describe('embeddedPlayer', () => {
  const player = (src: string, x: number, w: number, h: number, fs = true) => ({ src, fs, x, y: 0, w, h })
  const page = (iframes: unknown[]) => frame(0, top(null, iframes))

  it('names the largest cross-origin player iframe the survey could not see into', () => {
    const frames = [page([
      player('https://player.example.org/embed/1', 0, 500, 250),
      player('https://big.example.net/embed/2', 0, 800, 400),
      player('https://example.com/same-origin', 0, 900, 450),
    ])]
    expect(embeddedPlayer(frames, null)).toBe('https://big.example.net')
  })

  it('leaves out ads, small frames, frames it already sees and frames smaller than the video found', () => {
    expect(embeddedPlayer([page([player('https://ads.example.net/a', 0, 970, 250, false)])], null)).toBeNull()
    expect(embeddedPlayer([page([player('https://p.example.org/e', 0, 200, 400)])], null)).toBeNull()
    const seen = [page([player('https://p.example.org/e', 0, 800, 400)]),
      frame(4, { href: 'https://p.example.org/e', top: false, vw: 800, vh: 400, title: '', video: null, iframes: [] })]
    expect(embeddedPlayer(seen, null)).toBeNull()
    const picked = { frameId: 0, rect: { x: 0, y: 0, w: 0.9, h: 0.9 } }
    expect(embeddedPlayer([page([player('https://p.example.org/e', 0, 800, 400)])], picked)).toBeNull()
    expect(embeddedPlayer([page([player('about:blank', 0, 800, 400)])], null)).toBeNull()
    expect(embeddedPlayer([], null)).toBeNull()
  })
})

describe('pickedOrigin (which granted frame keeps its grant)', () => {
  const ORIGIN = 'https://player.example.org'
  const slots = [`${ORIGIN}/a`, `${ORIGIN}/b`, 'https://other.example.net/e'].map((src, i) => ({ src, x: 0, y: i * 100, w: 800, h: 400 }))
  const page = (video: unknown = null) => frame(0, top(video as Rect | null, slots))
  const child = (id: number, href: string, video: unknown) => frame(id, { href, top: false, vw: 800, vh: 400, title: '', video, iframes: [] })
  const big = { x: 0, y: 0, w: 640, h: 360 }
  const cases: [string, unknown[], string | null][] = [
    ['the frame holding the shared video', [page(), child(5, `${ORIGIN}/b`, big)], ORIGIN],
    ['an empty video there, when it is the only one (an embed not started)', [page(), child(5, `${ORIGIN}/b`, { ...big, empty: true })], ORIGIN],
    ['a granted frame without a video', [page({ x: 0, y: 0, w: 900, h: 450 }), child(3, `${ORIGIN}/a`, null)], 'https://example.com'],
    ['a placeholder in the granted frame while the top frame plays',
      [page({ x: 0, y: 0, w: 100, h: 50 }), child(3, `${ORIGIN}/a`, { ...big, empty: true })], 'https://example.com'],
    ['a video in a frame of another origin', [page(), child(4, 'https://other.example.net/e', big)], 'https://other.example.net'],
    ['no video anywhere', [page(), child(3, `${ORIGIN}/a`, null)], null],
    ['a frame that did not answer', [page(), { frameId: 7, result: null }], null],
    ['no frames at all', [], null],
  ]
  it.each(cases)('%s', (_, frames, expected) => {
    expect(pickedOrigin(frames)).toBe(expected)
  })
})

describe('browserName', () => {
  it('names the browser from its brands', () => {
    const brands = (...names: string[]) => names.map((brand) => ({ brand, version: '130' }))
    expect(browserName(brands('Not)A;Brand', 'Chromium', 'Google Chrome'))).toBe('Chrome')
    expect(browserName(brands('Chromium', 'Microsoft Edge', 'Not_A Brand'))).toBe('Microsoft Edge')
    expect(browserName(brands('Brave', 'Chromium', 'Not.A/Brand'))).toBe('Brave')
    expect(browserName(brands('Chromium', 'Not.A/Brand'))).toBe('Chromium')
    expect(browserName(undefined)).toBe('Chromium')
  })

  // Synthetic brands, Arc's and Vivaldi's included: this proves the mapping stays within the
  // server's list, not that those browsers report such a brand (they are not known to).
  it('only ever gives a name the server takes', () => {
    const brands = (...names: string[]) => names.map((brand) => ({ brand, version: '130' }))
    const seen = new Set<string>()
    for (const list of [['Google Chrome'], ['Microsoft Edge'], ['Brave'], ['Arc'], ['Opera'], ['Opera GX'], ['Vivaldi'],
      ['Chromium'], ['Yandex'], ['Approve this, it is safe'], []]) {
      seen.add(browserName(brands(...list)))
    }
    for (const name of seen) expect(COMPANION_NAMES).toContain(name)
    expect([...seen].sort()).toEqual([...COMPANION_NAMES].sort())
  })
})

describe('idleDelay', () => {
  it('waits out the whole presence window, not a fixed slack', () => {
    // A stop 5 s into a 30 s window: the check comes after the remaining 25 s.
    expect(idleDelay(30_000, 5_000)).toBe(25_000 + IDLE_SLACK_MS)
  })
  it('checks right away once the window is over', () => {
    expect(idleDelay(1_000, 1_000)).toBe(IDLE_SLACK_MS)
    expect(idleDelay(1_000, 9_000)).toBe(IDLE_SLACK_MS)
  })
})

describe('closeOutcome', () => {
  it('uses the codes the server closes with', () => {
    expect(REVOKED_CLOSE_CODE).toBe(DEVICE_CLOSE_CODE)
    expect(POLICY_CLOSE_CODE).toBe(1008)
  })

  it('forgets the token on 4401 only once the server proved itself, before or after ready', () => {
    expect(closeOutcome(4401, { proven: true })).toBe('revoked')
    expect(closeOutcome(4401, { proven: true, greeted: true })).toBe('revoked')
  })

  it('keeps the token on a 4401 before any proof, and shows the extension removed', () => {
    expect(closeOutcome(4401, { proven: false })).toBe('removed')
    expect(closeOutcome(4401)).toBe('removed')
  })

  it('says an update is due on a 1008 before any proof', () => {
    expect(closeOutcome(1008, { proven: false })).toBe('refused')
  })

  it('reconnects after a 1008 once proven (a slow server) or greeted, or any other close', () => {
    expect(closeOutcome(1008, { proven: true })).toBe('retry')
    expect(closeOutcome(1008, { proven: true, greeted: true })).toBe('retry')
    for (const code of [1000, 1001, 1006, 1009, 1011]) {
      expect(closeOutcome(code, { proven: false })).toBe('retry')
      expect(closeOutcome(code, { proven: true, greeted: true })).toBe('retry')
    }
  })

  it('reads the handshake as the worker does: a 4401 unpairs only after a valid proof', async () => {
    const make = () => handshake({
      socket: { send: () => {} }, deviceId: ID, token: PROOF_VECTOR.token, nonce: PROOF_VECTOR.nonce,
      hello: () => ext.hello(PROOF_VECTOR.token, ID), onImpostor: () => {},
    })
    const before = make()
    before.open()
    before.cancel()
    expect(closeOutcome(4401, { proven: before.proven })).toBe('removed')
    const after = make()
    after.open()
    await after.receive({ type: 'proof', mac: PROOF_VECTOR.mac })
    after.cancel()
    expect(closeOutcome(4401, { proven: after.proven })).toBe('revoked')
  })
})

describe('refusalOf (what a tab.refused does to the share)', () => {
  it('a refused offer costs only that receiver: the share goes on, nothing is retried, the popup says why', () => {
    expect(refusalOf('offer')).toEqual({ endShare: false, error: 'offerRefused' })
  })

  it('no widget ends the share as such, and anything else as an update due', () => {
    expect(refusalOf('noWidget')).toEqual({ endShare: true, error: 'noWidget' })
    expect(refusalOf('disabled')).toEqual({ endShare: true, error: 'disabled' })
    expect(refusalOf('protocol')).toEqual({ endShare: true, error: 'protocol' })
    expect(refusalOf('something new')).toEqual({ endShare: true, error: 'protocol' })
    expect(refusalOf(undefined)).toEqual({ endShare: true, error: 'protocol' })
  })
})

describe('isOwnContext (who the worker and the offscreen document listen to)', () => {
  const EXT_ID = 'lnckeodobpbbmfbdlpnegjpchgkehdlk'
  const BASE = `chrome-extension://${EXT_ID}/`
  const own = { id: EXT_ID, base: BASE, tabPages: [`${BASE}options.html`] }
  const cases: [string, unknown, boolean][] = [
    ['the popup', { id: EXT_ID, url: `${BASE}popup.html` }, true],
    ['the offscreen document', { id: EXT_ID, url: `${BASE}offscreen.html` }, true],
    ['the worker', { id: EXT_ID, url: `${BASE}worker.js` }, true],
    ['the options page in its tab', { id: EXT_ID, url: `${BASE}options.html`, tab: { id: 4 } }, true],
    ['the options page with a fragment', { id: EXT_ID, url: `${BASE}options.html#x`, tab: { id: 4 } }, true],
    ['code injected into a page', { id: EXT_ID, url: 'https://example.com/watch', tab: { id: 4 }, frameId: 0 }, false],
    ['injected code in a page that claims no tab', { id: EXT_ID, url: 'https://example.com/watch' }, false],
    ['another extension page in a tab', { id: EXT_ID, url: `${BASE}popup.html`, tab: { id: 4 } }, false],
    ['another extension', { id: 'abcdefghijklmnopabcdefghijklmnop', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html' }, false],
    ['our id on another base', { id: EXT_ID, url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html' }, false],
    ['no URL', { id: EXT_ID }, false],
    ['no sender', undefined, false],
  ]
  it.each(cases)('%s', (_, sender, expected) => {
    expect(isOwnContext(sender, own)).toBe(expected)
  })
  it('refuses every tab when no page is listed, and an empty id or base', () => {
    expect(isOwnContext({ id: EXT_ID, url: `${BASE}options.html`, tab: { id: 1 } }, { id: EXT_ID, base: BASE })).toBe(false)
    expect(isOwnContext({ id: '', url: BASE }, { id: '', base: BASE })).toBe(false)
    expect(isOwnContext({ id: EXT_ID, url: 'https://example.com/' }, { id: EXT_ID, base: '' })).toBe(false)
  })
})

describe('grantToReturn (the grant a start gives back)', () => {
  const ORIGIN = 'https://player.example.org'
  const slot = [{ src: `${ORIGIN}/e`, x: 0, y: 0, w: 800, h: 400 }]
  const child = (video: unknown) => frame(3, { href: `${ORIGIN}/e`, top: false, vw: 800, vh: 400, title: '', video, iframes: [] })
  const withVideo = [frame(0, top(null, slot)), child({ x: 0, y: 0, w: 640, h: 360 })]
  const withoutVideo = [frame(0, top({ x: 0, y: 0, w: 500, h: 250 }, slot)), child(null)]
  // The share plays the top frame's video; the granted frame only holds an empty placeholder.
  const placeholder = [frame(0, top({ x: 0, y: 0, w: 100, h: 50 }, slot)), child({ x: 0, y: 0, w: 640, h: 360, empty: true })]
  const cases: [string, string | null, { ok: boolean; frames: unknown[] | null }, string | null][] = [
    ['nothing was granted', null, { ok: false, frames: null }, null],
    ['a share that started on a frame holding a video keeps it', ORIGIN, { ok: true, frames: withVideo }, null],
    ['a share that started from another video, the granted frame empty', ORIGIN, { ok: true, frames: withoutVideo }, ORIGIN],
    ['a share that started from another video, the granted frame holding a placeholder', ORIGIN, { ok: true, frames: placeholder }, ORIGIN],
    ['not paired, or the tab gone, before any survey', ORIGIN, { ok: false, frames: null }, ORIGIN],
    ['the survey failed', ORIGIN, { ok: false, frames: null }, ORIGIN],
    ['the capture or the server failed after a survey that found the video', ORIGIN, { ok: false, frames: withVideo }, ORIGIN],
    ['no video anywhere', ORIGIN, { ok: false, frames: withoutVideo }, ORIGIN],
  ]
  it.each(cases)('%s', (_, granted, outcome, expected) => {
    expect(grantToReturn(granted, outcome)).toBe(expected)
  })
})

/** The same vector as companion-pairing.test.ts, run through the server's pairProof.ts. */
const PAIR_VECTOR = {
  code: 'K7QM',
  requestId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  saltE: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
  nonceE: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  nonceS: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
  key: 'd2251f020b5813c71915e6bd6a177c5b7084cb77191490652db6e5f75cddd07b',
  macE: '_huEmBB_3xIIb2oMKwKocn07PmFRHCYoUnO7oEwq6sI',
  macS: 'c_VTA4VlGyCivQazYRZc3wRYoM-V_6gvDOVq6zqnuho',
}

const SALT_E = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU'

describe('the typed-code proof, from the extension side', () => {
  it('uses the server\'s cost, salt, labels and answer bound', () => {
    for (const k of ['PAIR_KEY_ITERATIONS', 'PAIR_SALT_PREFIX', 'PAIR_SERVER_LABEL', 'PAIR_CLIENT_LABEL', 'PAIR_ANSWER_MS'] as const) {
      expect(pairProof[k], k).toBe(serverPairProof[k])
    }
    expect(pairProof.PAIR_ANSWER_MS).toBe(2_000)
  })

  it('computes the fixed vector the server test pins', async () => {
    const v = PAIR_VECTOR
    const key: Uint8Array = await pairProof.pairKey(v.code, v.requestId, v.saltE)
    expect(Buffer.from(key).toString('hex')).toBe(v.key)
    expect(await pairProof.pairClientMac(key, v.requestId, v.nonceE)).toBe(v.macE)
    expect(await pairProof.pairServerMac(key, v.requestId, v.nonceE, v.nonceS)).toBe(v.macS)
  })

  it('bounds the server\'s deadline by a request\'s life', () => {
    const now = 1_000_000
    expect(pairProof.PAIR_TTL_MS).toBe(REQUEST_TTL_MS)
    expect(pairProof.pairingDeadline(now + 60_000, now)).toBe(now + 60_000)
    expect(pairProof.pairingDeadline(now + REQUEST_TTL_MS, now)).toBe(now + REQUEST_TTL_MS)
    // A server that says "wait a year" is waited on for two minutes.
    expect(pairProof.pairingDeadline(now + 365 * 86_400_000, now)).toBe(now + REQUEST_TTL_MS)
    for (const bad of [undefined, null, '1000', Number.NaN, Infinity]) expect(pairProof.pairingDeadline(bad, now), String(bad)).toBeNull()
  })

  it('reads a typed code in any case, with spaces or a dash, and nothing outside the alphabet', () => {
    expect(pairProof.normalizeCode('k7qm')).toBe('K7QM')
    expect(pairProof.normalizeCode(' K7-QM ')).toBe('K7QM')
    expect(pairProof.CODE_LENGTH).toBe(4)
    for (const bad of ['', 'K7Q', 'K7QMX', 'K7Q0', 'K7QI', 'K7Q1', 'K7QO', 'K7Q!', null, undefined, 42]) {
      expect(pairProof.normalizeCode(bad), String(bad)).toBeNull()
    }
    for (const c of CODE_ALPHABET) expect(pairProof.normalizeCode(c.repeat(4))).toBe(c.repeat(4))
  })

  type Sent = { step: string; body: Record<string, unknown> }

  /** `confirmCode` against the real pairing, through a `post` that records what it sent. */
  async function withPairing(run: (ctx: {
    pairing: CompanionPairing; requestId: string; code: string; sent: Sent[]
    post: (step: string, body: Record<string, unknown>) => Promise<unknown>
  }) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-companion-ext-'))
    const store = new DeviceStore(join(dir, 'devices.json'))
    await store.load()
    const pairing = new CompanionPairing(store)
    const origin = `chrome-extension://${'a'.repeat(32)}`
    try {
      const r = pairing.request({ origin, name: 'Chrome', installId: ID, salt: SALT_E })
      if (typeof r === 'string') throw new Error(r)
      const sent: Sent[] = []
      const post = async (step: string, body: Record<string, unknown>) => {
        sent.push({ step, body })
        return pairing.confirm(r.requestId, origin, body.nonce as string, body.mac as string)
      }
      await run({ pairing, requestId: r.requestId, code: r.code, sent, post })
    } finally {
      pairing.dispose()
      await store.settled()
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('pairs with the Edge\'s code against the real server side, proving first', async () => {
    await withPairing(async ({ requestId, code, sent, post }) => {
      const got = await pairProof.confirmCode({ salt: SALT_E, post, requestId, code })
      expect(got).toMatchObject({ state: 'paired', token: expect.any(String), deviceId: expect.any(String) })
      expect(sent).toHaveLength(1)
      expect(Object.keys(sent[0].body).sort()).toEqual(['mac', 'nonce'])
    })
  })

  it('a wrong code is wrong, wrong, then exhausted, and the right one is too late after', async () => {
    await withPairing(async ({ requestId, code, post }) => {
      const other = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ'
      expect(await pairProof.confirmCode({ salt: SALT_E, post, requestId, code: other })).toEqual({ state: 'wrong' })
      expect(await pairProof.confirmCode({ salt: SALT_E, post, requestId, code: other })).toEqual({ state: 'wrong' })
      expect(await pairProof.confirmCode({ salt: SALT_E, post, requestId, code: other })).toEqual({ state: 'exhausted' })
      expect(await pairProof.confirmCode({ salt: SALT_E, post, requestId, code })).toEqual({ state: 'refused' })
    })
  })

  /** A server answering `paired` with this token; `macFor` gives its macS from K and the nonces. */
  function fakeServer(macFor: (key: Uint8Array, nonceE: string, nonceS: string) => Promise<string> | string) {
    const nonceS = 'B'.repeat(43)
    return async (_step: string, body: Record<string, unknown>) => {
      const key = await pairProof.pairKey('K7QM', RID, SALT_E)
      return { state: 'paired', nonce: nonceS, mac: await macFor(key, body.nonce as string, nonceS), token: TOKEN, deviceId: ID }
    }
  }
  const rightMac = (key: Uint8Array, nonceE: string, nonceS: string) => pairProof.pairServerMac(key, RID, nonceE, nonceS)

  it('salts K with its own salt: a server keyed for another salt is an impostor', async () => {
    const otherSalt = (_k: Uint8Array, nE: string, nS: string) =>
      pairProof.pairKey('K7QM', RID, 'C'.repeat(43)).then((k: Uint8Array) => pairProof.pairServerMac(k, RID, nE, nS))
    expect(await pairProof.confirmCode({ salt: SALT_E, post: fakeServer(otherSalt), requestId: RID, code: 'K7QM' })).toEqual({ state: 'impostor' })
  })

  it('takes the token from a server whose proof checks', async () => {
    expect(await pairProof.confirmCode({ salt: SALT_E, post: fakeServer(rightMac), requestId: RID, code: 'K7QM' }))
      .toEqual({ state: 'paired', token: TOKEN, deviceId: ID })
  })

  it('drops the token of a server whose proof does not check: a wrong mac, another code\'s, garbage, none', async () => {
    const wrongs = [
      () => 'A'.repeat(43),
      async (_k: Uint8Array, nE: string, nS: string) => pairProof.pairServerMac(await pairProof.pairKey('ZZZZ', RID, SALT_E), RID, nE, nS),
      // The extension's own proof sent back is not the server's.
      (k: Uint8Array, nE: string) => pairProof.pairClientMac(k, RID, nE),
      // The server's mac for another nonce of the extension's.
      (k: Uint8Array, _nE: string, nS: string) => pairProof.pairServerMac(k, RID, 'C'.repeat(43), nS),
      () => '',
      () => undefined as unknown as string,
    ]
    for (const macFor of wrongs) {
      const got = await pairProof.confirmCode({ salt: SALT_E, post: fakeServer(macFor), requestId: RID, code: 'K7QM' })
      expect(got).toEqual({ state: 'impostor' })
      expect(JSON.stringify(got)).not.toContain(TOKEN)
    }
  })

  it('drops the token of a right proof that came back after two seconds', async () => {
    vi.useFakeTimers()
    try {
      const slow = fakeServer(rightMac)
      let posted!: () => void
      const sentProof = new Promise<void>((resolve) => { posted = resolve })
      const post = (step: string, body: Record<string, unknown>) => {
        posted()
        return new Promise((resolve) => setTimeout(() => resolve(slow(step, body)), 2_500))
      }
      const pending = pairProof.confirmCode({ salt: SALT_E, post, requestId: RID, code: 'K7QM' })
      // K is derived off the timers' clock; once the proof is out, two seconds pass with no answer.
      await sentProof
      await vi.advanceTimersByTimeAsync(2_001)
      expect(await pending).toEqual({ state: 'impostor' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the token when the clock says the answer was late, whatever the timer did', async () => {
    let t = 0
    const now = () => t
    const post = async (step: string, body: Record<string, unknown>) => {
      const answer = await fakeServer(rightMac)(step, body)
      t += 2_001
      return answer
    }
    expect(await pairProof.confirmCode({ salt: SALT_E, post, requestId: RID, code: 'K7QM', now, wait: () => new Promise(() => {}) })).toEqual({ state: 'impostor' })
    // Just within the bound, the same answer is taken.
    const inTime = async (step: string, body: Record<string, unknown>) => {
      const answer = await fakeServer(rightMac)(step, body)
      t += 1_999
      return answer
    }
    expect((await pairProof.confirmCode({ salt: SALT_E, post: inTime, requestId: RID, code: 'K7QM', now, wait: () => new Promise(() => {}) })).state).toBe('paired')
  })

  it('passes on what a server says that carries no token, and fails on nonsense', async () => {
    for (const state of ['wrong', 'exhausted', 'refused', 'expired']) {
      expect(await pairProof.confirmCode({ salt: SALT_E, post: async () => ({ state }), requestId: RID, code: 'K7QM' })).toEqual({ state })
    }
    for (const answer of [null, {}, { state: 'confirm' }, 'paired']) {
      expect(await pairProof.confirmCode({ salt: SALT_E, post: async () => answer, requestId: RID, code: 'K7QM' })).toEqual({ state: 'failed' })
    }
  })
})

describe('navigationClearsRect (the shared tab loading another page)', () => {
  const share = { tabId: 7, rect: { x: 0, y: 0, w: 1, h: 1 } }

  it('clears the rectangle when the shared tab starts loading', () => {
    expect(navigationClearsRect(share, 7, { status: 'loading' })).toBe(true)
    expect(navigationClearsRect(share, 7, { status: 'loading', url: 'https://example.com/next' })).toBe(true)
  })

  it('leaves it for another tab, another change, or no share', () => {
    expect(navigationClearsRect(share, 8, { status: 'loading' })).toBe(false)
    expect(navigationClearsRect(share, 7, { status: 'complete' })).toBe(false)
    expect(navigationClearsRect(share, 7, { title: 'New title' })).toBe(false)
    expect(navigationClearsRect(share, 7, undefined)).toBe(false)
    expect(navigationClearsRect(null, 7, { status: 'loading' })).toBe(false)
  })
})

describe('withVolumeHint (the volume set through YouTube)', () => {
  const state = (volume: number) => ({ paused: false, currentTime: 1, duration: 60, volume, muted: false })

  it('shows the volume set while the element keeps what it read right after', () => {
    const share = { volumeHint: { element: 0.42, value: 0.8 } }
    expect(withVolumeHint(share, state(0.42))).toEqual(state(0.8))
    expect(withVolumeHint(share, state(0.4205))).toEqual(state(0.8))
    expect(share.volumeHint).toEqual({ element: 0.42, value: 0.8 })
  })

  it('drops its hint once the element has another volume, and shows the element\'s from then on', () => {
    const share: { volumeHint: { element: number; value: number } | null } = { volumeHint: { element: 0.42, value: 0.8 } }
    expect(withVolumeHint(share, state(0.3))).toEqual(state(0.3))
    expect(share.volumeHint).toBeNull()
    // Back to the old reading: the hint is gone for good.
    expect(withVolumeHint(share, state(0.42))).toEqual(state(0.42))
  })

  it('leaves a state alone without a hint, and a missing state as it is', () => {
    expect(withVolumeHint({ volumeHint: null }, state(0.5))).toEqual(state(0.5))
    expect(withVolumeHint({}, state(0.5))).toEqual(state(0.5))
    const share = { volumeHint: { element: 0.42, value: 0.8 } }
    expect(withVolumeHint(share, null)).toBeNull()
    expect(share.volumeHint).toEqual({ element: 0.42, value: 0.8 })
  })
})

describe('the popup\'s Fremplay messages (lib/errors.js)', () => {
  const messages = (locale: string): Record<string, { message: string }> =>
    JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'companion', '_locales', locale, 'messages.json'), 'utf8'))

  it('says Fremplay is off in Fremkit, in both languages', () => {
    expect(shareErrorKey('disabled')).toBe('errDisabled')
    expect(messages('fr').errDisabled.message).toBe('Fremplay est désactivé dans Fremkit (fonctions expérimentales).')
    expect(messages('en').errDisabled.message).toBe('Fremplay is turned off in Fremkit (experimental features).')
  })

  it('maps every error to a message both locales have, and an unknown one to a plain failure', () => {
    for (const locale of ['fr', 'en']) {
      const m = messages(locale)
      for (const key of Object.values(SHARE_ERRORS) as string[]) expect(m[key]?.message, `${locale} ${key}`).toBeTruthy()
    }
    expect(shareErrorKey('something new')).toBe('errFailed')
    expect(shareErrorKey('toString')).toBe('errFailed')
  })

  it('clears a "turned off" last error when Fremkit says Fremplay is back on, and nothing else', () => {
    expect(fremplaySwitch({ fremplayOff: true, lastError: 'disabled' }, false)).toEqual({ fremplayOff: false, lastError: null })
    // The shortcut was refused while off, and the flag never got set: the error still goes.
    expect(fremplaySwitch({ fremplayOff: false, lastError: 'disabled' }, false)).toEqual({ lastError: null })
    // Another error is the popup's to show.
    expect(fremplaySwitch({ fremplayOff: true, lastError: 'noVideoLeft' }, false)).toEqual({ fremplayOff: false })
    expect(fremplaySwitch({ fremplayOff: false, lastError: null }, true)).toEqual({ fremplayOff: true })
    expect(fremplaySwitch({ fremplayOff: true, lastError: 'disabled' }, true)).toBeNull()
    expect(fremplaySwitch({}, false)).toBeNull()
  })

  it('greys Send while Fremkit says Fremplay is off, and only then', () => {
    expect(fremplayBlocked({ fremplayOff: true })).toEqual({ error: 'disabled', key: 'errDisabled' })
    expect(fremplayBlocked({ fremplayOff: false })).toBeNull()
    expect(fremplayBlocked({})).toBeNull()
    expect(fremplayBlocked(undefined)).toBeNull()
  })
})
