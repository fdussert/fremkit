import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import { DEFAULT_OPENSSL, spkiHash } from '../src/devices/certificate.js'
import { derInteger, derLength, derTime, ipBytes, selfSignedCertificate } from '../src/devices/x509.js'

const hasOpenssl = spawnSync(DEFAULT_OPENSSL, ['version']).status === 0

function newKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
}

const NAMES = { dns: ['example.local', 'example.com'], ips: ['192.0.2.10', '198.51.100.7', '2001:db8::1'] }

describe('the DER writer', () => {
  it('writes lengths in short form up to 127 and long form above', () => {
    expect(derLength(0)).toEqual(Buffer.from([0x00]))
    expect(derLength(127)).toEqual(Buffer.from([0x7f]))
    expect(derLength(128)).toEqual(Buffer.from([0x81, 0x80]))
    expect(derLength(255)).toEqual(Buffer.from([0x81, 0xff]))
    expect(derLength(256)).toEqual(Buffer.from([0x82, 0x01, 0x00]))
    expect(derLength(70_000)).toEqual(Buffer.from([0x83, 0x01, 0x11, 0x70]))
  })

  it('keeps an INTEGER positive and minimal', () => {
    expect(derInteger(Buffer.from([0x7f]))).toEqual(Buffer.from([0x02, 0x01, 0x7f]))
    expect(derInteger(Buffer.from([0x80]))).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]))
    expect(derInteger(Buffer.from([0x00, 0x00, 0x01]))).toEqual(Buffer.from([0x02, 0x01, 0x01]))
    expect(derInteger(Buffer.from([0x00, 0xff]))).toEqual(Buffer.from([0x02, 0x02, 0x00, 0xff]))
  })

  it('writes UTCTime through 2049 and GeneralizedTime from 2050', () => {
    expect(derTime(new Date('2049-12-31T23:59:59Z')).toString('latin1')).toBe('\x17\x0d491231235959Z')
    expect(derTime(new Date('2050-01-01T00:00:00Z')).toString('latin1')).toBe('\x18\x0f20500101000000Z')
    expect(derTime(new Date('1999-02-03T04:05:06.789Z')).toString('latin1')).toBe('\x17\x0d990203040506Z')
  })

  it('writes IP addresses as 4 or 16 bytes and refuses a zone', () => {
    expect(ipBytes('192.0.2.10')).toEqual(Buffer.from([192, 0, 2, 10]))
    expect(ipBytes('2001:db8::1').toString('hex')).toBe('20010db8000000000000000000000001')
    expect(ipBytes('::1').toString('hex')).toBe('00000000000000000000000000000001')
    expect(ipBytes('fe80::').toString('hex')).toBe('fe800000000000000000000000000000')
    expect(ipBytes('::ffff:192.0.2.1').toString('hex')).toBe('00000000000000000000ffffc0000201')
    expect(ipBytes('1:2:3:4:5:6:7:8').toString('hex')).toBe('00010002000300040005000600070008')
    expect(() => ipBytes('fe80::1%en0')).toThrow()
    expect(() => ipBytes('example.com')).toThrow()
  })
})

describe('selfSignedCertificate', () => {
  it('parses, matches its key, and verifies under it', () => {
    const { privateKey, publicKey } = newKey()
    const cert = new X509Certificate(selfSignedCertificate(privateKey, NAMES, 3650))
    expect(cert.checkPrivateKey(privateKey)).toBe(true)
    expect(cert.verify(publicKey)).toBe(true)
    expect(cert.subject).toBe('CN=fremkit')
    expect(cert.issuer).toBe(cert.subject)
    expect(cert.ca).toBe(false)
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1'])
  })

  it('lists every DNS name and IP address given', () => {
    const cert = new X509Certificate(selfSignedCertificate(newKey().privateKey, NAMES, 3650))
    const san = cert.subjectAltName ?? ''
    for (const dns of NAMES.dns) expect(san).toContain(`DNS:${dns}`)
    expect(san).toContain('IP Address:192.0.2.10')
    expect(san).toContain('IP Address:198.51.100.7')
    expect(san).toContain('IP Address:2001:DB8:0:0:0:0:0:1')
  })

  it('leaves the SAN out when there are no names, and refuses a name it cannot write', () => {
    const { privateKey } = newKey()
    expect(new X509Certificate(selfSignedCertificate(privateKey, { dns: [], ips: [] }, 3650)).subjectAltName).toBeUndefined()
    expect(() => selfSignedCertificate(privateKey, { dns: ['a b'], ips: [] }, 3650)).toThrow()
    expect(() => selfSignedCertificate(privateKey, { dns: [], ips: ['192.0.2.1,DNS:x'] }, 3650)).toThrow()
  })

  it('is valid ten years from now, to the second', () => {
    const now = new Date('2026-10-23T12:34:56.789Z')
    const cert = new X509Certificate(selfSignedCertificate(newKey().privateKey, NAMES, 3650, now))
    expect(new Date(cert.validFrom).toISOString()).toBe('2026-10-23T12:34:56.000Z')
    expect((Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000).toBe(3650)
  })

  it('crosses into GeneralizedTime after 2049', () => {
    const cert = new X509Certificate(selfSignedCertificate(newKey().privateKey, NAMES, 3650, new Date('2045-06-01T00:00:00Z')))
    expect(new Date(cert.validTo).toISOString()).toBe('2055-05-30T00:00:00.000Z')
  })

  it('has the same SPKI hash as its key', () => {
    const { privateKey } = newKey()
    const pem = selfSignedCertificate(privateKey, NAMES, 3650)
    expect(spkiHash(pem)).toBe(spkiHash(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()))
  })

  it('draws a fresh positive serial each time', () => {
    const { privateKey } = newKey()
    const a = new X509Certificate(selfSignedCertificate(privateKey, NAMES, 3650))
    const b = new X509Certificate(selfSignedCertificate(privateKey, NAMES, 3650))
    expect(a.serialNumber).not.toBe(b.serialNumber)
    expect(a.serialNumber).toMatch(/^[0-9A-F]{1,34}$/)
  })

  it.skipIf(!hasOpenssl)('reads the same through openssl', () => {
    const pem = selfSignedCertificate(newKey().privateKey, NAMES, 3650)
    const out = spawnSync(DEFAULT_OPENSSL, ['x509', '-noout', '-text'], { input: pem, encoding: 'utf8' })
    expect(out.status).toBe(0)
    const text = out.stdout
    expect(text).toMatch(/Version: 3 \(0x2\)/)
    expect(text).toMatch(/Signature Algorithm: ecdsa-with-SHA256/)
    expect(text).toMatch(/Issuer: CN\s?=\s?fremkit/)
    expect(text).toMatch(/Subject: CN\s?=\s?fremkit/)
    expect(text).toMatch(/prime256v1|P-256/)
    expect(text).toMatch(/DNS:example\.local, DNS:example\.com, IP Address:192\.0\.2\.10, IP Address:198\.51\.100\.7, IP Address:2001:DB8:0:0:0:0:0:1/)
    expect(text).toMatch(/Basic Constraints:\s*\n\s*CA:FALSE/)
    expect(text).toMatch(/Key Usage:\s*\n\s*Digital Signature/)
    expect(text).toMatch(/Extended Key Usage:\s*\n\s*TLS Web Server Authentication/)
    // A strict parse of the whole structure: asn1parse fails on a malformed length or tag.
    const asn1 = spawnSync(DEFAULT_OPENSSL, ['asn1parse', '-inform', 'PEM'], { input: pem, encoding: 'utf8' })
    expect(asn1.status).toBe(0)
  })
})
