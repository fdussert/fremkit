import { describe, it, expect } from 'vitest'
import { isAddressLiteral, isPrivateAddress, isPrivateLiteral, resolvesToPrivate } from '../src/net/private.js'

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
