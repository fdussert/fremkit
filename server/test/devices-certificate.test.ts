import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { mkdtemp, readdir } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_OPENSSL,
  TLS_KEY_SECRET,
  ensureKey,
  readKey,
  issueCertificate,
  resetKey,
  spkiHash,
} from '../src/devices/certificate.js'
import { lanAddresses, localHostName } from '../src/devices/host.js'
import { FileSecretStore } from '../src/secrets/file.js'
import { assertSecretKey } from '../src/secrets/types.js'
import type { Exec } from '../src/secrets/keychain.js'
import type { SecretStore } from '../src/secrets/types.js'

const hasOpenssl = spawnSync(DEFAULT_OPENSSL, ['version']).status === 0

/**
 * The two ways the key and certificate are made: openssl on the Mac, the in-process DER writer on
 * Windows. Each runs wherever it can, so both are checked on every OS that has openssl.
 */
const BACKENDS = [
  { label: 'openssl', opts: { platform: 'darwin' as const }, available: hasOpenssl },
  { label: 'in process', opts: { platform: 'win32' as const }, available: true },
]

const OPENSSL = { platform: 'darwin' as const }

const ONE_LINE_BASE64 = /^[A-Za-z0-9+/]+=*$/

/**
 * Behaves like the macOS keychain through `security`: a value containing a newline comes back
 * from `find-generic-password -w` as a hex dump of its bytes.
 */
class KeychainLikeStore implements SecretStore {
  readonly raw = new Map<string, string>()
  writes = 0
  async get(key: string): Promise<string | null> {
    assertSecretKey(key)
    const value = this.raw.get(key)
    if (value === undefined) return null
    return value.includes('\n') ? Buffer.from(value, 'utf8').toString('hex') : value
  }
  async set(key: string, value: string): Promise<void> {
    assertSecretKey(key)
    this.writes++
    this.raw.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.raw.delete(key)
  }
}

async function tempStore(): Promise<FileSecretStore> {
  return new FileSecretStore(join(await mkdtemp(join(tmpdir(), 'fremkit-tls-test-')), 'secrets.json'))
}

const namesA = { host: 'example.local', addresses: ['192.0.2.10'] }
const namesB = { host: 'example.local', addresses: ['198.51.100.7', '192.0.2.20'] }

