import { describe, it, expect } from 'vitest'
import { hostAddresses, webrtcLevel, WEBRTC_LOCAL_BUILTINS } from '../src/widgets/webrtc.js'

describe('webrtcLevel', () => {
  it('ships with Fremplay alone allowed a local peer connection', () => {
    expect([...WEBRTC_LOCAL_BUILTINS]).toEqual(['fremplay'])
  })
  it('is local only for a built-in on the list', () => {
    const list = new Set(['fremplay'])
    expect(webrtcLevel('fremplay', 'builtin', list)).toBe('local')
    expect(webrtcLevel('fremplay', 'installed', list)).toBe('none')
    expect(webrtcLevel('fremplay', undefined, list)).toBe('none')
    expect(webrtcLevel('clock', 'builtin', list)).toBe('none')
    expect(webrtcLevel('fremplay', 'builtin')).toBe('local')
    expect(webrtcLevel('fremplay', 'installed')).toBe('none')
    expect(webrtcLevel('clock', 'builtin')).toBe('none')
  })
})

describe('hostAddresses', () => {
  it('lists IP literals, lower-cased and once each', () => {
    const entry = (address: string, family: 'IPv4' | 'IPv6') =>
      ({ address, family, netmask: '', mac: '00:00:00:00:00:00', internal: false, cidr: null, scopeid: 0 })
    expect(hostAddresses({
      lo0: [entry('127.0.0.1', 'IPv4'), entry('::1', 'IPv6')],
      en0: [entry('192.0.2.10', 'IPv4'), entry('2001:DB8::10', 'IPv6'), entry('192.0.2.10', 'IPv4')],
      bogus: [entry('"><script>', 'IPv4')],
    } as never)).toEqual(['127.0.0.1', '::1', '192.0.2.10', '2001:db8::10'])
  })
})
