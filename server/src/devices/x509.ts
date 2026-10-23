import { createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto'
import { isIP } from 'node:net'

/**
 * A minimal DER writer for the pairing listener's self-signed certificate, for where there is no
 * openssl to run (Windows). It writes exactly what `certificate.ts` asks openssl for: X.509 v3,
 * `ecdsa-with-SHA256`, subject and issuer `CN=fremkit`, the SANs, `basicConstraints CA:FALSE`,
 * `keyUsage digitalSignature`, `extendedKeyUsage serverAuth`. The key never leaves memory.
 */

/** One DNS name made of plain labels; the only kind a SAN `dNSName` is written for. */
export const DNS_NAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

/** A DER length: short form up to 127, long form (`0x80 | n` then n big-endian bytes) above. */
export function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, ...items)
const set = (...items: Buffer[]): Buffer => tlv(0x31, ...items)
const octetString = (content: Buffer): Buffer => tlv(0x04, content)
const bitString = (content: Buffer, unusedBits = 0): Buffer => tlv(0x03, Buffer.from([unusedBits]), content)
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 | n, content)

/** A non-negative INTEGER from big-endian bytes, minimally encoded: a 0x00 first when the top bit is set. */
export function derInteger(bytes: Buffer): Buffer {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const trimmed = bytes.subarray(start)
  const body = trimmed.length === 0 ? Buffer.from([0]) : trimmed
  return tlv(0x02, (body[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), body]) : body)
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const bytes = [parts[0] * 40 + parts[1]]
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f]
    for (let n = Math.floor(part / 128); n > 0; n = Math.floor(n / 128)) chunk.unshift(0x80 | (n & 0x7f))
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050, in UTC to the second. */
export function derTime(date: Date): Buffer {
  const year = date.getUTCFullYear()
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  if (year >= 1950 && year <= 2049) return tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}`, 'ascii'))
  return tlv(0x18, Buffer.from(`${pad(year, 4)}${rest}`, 'ascii'))
}

/** The 4 or 16 bytes of an IP literal. A zoned IPv6 address has no place in a certificate. */
export function ipBytes(address: string): Buffer {
  const family = isIP(address)
  if (family === 4) return Buffer.from(address.split('.').map(Number))
  if (family !== 6 || address.includes('%')) throw new Error('invalid certificate address')
  // An embedded IPv4 tail (`::ffff:192.0.2.1`) becomes its two 16-bit words.
  const text = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_m, a: string, b: string, c: string, d: string) =>
    `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`)
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map((h) => parseInt(h, 16)))
  const halves = text.split('::')
  const front = parse(halves[0])
  const back = halves.length === 2 ? parse(halves[1]) : []
  const fill = halves.length === 2 ? new Array<number>(8 - front.length - back.length).fill(0) : []
  const words = [...front, ...fill, ...back]
  if (words.length !== 8) throw new Error('invalid certificate address')
  const out = Buffer.alloc(16)
  words.forEach((w, i) => out.writeUInt16BE(w, i * 2))
  return out
}

const OID_CN = '2.5.4.3'
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const OID_SAN = '2.5.29.17'
const OID_BASIC_CONSTRAINTS = '2.5.29.19'
const OID_KEY_USAGE = '2.5.29.15'
const OID_EXT_KEY_USAGE = '2.5.29.37'
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

/** The same common name openssl is given on the Mac (`CN = fremkit`). */
const COMMON_NAME = 'fremkit'

const name = (): Buffer => sequence(set(sequence(oid(OID_CN), tlv(0x0c, Buffer.from(COMMON_NAME, 'utf8')))))
const extension = (id: string, value: Buffer): Buffer => sequence(oid(id), octetString(value))

function subjectAltName(names: { dns: string[]; ips: string[] }): Buffer | null {
  const entries: Buffer[] = []
  for (const dns of names.dns) {
    if (!DNS_NAME_RE.test(dns)) throw new Error('invalid certificate host name')
    entries.push(tlv(0x82, Buffer.from(dns, 'ascii')))
  }
  for (const ip of names.ips) entries.push(tlv(0x87, ipBytes(ip)))
  return entries.length === 0 ? null : extension(OID_SAN, sequence(...entries))
}

/** A positive, non-zero 16-byte serial (RFC 5280 4.1.2.2). */
function serialNumber(): Buffer {
  const bytes = randomBytes(16)
  if (bytes.every((b) => b === 0)) bytes[15] = 1
  return derInteger(bytes)
}

/**
 * A self-signed certificate (PEM) for `privateKey`, an EC P-256 key, valid `days` from `now`, with
 * `names.dns` as DNS SANs and `names.ips` as IP SANs; no SAN extension when both are empty.
 */
export function selfSignedCertificate(
  privateKey: KeyObject,
  names: { dns: string[]; ips: string[] },
  days: number,
  now: Date = new Date(),
): string {
  const notBefore = new Date(Math.floor(now.getTime() / 1000) * 1000)
  const notAfter = new Date(notBefore.getTime() + days * 86_400_000)
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const algorithm = sequence(oid(OID_ECDSA_SHA256))
  const san = subjectAltName(names)
  const extensions = [
    ...(san === null ? [] : [san]),
    extension(OID_BASIC_CONSTRAINTS, sequence()),
    // digitalSignature is bit 0: one byte 0x80, seven unused bits.
    extension(OID_KEY_USAGE, bitString(Buffer.from([0x80]), 7)),
    extension(OID_EXT_KEY_USAGE, sequence(oid(OID_SERVER_AUTH))),
  ]
  const tbs = sequence(
    explicit(0, derInteger(Buffer.from([2]))),
    serialNumber(),
    algorithm,
    name(),
    sequence(derTime(notBefore), derTime(notAfter)),
    name(),
    spki,
    explicit(3, sequence(...extensions)),
  )
  const signature = sign('sha256', tbs, privateKey)
  const der = sequence(tbs, algorithm, bitString(signature))
  const lines = der.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}
