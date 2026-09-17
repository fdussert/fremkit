import { describe, expect, it } from 'vitest'
import { serializeRequest, stripQuery } from '../src/http/logging.js'

describe('stripQuery', () => {
  it('keeps the path and drops everything after the question mark', () => {
    expect(stripQuery('/api/favicon?url=https://example.com/private?token=abc')).toBe('/api/favicon')
    expect(stripQuery('/api/proxy/weather?url=https://api.example.com/x&key=secret')).toBe('/api/proxy/weather')
  })
  it('leaves a path with no query alone', () => {
    expect(stripQuery('/api/config')).toBe('/api/config')
    expect(stripQuery('/')).toBe('/')
    expect(stripQuery('')).toBe('')
  })
  it('handles a bare question mark', () => {
    expect(stripQuery('/x?')).toBe('/x')
  })
})

describe('serializeRequest', () => {
  const req = {
    method: 'GET',
    url: '/api/favicon?url=https://example.com/reset?token=hunter2',
    headers: { host: '127.0.0.1:4242' },
    ip: '127.0.0.1',
    socket: { remotePort: 51234 },
  }

  it('records what a log line needs and nothing a query string carries', () => {
    const line = serializeRequest(req)
    expect(line).toEqual({
      method: 'GET',
      url: '/api/favicon',
      host: '127.0.0.1:4242',
      remoteAddress: '127.0.0.1',
      remotePort: 51234,
    })
    // The whole point: a log the user might send to someone else carries no token.
    expect(JSON.stringify(line)).not.toContain('hunter2')
    expect(JSON.stringify(line)).not.toContain('example.com')
  })

  it('survives a request missing the pieces it reads', () => {
    expect(serializeRequest({ method: 'POST', url: '/x' })).toEqual({
      method: 'POST', url: '/x', host: undefined, remoteAddress: undefined, remotePort: undefined,
    })
  })
})
