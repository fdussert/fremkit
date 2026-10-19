import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * The WebRTC guard at the top of the bridge, run against stand-ins for `window`, `document` and a
 * native `RTCPeerConnection` that records what it was handed. The browser half — that no packet
 * leaves — is `scripts/check-widget-sandbox.mjs`.
 */

const src = await readFile(fileURLToPath(new URL('../src/bridge/fremkit.js', import.meta.url)), 'utf8')

interface Calls { constructed: unknown[]; configured: unknown[]; remote: unknown[]; local: unknown[]; candidates: unknown[] }

function nativeRtc(calls: Calls) {
  class RTCPeerConnection {
    constructor(config: unknown) { calls.constructed.push(config) }
    static generateCertificate(keygen: unknown) { return Promise.resolve({ keygen }) }
    setConfiguration(config: unknown) { calls.configured.push(config) }
    setRemoteDescription(desc: unknown) { calls.remote.push(desc); return Promise.resolve() }
    setLocalDescription(...args: unknown[]) { calls.local.push(args); return Promise.resolve() }
    addIceCandidate(...args: unknown[]) { calls.candidates.push(args); return Promise.resolve() }
    createDataChannel() { return {} }
  }
  return RTCPeerConnection
}

function load(attrs: Record<string, string> = {}) {
  const calls: Calls = { constructed: [], configured: [], remote: [], local: [], candidates: [] }
  const Native = nativeRtc(calls)
  const window: Record<string, unknown> = {
    RTCPeerConnection: Native,
    webkitRTCPeerConnection: Native,
    RTCDataChannel: function RTCDataChannel() {},
    RTCSessionDescription: function RTCSessionDescription() {},
    RTCIceCandidate: function RTCIceCandidate() {},
    parent: { postMessage: () => {} },
    addEventListener: () => {},
  }
  const element = () => ({ setAttribute: () => {}, textContent: '' })
  const document = {
    currentScript: { getAttribute: (name: string) => attrs[name] ?? null },
    documentElement: { classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {}, removeProperty: () => {} } },
    head: { firstChild: null, insertBefore: () => {}, appendChild: () => {} },
    createElement: element,
    querySelector: () => null,
    addEventListener: () => {},
    dispatchEvent: () => {},
  }
  new Function('window', 'document', 'console', src)(window, document, console)
  return { window, calls, Native }
}

const NAMES = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']

describe('a widget with no WebRTC (every widget but a listed built-in)', () => {
  it('finds every constructor undefined, and cannot put one back', () => {
    const { window, Native } = load()
    for (const name of NAMES) {
      expect(window[name], name).toBeUndefined()
      const d = Object.getOwnPropertyDescriptor(window, name)!
      expect(d.writable).toBe(false)
      expect(d.configurable).toBe(false)
      expect(() => { 'use strict'; window[name] = Native }).toThrow()
      expect(() => Object.defineProperty(window, name, { value: Native })).toThrow()
    }
  })

  it('ignores data-webrtc on any other value than "local"', () => {
    const { window } = load({ 'data-webrtc': 'yes' })
    expect(window.RTCPeerConnection).toBeUndefined()
  })
})

