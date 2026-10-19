import { describe, expect, it } from 'vitest'
import { isLanPeer } from '../src/net/lan.js'

describe('isLanPeer', () => {
  it('accepts the private, link-local and loopback ranges', () => {
    for (const a of [
      '10.1.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.20', '169.254.10.1',
      '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'fd12:3456:789a::1', 'fc00::1', 'fe80::1', 'fe80::1%en0',
      'FE80::AbCd%bridge100', 'febf::1', 'fd7a:115c:a1e1::1', 'fd7b:115c:a1e0::1', '::ffff:192.168.1.20', '::ffff:c0a8:114', '::ffff:10.1.2.3',
      '::ffff:127.0.0.1',
    ]) expect(isLanPeer(a), a).toBe(true)
  })

  it('refuses public, documentation, carrier and other reserved addresses', () => {
    for (const a of [
      '192.0.2.1', '198.51.100.7', '203.0.113.9', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1',
      '100.64.0.1', '100.100.100.100', '0.0.0.0', '224.0.0.1', '255.255.255.255', '11.0.0.1',
      '2001:db8::1', '2a00:1450::1', 'fec0::1', 'ff02::1', '::', '::2',
      '::ffff:192.0.2.1', '::ffff:8.8.8.8', '::ffff:100.64.0.1',
      // Tailscale: its CGNAT IPv4 range and its ULA prefix, fd7a:115c:a1e0::/48.
      '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240',
      'FD7A:115C:A1E0::5%utun3',
      // An IPv4 embedded any other way still came from the internet.
      '2002:c0a8:0101::1', '64:ff9b::c0a8:101', '::192.168.1.1', '::ffff:0:c0a8:101',
    ]) expect(isLanPeer(a), a).toBe(false)
  })

  it('refuses what it cannot read', () => {
    for (const a of [undefined, null, '', ' ', 'localhost', '192.168.1', '192.168.1.256', '1:2:3', 'fe80::1::2', 'x.y.z.w']) {
      expect(isLanPeer(a as string | undefined), String(a)).toBe(false)
    }
  })
})
