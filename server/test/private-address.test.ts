import { describe, it, expect } from 'vitest'
import { embeddedIpv4, expandIpv6, isAddressLiteral, isPrivateAddress, isPrivateLiteral, resolvesToPrivate } from '../src/net/private.js'

describe('isPrivateAddress', () => {
  it('knows the IPv4 ranges a widget must not reach', () => {
    for (const ip of ['0.0.0.0', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.1.2.3',
      '100.64.0.1', '100.127.255.255', '169.254.169.254', '172.16.0.1', '172.31.255.255',
      '192.168.0.1', '192.0.0.1', '198.18.0.1', '198.19.1.1', '224.0.0.1', '255.255.255.255']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })
  it('lets the public IPv4 space through, including the ranges next to a private one', () => {
    for (const ip of ['198.51.100.7', '203.0.113.9', '8.8.8.8', '9.255.255.255', '11.0.0.1',
      '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.167.255.255',
      '192.169.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.255']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })
  it('knows the IPv6 ranges, brackets and IPv4-mapped forms included', () => {
    for (const ip of ['::', '::1', '[::1]', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'FE80::1',
      'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['2001:db8::1', '2606:4700::1111', '::ffff:198.51.100.7']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('reads an IPv4 an IPv6 address carries however it is spelled', () => {
    // `new URL()` canonicalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and a check that only
    // knew the dotted form let every one of these reach the loopback stack. A widget declaring
    // `permissions.network: ["[::ffff:7f00:1]"]` proxied any local service.
    for (const ip of ['::ffff:7f00:1', '[::ffff:7f00:1]', '0:0:0:0:0:ffff:7f00:1',
      '::7f00:1', '::127.0.0.1', '::ffff:a9fe:a9fe', '::ffff:c0a8:1', '::ffff:0a00:1',
      '0000:0000:0000:0000:0000:ffff:7f00:0001']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    // A carried public IPv4 stays public, in hex as in dots.
    for (const ip of ['::ffff:c633:6407', '::ffff:198.51.100.7', '::ffff:0808:0808']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('refuses an IPv6 literal it cannot read rather than guessing', () => {
    for (const ip of ['1:2:3:4:5:6:7:8:9', '::ffff:999.1.1.1', 'gggg::1', '1::2::3', ':::1', '::ffff:1.2.3']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })
  it('refuses anything it cannot read as an address', () => {
    for (const ip of ['', '1.2.3', '1.2.3.4.5', '999.1.1.1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })
})

describe('isAddressLiteral and isPrivateLiteral', () => {
  it('tells an address from a name', () => {
    expect(isAddressLiteral('127.0.0.1')).toBe(true)
    expect(isAddressLiteral('[::1]')).toBe(true)
    expect(isAddressLiteral('fe80::1')).toBe(true)
    expect(isAddressLiteral('api.open-meteo.com')).toBe(false)
    expect(isAddressLiteral('localhost')).toBe(false)
  })
  it('never calls a name private without resolving it', () => {
    // "localhost" resolves to loopback, but that is resolvesToPrivate's business, not this one's.
    expect(isPrivateLiteral('localhost')).toBe(false)
    expect(isPrivateLiteral('api.open-meteo.com')).toBe(false)
    expect(isPrivateLiteral('127.0.0.1')).toBe(true)
    expect(isPrivateLiteral('198.51.100.7')).toBe(false)
  })
})

describe('resolvesToPrivate', () => {
  const resolving = (...addresses: string[]) =>
    async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

  it('judges a literal without a lookup', async () => {
    let asked = false
    const resolve = async () => { asked = true; return [] }
    expect(await resolvesToPrivate('127.0.0.1', resolve)).toBe(true)
    expect(await resolvesToPrivate('198.51.100.7', resolve)).toBe(false)
    expect(asked).toBe(false)
  })
  it('follows a name to the address it resolves to', async () => {
    expect(await resolvesToPrivate('evil.example', resolving('127.0.0.1'))).toBe(true)
    expect(await resolvesToPrivate('evil.example', resolving('169.254.169.254'))).toBe(true)
    expect(await resolvesToPrivate('api.example.com', resolving('198.51.100.7'))).toBe(false)
  })
  it('refuses a name with one private answer among several', async () => {
    expect(await resolvesToPrivate('mixed.example', resolving('198.51.100.7', '10.0.0.1'))).toBe(true)
  })
  it('treats a name it cannot resolve as private', async () => {
    expect(await resolvesToPrivate('ghost.invalid', resolving())).toBe(true)
    expect(await resolvesToPrivate('ghost.invalid', async () => { throw new Error('ENOTFOUND') })).toBe(true)
  })
})

describe('expandIpv6', () => {
  it('expands :: and a trailing dotted quad to eight groups', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(expandIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(expandIpv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
    expect(expandIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    expect(expandIpv6('[::ffff:7f00:1]')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    expect(expandIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(expandIpv6('0:0:0:0:0:ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304])
  })
  it('answers null for anything that is not eight readable groups', () => {
    for (const ip of ['1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', 'gggg::1', '1::2::3',
      '::ffff:1.2.3', '::ffff:256.0.0.1', '127.0.0.1', '']) {
      expect(expandIpv6(ip), ip).toBeNull()
    }
  })
})

describe('embeddedIpv4', () => {
  it('reads the mapped and the deprecated compatible forms', () => {
    expect(embeddedIpv4([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])).toBe('127.0.0.1')
    expect(embeddedIpv4([0, 0, 0, 0, 0, 0, 0x7f00, 1])).toBe('127.0.0.1')
    expect(embeddedIpv4([0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe])).toBe('169.254.169.254')
  })
  it('reads the IPv4-translated form, whose marker sits one group earlier', () => {
    // ::ffff:0:127.0.0.1 — RFC 2765. `new URL()` writes it back as [::ffff:0:7f00:1].
    expect(embeddedIpv4([0, 0, 0, 0, 0xffff, 0, 0x7f00, 1])).toBe('127.0.0.1')
    expect(embeddedIpv4([0, 0, 0, 0, 0xffff, 0, 0xa9fe, 0xa9fe])).toBe('169.254.169.254')
  })
  it('reads the NAT64 well-known prefix', () => {
    // 64:ff9b::127.0.0.1 — a translator hands this straight to the IPv4 stack.
    expect(embeddedIpv4([0x0064, 0xff9b, 0, 0, 0, 0, 0x7f00, 1])).toBe('127.0.0.1')
    expect(embeddedIpv4([0x0064, 0xff9b, 0, 0, 0, 0, 0xc0a8, 0x0101])).toBe('192.168.1.1')
    // Not the prefix: the groups between it and the address are not zero.
    expect(embeddedIpv4([0x0064, 0xff9b, 0, 0, 0, 1, 0x7f00, 1])).toBeNull()
  })
  it('reads a 6to4 address, whose second and third groups are the tunnel endpoint', () => {
    expect(embeddedIpv4([0x2002, 0x7f00, 0x0001, 0, 0, 0, 0, 1])).toBe('127.0.0.1')
    expect(embeddedIpv4([0x2002, 0xc0a8, 0x0101, 0, 0, 0, 0, 0])).toBe('192.168.1.1')
  })
  it('carries none for a real IPv6 address, or for :: and ::1', () => {
    expect(embeddedIpv4([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])).toBeNull()
    expect(embeddedIpv4([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull()
    expect(embeddedIpv4([0, 0, 0, 0, 0, 0, 0, 1])).toBeNull()
    expect(embeddedIpv4([0, 0, 0, 0, 1, 0xffff, 0x7f00, 1])).toBeNull()
  })
})

describe('the forms that carry an IPv4 are judged as that IPv4', () => {
  it('refuses every spelling of loopback and of the metadata endpoint', () => {
    for (const address of [
      '::ffff:127.0.0.1', '[::ffff:7f00:1]',
      '::ffff:0:127.0.0.1', '[::ffff:0:7f00:1]',
      '64:ff9b::127.0.0.1', '[64:ff9b::7f00:1]',
      '2002:7f00:1::', '[2002:7f00:1::1]',
      '::ffff:169.254.169.254', '64:ff9b::169.254.169.254', '2002:a9fe:a9fe::',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
  })
  it('still lets a public address through, however it is carried', () => {
    expect(isPrivateAddress('::ffff:93.184.216.34')).toBe(false)
    expect(isPrivateAddress('64:ff9b::93.184.216.34')).toBe(false)
    expect(isPrivateAddress('2002:5db8:d822::')).toBe(false)
  })
})

describe('an IPv4 that is not one at all', () => {
  it('refuses a dotted quad whose last octets are out of range', () => {
    // Only the first two were checked, and the ranges below read only those two: `1.2.3.999`
    // came back "public" although it is not an address.
    for (const bad of ['1.2.3.999', '8.8.8.256', '8.8.999.8', '1.2.3.4.5', '1.2.3', '1.2.3.']) {
      expect(isPrivateAddress(bad), bad).toBe(true)
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
  })
})