describe('a built-in at the local level', () => {
  const SDP = [
    'v=0',
    'a=ice-ufrag:abcd',
    'a=candidate:1 1 udp 2122260223 127.0.0.1 50000 typ host generation 0',
    'a=candidate:2 1 udp 2122260223 192.0.2.10 50001 typ host generation 0',
    'a=candidate:3 1 udp 1686052607 203.0.113.9 50002 typ srflx raddr 192.0.2.10 rport 50001',
    'a=candidate:4 1 udp 2122260223 203.0.113.9 50003 typ host',
    'a=candidate:5 1 udp 2122260223 abcd-1234.local 50004 typ host',
    'A=CANDIDATE:6 1 udp 2122260223 203.0.113.9 50005 typ host',
    'a=candidate:7 1 udp 2122260223  203.0.113.9 50006 typ host',
    'a=remote-candidates:1 203.0.113.9 50007',
    'a=candidate:8 1 udp 2122260223 ::1 50008 typ host',
    '',
  ].join('\r\n')
  const hosts = { 'data-webrtc': 'local', 'data-webrtc-hosts': '192.0.2.10 2001:db8::10' }

  it('never has an ICE server, from the constructor or from setConfiguration', () => {
    const { window, calls } = load(hosts)
    const RTC = window.RTCPeerConnection as new (c: unknown) => { setConfiguration(c: unknown): void }
    const pc = new RTC({ iceServers: [{ urls: 'stun:stun.example.com', username: 'secret' }], bundlePolicy: 'max-bundle' })
    pc.setConfiguration({ iceServers: [{ urls: 'turn:turn.example.com' }] })
    expect(calls.constructed).toEqual([{ iceServers: [], bundlePolicy: 'max-bundle' }])
    expect(calls.configured).toEqual([{ iceServers: [] }])
  })

  it('keeps only host candidates on loopback or on this Mac, in either description', async () => {
    const { window, calls } = load(hosts)
    const RTC = window.RTCPeerConnection as new () => {
      setRemoteDescription(d: unknown): Promise<void>
      setLocalDescription(d?: unknown): Promise<void>
    }
    const pc = new RTC()
    await pc.setRemoteDescription({ type: 'answer', sdp: SDP })
    await pc.setLocalDescription({ type: 'offer', sdp: SDP })
    await pc.setLocalDescription()
    const kept = (calls.remote[0] as { sdp: string }).sdp.split('\r\n').filter((l) => /candidate/i.test(l))
    expect(kept).toEqual([
      'a=candidate:1 1 udp 2122260223 127.0.0.1 50000 typ host generation 0',
      'a=candidate:2 1 udp 2122260223 192.0.2.10 50001 typ host generation 0',
      'a=candidate:8 1 udp 2122260223 ::1 50008 typ host',
    ])
    expect((calls.remote[0] as { type: string }).type).toBe('answer')
    // This side's own mDNS name is kept in its own description, and only there.
    const own = (calls.local[0] as [{ sdp: string }])[0].sdp.split('\r\n').filter((l) => /candidate/i.test(l))
    expect(own).toEqual([kept[0], kept[1], 'a=candidate:5 1 udp 2122260223 abcd-1234.local 50004 typ host', kept[2]])
    expect(calls.local[1]).toEqual([])
  })

  it('drops a trickled candidate it may not keep, and reads the rest once', async () => {
    const { window, calls } = load(hosts)
    const RTC = window.RTCPeerConnection as new () => { addIceCandidate(c?: unknown): Promise<void> }
    const pc = new RTC()
    await pc.addIceCandidate({ candidate: 'candidate:1 1 udp 1 203.0.113.9 9 typ host', sdpMid: '0' })
    await pc.addIceCandidate({ candidate: 'candidate:1 1 udp 1 198.51.100.4 9 typ relay raddr 1 rport 2', sdpMid: '0' })
    let reads = 0
    // A getter that answers the check with an allowed address and the browser with another.
    await pc.addIceCandidate({
      get candidate() { reads++; return reads === 1 ? 'candidate:1 1 udp 1 127.0.0.1 9 typ host' : 'candidate:1 1 udp 1 203.0.113.9 9 typ host' },
      sdpMLineIndex: 0,
    })
    await pc.addIceCandidate({ candidate: 'candidate:1 1 udp 1 0f2c-7a.local 9 typ host', sdpMid: '0' })
    await pc.addIceCandidate({ candidate: 'a=candidate:1 1 udp 1 2001:db8::10 9 typ host', sdpMid: '0' })
    await pc.addIceCandidate({ candidate: '', sdpMid: '0' })
    await pc.addIceCandidate()
    expect(calls.candidates).toEqual([
      [{ candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdpMLineIndex: 0 }],
      [{ candidate: 'a=candidate:1 1 udp 1 2001:db8::10 9 typ host', sdpMid: '0' }],
      [{ candidate: '', sdpMid: '0' }],
      [],
    ])
  })

  it('leaves no way back to the native constructor or methods', () => {
    const { window, Native } = load(hosts)
    const RTC = window.RTCPeerConnection as unknown as typeof Native
    const pc = new RTC({})
    expect(RTC).not.toBe(Native)
    expect(window.webkitRTCPeerConnection).toBe(RTC)
    expect(pc.constructor).toBe(RTC)
    expect(Object.getPrototypeOf(pc).constructor).toBe(RTC)
    for (const name of ['constructor', 'setConfiguration', 'setRemoteDescription', 'setLocalDescription', 'addIceCandidate']) {
      const d = Object.getOwnPropertyDescriptor(Native.prototype, name)!
      expect(d.writable, name).toBe(false)
      expect(d.configurable, name).toBe(false)
    }
    expect(Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection')!.configurable).toBe(false)
  })

  it('is not fooled by a widget that rewrites String.prototype afterwards', async () => {
    const { window, calls } = load(hosts)
    const split = String.prototype.split
    const lower = String.prototype.toLowerCase
    try {
      String.prototype.split = function () { return ['candidate:1', '1', 'udp', '1', '127.0.0.1', '9', 'typ', 'host'] } as never
      String.prototype.toLowerCase = function (this: string) { return '127.0.0.1' } as never
      const RTC = window.RTCPeerConnection as new () => { addIceCandidate(c?: unknown): Promise<void> }
      await new RTC().addIceCandidate({ candidate: 'candidate:1 1 udp 1 203.0.113.9 9 typ host' })
    } finally {
      String.prototype.split = split
      String.prototype.toLowerCase = lower
    }
    expect(calls.candidates).toEqual([])
  })

  it('cannot be granted by a second copy of the bridge once the first has run', () => {
    const { window } = load()
    // The same window, the bridge again, this time with the attribute a widget could write.
    const document = {
      currentScript: { getAttribute: (n: string) => (n === 'data-webrtc' ? 'local' : '') },
      documentElement: { classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {}, removeProperty: () => {} } },
      head: { firstChild: null, insertBefore: () => {}, appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {} }),
      querySelector: () => ({}),
      addEventListener: () => {},
      dispatchEvent: () => {},
    }
    new Function('window', 'document', 'console', src)(window, document, console)
    expect(window.RTCPeerConnection).toBeUndefined()
  })
})