/** An exec that fails the way `execFile` does: the command line, with its arguments, in the message. */
const failingExec: Exec = async (cmd, args) => {
  throw Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}`), {
    code: 1,
    stderr: 'unable to load key',
  })
}

describe.each(BACKENDS)('pairing TLS key and certificate ($label)', ({ opts, available }) => {

  it.skipIf(!available)('returns the same key on every call', async () => {
    const secrets = await tempStore()
    const first = await ensureKey(secrets, opts)
    expect(first).toMatch(/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n/)
    expect(await ensureKey(secrets, opts)).toBe(first)
    expect(await secrets.get(TLS_KEY_SECRET)).toMatch(ONE_LINE_BASE64)
  })

  it.skipIf(!available)('generates a single key for overlapping first calls', async () => {
    const secrets = await tempStore()
    const [a, b] = await Promise.all([ensureKey(secrets, opts), ensureKey(secrets, opts)])
    expect(a).toBe(b)
    expect(spkiHash(a)).toBe(spkiHash((await readKey(secrets))!))
  })

  it.skipIf(!available)('keeps the SPKI hash across certificates for different addresses', async () => {
    const key = await ensureKey(await tempStore(), opts)
    const certA = await issueCertificate(key, namesA, opts)
    const certB = await issueCertificate(key, namesB, opts)
    expect(certA).not.toBe(certB)
    expect(spkiHash(certA)).toBe(spkiHash(certB))
    expect(spkiHash(certA)).toBe(spkiHash(key))
    expect(spkiHash(certA)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it.skipIf(!available)('issues a ten-year self-signed certificate with the SANs', async () => {
    const key = await ensureKey(await tempStore(), opts)
    const cert = new X509Certificate(await issueCertificate(key, namesA, opts))
    expect(cert.subjectAltName).toContain('DNS:example.local')
    expect(cert.subjectAltName).toContain('IP Address:192.0.2.10')
    expect(cert.subject).toBe('CN=fremkit')
    expect(cert.ca).toBe(false)
    // Extended key usage: TLS server authentication (id-kp-serverAuth), and nothing else.
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1'])
    expect(cert.issuer).toBe(cert.subject)
    expect(cert.verify(cert.publicKey)).toBe(true)
    const days = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000
    expect(Math.round(days)).toBe(3650)
  })

  it.skipIf(!available)('issues a certificate without SANs when there are no names', async () => {
    const key = await ensureKey(await tempStore(), opts)
    const cert = new X509Certificate(await issueCertificate(key, { host: null, addresses: [] }, opts))
    expect(cert.subjectAltName).toBeUndefined()
  })

  it.skipIf(!available)('changes the hash when the key is reset', async () => {
    const secrets = await tempStore()
    const before = spkiHash(await ensureKey(secrets, opts))
    const reset = await resetKey(secrets, opts)
    expect(spkiHash(reset)).not.toBe(before)
    expect(await ensureKey(secrets, opts)).toBe(reset)
  })

  it.skipIf(opts.platform !== 'win32')('makes the key and certificate without running anything', async () => {
    const exec: Exec = async () => { throw new Error('nothing may run') }
    const key = await ensureKey(await tempStore(), { ...opts, exec })
    const cert = new X509Certificate(await issueCertificate(key, namesA, { ...opts, exec }))
    expect(cert.checkPrivateKey(createPrivateKey(key))).toBe(true)
    expect(createPrivateKey(key).asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    await expect(issueCertificate(key, { host: 'a\n[v3]', addresses: [] }, { ...opts, exec })).rejects.toThrow()
    await expect(issueCertificate(key, { host: null, addresses: ['192.0.2.1,DNS:x'] }, { ...opts, exec })).rejects.toThrow()
  })

  it.skipIf(opts.platform !== 'win32')('keeps an unusable key out of the error', async () => {
    const key = '-----BEGIN PRIVATE KEY-----\nPLACEHOLDER\n-----END PRIVATE KEY-----\n'
    const err = await issueCertificate(key, namesA, opts).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('PLACEHOLDER')
  })
})

describe('pairing TLS key and certificate through openssl', () => {
  it('stores the key under a valid secret key', () => {
    expect(() => assertSecretKey(TLS_KEY_SECRET)).not.toThrow()
  })

  it('keeps the key out of the error when openssl fails', async () => {
    const key = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIPLACEHOLDER\n-----END EC PRIVATE KEY-----\n'
    const err = await issueCertificate(key, namesA, { ...OPENSSL, exec: failingExec }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).not.toContain('BEGIN')
    expect(message).not.toContain('PLACEHOLDER')
    expect(message).not.toContain('subjectAltName')
    expect(message).toContain('code 1')
  })

  it('removes its temporary directory when openssl fails', async () => {
    const seen: string[] = []
    const exec: Exec = async (cmd, args) => {
      seen.push(args[args.indexOf('-key') + 1]!)
      return failingExec(cmd, args)
    }
    await issueCertificate('not a key', namesA, { ...OPENSSL, exec }).catch(() => undefined)
    const dir = join(seen[0]!, '..')
    await expect(readdir(dir)).rejects.toThrow()
  })

  it('reports a failed key generation without storing anything', async () => {
    const secrets = await tempStore()
    const err = await ensureKey(secrets, { ...OPENSSL, exec: failingExec }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('code 1')
    expect(await secrets.get(TLS_KEY_SECRET)).toBeNull()
  })

  it('refuses names that could not be written safely into the config', async () => {
    const exec: Exec = async () => ({ stdout: '' })
    await expect(issueCertificate('k', { host: 'a\n[v3]', addresses: [] }, { ...OPENSSL, exec })).rejects.toThrow()
    await expect(issueCertificate('k', { host: null, addresses: ['192.0.2.1,DNS:x'] }, { ...OPENSSL, exec })).rejects.toThrow()
  })
})

describe.each(BACKENDS)('pairing TLS key in a keychain-like store ($label)', ({ opts, available }) => {
  it.skipIf(!available)('reads back a usable key with the same hash after a restart', async () => {
    const store = new KeychainLikeStore()
    const first = await ensureKey(store, opts)
    expect(store.raw.get(TLS_KEY_SECRET)).toMatch(ONE_LINE_BASE64)
    // A fresh read goes through the store, as after a server restart.
    const again = await ensureKey(store, opts)
    expect(spkiHash(again)).toBe(spkiHash(first))
    const cert = await issueCertificate(again, { host: 'example.local', addresses: ['192.0.2.10'] }, opts)
    expect(spkiHash(cert)).toBe(spkiHash(first))
  })

  it.skipIf(!available)('heals a PEM the keychain returns as hex', async () => {
    const pem = await ensureKey(await tempStore(), opts)
    const store = new KeychainLikeStore()
    store.raw.set(TLS_KEY_SECRET, createPrivateKey(pem).export({ type: 'sec1', format: 'pem' }).toString())
    expect(await store.get(TLS_KEY_SECRET)).toMatch(/^2d2d2d2d2d424547494e/)
    const read = await ensureKey(store, opts)
    expect(spkiHash(read)).toBe(spkiHash(pem))
    expect(store.raw.get(TLS_KEY_SECRET)).toMatch(ONE_LINE_BASE64)
    const writes = store.writes
    expect(spkiHash((await ensureKey(store, opts))!)).toBe(spkiHash(pem))
    expect(store.writes).toBe(writes)
  })

  it.skipIf(!available)('reads a stored PEM and rewrites it on one line', async () => {
    const secrets = await tempStore()
    const pem = await ensureKey(await tempStore(), opts)
    await secrets.set(TLS_KEY_SECRET, pem)
    expect(spkiHash((await readKey(secrets))!)).toBe(spkiHash(pem))
    expect(await secrets.get(TLS_KEY_SECRET)).toMatch(ONE_LINE_BASE64)
  })

  it('keeps an unreadable stored value out of the error', async () => {
    const store = new KeychainLikeStore()
    store.raw.set(TLS_KEY_SECRET, 'not-a-key-SENTINELVALUE')
    const err = await readKey(store).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('SENTINELVALUE')
  })
})

describe('host identity', () => {
  it('reads the local host name through scutil', async () => {
    const calls: Array<[string, string[]]> = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, args])
      return { stdout: 'example\n' }
    }
    expect(await localHostName(exec)).toBe('example')
    expect(calls).toEqual([['/usr/sbin/scutil', ['--get', 'LocalHostName']]])
  })

  it('returns null when scutil fails or prints something odd', async () => {
    expect(await localHostName(failingExec)).toBeNull()
    expect(await localHostName(async () => ({ stdout: 'bad name\n' }))).toBeNull()
  })

  it('lists sorted, external IPv4 addresses only', () => {
    const list = lanAddresses()
    for (const address of list) {
      expect(isIPv4(address)).toBe(true)
      expect(address.startsWith('127.')).toBe(false)
    }
    expect(list).toEqual([...list].sort())
  })
})
