import { afterEach, describe, it, expect } from 'vitest'
import { allowedOrigins, isOriginAllowed } from '../src/ws/routes.js'

const env = { ...process.env }
afterEach(() => { process.env = { ...env } })

describe('isOriginAllowed', () => {
  it('allows requests without an Origin header', () => {
    expect(isOriginAllowed(undefined)).toBe(true)
  })
  it('allows every listed origin', () => {
    for (const origin of allowedOrigins()) expect(isOriginAllowed(origin)).toBe(true)
  })
  it('rejects a foreign origin', () => {
    expect(isOriginAllowed('http://evil.example')).toBe(false)
  })
  it('rejects an empty origin string', () => {
    expect(isOriginAllowed('')).toBe(false)
  })
})

describe('allowedOrigins', () => {
  it('trusts the production port on both loopback names, and nothing else', () => {
    delete process.env.FREMKIT_DEV
    delete process.env.FREMKIT_PORT
    expect(allowedOrigins()).toEqual(['http://127.0.0.1:4242', 'http://localhost:4242'])
  })

  it('does not trust the Vite dev server unless FREMKIT_DEV is set', () => {
    delete process.env.FREMKIT_DEV
    // 5173 is Vite's default port everywhere: an unrelated project on it is not this dashboard.
    expect(isOriginAllowed('http://localhost:5173')).toBe(false)
    process.env.FREMKIT_DEV = '1'
    expect(isOriginAllowed('http://localhost:5173')).toBe(true)
    expect(isOriginAllowed('http://127.0.0.1:5173')).toBe(true)
  })

  it('ignores a FREMKIT_DEV that is not exactly 1', () => {
    for (const value of ['0', 'true', '', 'yes']) {
      process.env.FREMKIT_DEV = value
      expect(isOriginAllowed('http://localhost:5173'), value).toBe(false)
    }
  })

  it('adds the port a second checkout was moved to, without repeating it', () => {
    delete process.env.FREMKIT_DEV
    process.env.FREMKIT_PORT = '4301'
    expect(allowedOrigins()).toContain('http://127.0.0.1:4301')
    expect(allowedOrigins()).toHaveLength(4)
    process.env.FREMKIT_PORT = '4242'
    expect(allowedOrigins()).toHaveLength(2)
  })

  it('ignores a FREMKIT_PORT that is not a port', () => {
    delete process.env.FREMKIT_DEV
    for (const value of ['nope', '0', '-1', '99999', '']) {
      process.env.FREMKIT_PORT = value
      expect(allowedOrigins(), value).toEqual(['http://127.0.0.1:4242', 'http://localhost:4242'])
    }
  })
})
