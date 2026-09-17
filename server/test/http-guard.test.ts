import { describe, it, expect } from 'vitest'
import { isAllowedHost, isReadMethod, parseHostHeader } from '../src/http/guard.js'

describe('parseHostHeader', () => {
  it('splits a name and a port', () => {
    expect(parseHostHeader('127.0.0.1:4242')).toEqual({ hostname: '127.0.0.1', port: 4242 })
    expect(parseHostHeader('localhost')).toEqual({ hostname: 'localhost', port: null })
    expect(parseHostHeader('LocalHost:4242')).toEqual({ hostname: 'localhost', port: 4242 })
  })
  it('keeps the brackets of an IPv6 literal', () => {
    expect(parseHostHeader('[::1]:4242')).toEqual({ hostname: '[::1]', port: 4242 })
    expect(parseHostHeader('[::1]')).toEqual({ hostname: '[::1]', port: null })
  })
  it('refuses a missing or malformed header', () => {
    for (const host of [undefined, '', 'a:b', '::1', 'a:1:2', 'host:999999']) {
      expect(parseHostHeader(host), String(host)).toBeNull()
    }
  })
})

describe('isAllowedHost', () => {
  it('accepts the loopback names, with or without our port', () => {
    for (const host of ['127.0.0.1:4242', 'localhost:4242', '[::1]:4242', 'localhost']) {
      expect(isAllowedHost(host, 4242), host).toBe(true)
    }
  })
  it('refuses a name that resolved to loopback — the DNS rebinding case', () => {
    for (const host of ['evil.example', 'evil.example:4242', 'fremkit.local:4242', '192.0.2.10:4242']) {
      expect(isAllowedHost(host, 4242), host).toBe(false)
    }
  })
  it('refuses a loopback name on another port once we know ours', () => {
    expect(isAllowedHost('127.0.0.1:8080', 4242)).toBe(false)
    // An instance that never listens is judged on the name alone.
    expect(isAllowedHost('127.0.0.1:8080')).toBe(true)
  })
  it('refuses a missing header', () => {
    expect(isAllowedHost(undefined, 4242)).toBe(false)
  })
})

describe('isReadMethod', () => {
  it('counts the methods that only read', () => {
    for (const m of ['GET', 'get', 'HEAD', 'OPTIONS']) expect(isReadMethod(m), m).toBe(true)
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'put']) expect(isReadMethod(m), m).toBe(false)
  })
})
