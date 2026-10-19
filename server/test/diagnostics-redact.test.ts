import { describe, expect, it } from 'vitest'
import { hostOf, MARK, redact, type RedactionContext } from '../src/diagnostics/redact.js'

const ctx: RedactionContext = {
  secrets: ['s3cr3t-Value_42', 'pa"ss\\word'],
  hosts: ['nas.example.com', '192.0.2.40'],
  names: ['Office Printer', 'Example iPad'],
  machineNames: ['Example-MacBook', 'Example MacBook'],
  home: '/Users/example',
  username: 'example',
}

describe('redact', () => {
  it('removes a known secret wherever it appears, whatever the line looks like', () => {
    for (const line of [
      'failed with s3cr3t-Value_42 in the middle',
      'Error: bad key "s3cr3t-Value_42"',
      '{"msg":"x","detail":"prefix-s3cr3t-Value_42-suffix"}',
    ]) {
      const out = redact(line, ctx)
      expect(out, line).not.toContain('s3cr3t-Value_42')
      expect(out).toContain(MARK.secret)
    }
  })

  it('removes a secret written URL-encoded or JSON-escaped', () => {
    expect(redact('url?k=pa%22ss%5Cword', ctx)).not.toContain('pa%22ss%5Cword')
    expect(redact('{"v":"pa\\"ss\\\\word"}', ctx)).not.toContain('pa\\"ss\\\\word')
  })

  it('removes bearer tokens and credential-looking key/values', () => {
    const out = redact('Authorization: Bearer abc.def-ghi and token=zzz123 and "apiKey":"k-1" password: hunter2', {})
    expect(out).not.toMatch(/abc\.def-ghi|zzz123|k-1|hunter2/)
    expect(out).toContain('Bearer [token]')
    expect(out).toContain('token=[secret]')
  })

  it('removes query values and the user-info of a URL', () => {
    const out = redact('GET https://user:pw@api.example.com/v1?key=abc&x=1 failed', {})
    expect(out).not.toMatch(/user:pw|abc|x=1/)
    expect(out).toContain('https://[secret]@api.example.com/v1?key=[secret]&x=[secret]')
  })

  it('removes JWTs and long random strings, but not plain long words', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl'
    expect(redact(`got ${jwt}`, {})).toBe(`got ${MARK.token}`)
    expect(redact('ghp_0123456789abcdefABCDEF0123456789abcd', {})).toBe(MARK.token)
    expect(redact('id 3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b', {})).toBe(`id ${MARK.token}`)
    expect(redact('internationalizationCharacteristics', {})).toBe('internationalizationCharacteristics')
  })

  it('removes e-mail addresses', () => {
    expect(redact('signed in as someone@example.com.', {})).toBe(`signed in as ${MARK.email}.`)
  })

  it('removes IPv4 and IPv6 addresses except loopback, and leaves versions and times alone', () => {
    expect(redact('peer 192.0.2.10 and 198.51.100.7:8080', {})).toBe(`peer ${MARK.ip} and ${MARK.ip}:8080`)
    expect(redact('local 127.0.0.1 and ::1', {})).toBe('local 127.0.0.1 and ::1')
    expect(redact('peer 2001:db8::42 and fe80::1%en0', {})).toBe(`peer ${MARK.ip} and ${MARK.ip}`)
    expect(redact('peer ::ffff:192.0.2.5', {})).not.toContain('192.0.2.5')
    expect(redact('Fremkit 0.4.1 at 12:30:45 with std::string', {})).toBe('Fremkit 0.4.1 at 12:30:45 with std::string')
  })

  it('removes LAN host names and configured hosts, in any case', () => {
    expect(redact('connect printer.local and nas.lan and box.home failed', {})).toBe(`connect ${MARK.host} and ${MARK.host} and ${MARK.host} failed`)
    expect(redact('ETIMEDOUT NAS.example.com', ctx)).toBe(`ETIMEDOUT ${MARK.host}`)
    expect(redact('ECONNREFUSED 192.0.2.40:5001', ctx)).toBe(`ECONNREFUSED ${MARK.host}:5001`)
  })

  it('shows the home folder as ~ and removes the account and machine names', () => {
    expect(redact('read /Users/example/Library/Logs/x.log', ctx)).toBe('read ~/Library/Logs/x.log')
    expect(redact('"hostname":"Example-MacBook"', ctx)).toBe(`"hostname":"${MARK.mac}"`)
    expect(redact('on Example MacBook today', ctx)).toBe(`on ${MARK.mac} today`)
    expect(redact('owner example here', ctx)).toBe(`owner ${MARK.user} here`)
    expect(redact('at /Users/someone/x and /Users/Shared/y', {})).toBe(`at /Users/${MARK.user}/x and /Users/Shared/y`)
  })

  it('removes the names the user gave things, as whole words', () => {
    expect(redact('Office Printer offline; Example iPad paired', ctx)).toBe(`${MARK.name} offline; ${MARK.name} paired`)
  })

  it('ignores secrets and names too short to be anything but noise', () => {
    expect(redact('a 12 b', { secrets: ['12'], names: ['b'] })).toBe('a 12 b')
  })
})

describe('hostOf', () => {
  it('finds the host of a URL or a bare host, and nothing in a plain word', () => {
    expect(hostOf('https://nas.example.com:5001/webapi')).toBe('nas.example.com')
    expect(hostOf('192.0.2.10')).toBe('192.0.2.10')
    expect(hostOf('[2001:db8::1]:80')).toBe('2001:db8::1')
    expect(hostOf('primary')).toBeNull()
    expect(hostOf('two words')).toBeNull()
    expect(hostOf('http://localhost:4242')).toBeNull()
  })
})
