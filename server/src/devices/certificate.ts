import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileAsync, type Exec } from '../secrets/keychain.js'
import type { SecretStore } from '../secrets/types.js'
import { tr } from '../i18n.js'

/**
 * Where the pairing listener's private key lives in the secrets store: base64 of its PKCS8 DER, on
 * one line (see `toStored`). Older PEM values are still read and rewritten in that form.
 */
export const TLS_KEY_SECRET = 'devices/tls-key'

/** Ten years: the certificate is pinned by its key, so its expiry only has to never bite. */
const CERT_DAYS = 3650

/**
 * macOS's own `openssl` (LibreSSL) by absolute path: under the helper, PATH has no Homebrew,
 * and a developer's Homebrew OpenSSL first in PATH must not change what the app runs.
 */
export const DEFAULT_OPENSSL = process.platform === 'darwin' ? '/usr/bin/openssl' : 'openssl'

export interface OpensslOptions {
  exec?: Exec
  openssl?: string
}

/** One DNS name made of plain labels: it is written into an openssl config file. */
const DNS_NAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

/**
 * Describes a failed openssl call by its exit status only. Node puts the command line in
 * `err.message` and openssl may echo its input on stderr; neither may reach a log or an HTTP
 * body, so nothing but the status leaves this module (same rule as `secrets/keychain.ts`).
 */
function describe(err: unknown): string {
  const e = err as { code?: unknown; signal?: unknown }
  if (typeof e?.code === 'number') return `openssl: code ${e.code}`
  if (typeof e?.code === 'string') return `openssl: ${e.code}`
  if (typeof e?.signal === 'string') return `openssl: signal ${e.signal}`
  return 'openssl: unknown error'
}

async function generateKey(opts: OpensslOptions): Promise<string> {
  const exec = opts.exec ?? execFileAsync
  const openssl = opts.openssl ?? DEFAULT_OPENSSL
  let stdout: string
  try {
    ;({ stdout } = await exec(openssl, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout']))
  } catch (err) {
    throw new Error(`${tr(undefined, 'devices.keyFailed')} (${describe(err)})`)
  }
  const pem = stdout.trim() + '\n'
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n/.test(pem)) {
    throw new Error(`${tr(undefined, 'devices.keyFailed')} (openssl: unexpected output)`)
  }
  return pem
}

/**
 * How the key is kept in the store: base64 of its PKCS8 DER, on one line.
 *
 * Not the PEM itself: the macOS keychain hands back a value that contains a newline as a hex
 * dump (`security find-generic-password -w`), so a stored PEM never reads back as a PEM.
 */
function toStored(pem: string): string {
  return createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' }).toString('base64')
}

function keyUnreadable(): Error {
  return new Error(`${tr(undefined, 'devices.keyFailed')} (stored key unreadable)`)
}

/**
 * Turns a stored value into a PKCS8 PEM. Accepts the one-line base64 DER this module writes,
 * a PEM (the file backend and values written before the one-line form), and the hex dump the
 * keychain returns for a PEM that was stored as is. Errors never quote the value.
 */
function fromStored(value: string): { pem: string; canonical: boolean } {
  const text = value.trim()
  try {
    if (text.startsWith('-----BEGIN')) return { pem: normalisePem(text), canonical: false }
    if (/^(?:[0-9a-fA-F]{2})+$/.test(text)) {
      const decoded = Buffer.from(text, 'hex').toString('utf8')
      if (decoded.startsWith('-----BEGIN')) return { pem: normalisePem(decoded), canonical: false }
    }
    const der = Buffer.from(text, 'base64')
    const pem = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
    return { pem, canonical: true }
  } catch {
    throw keyUnreadable()
  }
}

function normalisePem(pem: string): string {
  return createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString()
}

/**
 * The stored pairing key as a PEM, or null when there is none. A value found in an older form
 * (a PEM, or the keychain's hex dump of one) is written back in the one-line form.
 */
export async function readKey(secrets: SecretStore): Promise<string | null> {
  const value = await secrets.get(TLS_KEY_SECRET)
  if (!value) return null
  const { pem, canonical } = fromStored(value)
  if (!canonical) {
    // Best effort: a store that cannot be written still serves the key it holds.
    await secrets.set(TLS_KEY_SECRET, toStored(pem)).catch(() => undefined)
  }
  return pem
}

async function storeNewKey(secrets: SecretStore, opts: OpensslOptions): Promise<string> {
  const generated = await generateKey(opts)
  let pem: string
  let stored: string
  try {
    pem = normalisePem(generated)
    stored = toStored(pem)
  } catch {
    throw new Error(`${tr(undefined, 'devices.keyFailed')} (openssl: unexpected output)`)
  }
  await secrets.set(TLS_KEY_SECRET, stored)
  return pem
}

// One generation at a time per store: two listeners starting together must not each mint a key
// and leave the store holding a different one from the certificate already handed out.
const pending = new WeakMap<SecretStore, Promise<string>>()

/** The pairing TLS key (PKCS8 PEM), generated and stored on first use. */
export function ensureKey(secrets: SecretStore, opts: OpensslOptions = {}): Promise<string> {
  const inFlight = pending.get(secrets)
  if (inFlight) return inFlight
  const run = (async () => (await readKey(secrets)) ?? (await storeNewKey(secrets, opts)))()
  pending.set(secrets, run)
  return run.finally(() => pending.delete(secrets))
}

/** Replaces the pairing TLS key. Every paired device pinned the old one and has to pair again. */
export async function resetKey(secrets: SecretStore, opts: OpensslOptions = {}): Promise<string> {
  await pending.get(secrets)?.catch(() => undefined)
  return storeNewKey(secrets, opts)
}

function configFor(names: { host: string | null; addresses: string[] }): string {
  const san: string[] = []
  if (names.host !== null) {
    if (!DNS_NAME_RE.test(names.host)) throw new Error('invalid certificate host name')
    san.push(`DNS:${names.host}`)
  }
  for (const address of names.addresses) {
    if (isIP(address) === 0) throw new Error('invalid certificate address')
    san.push(`IP:${address}`)
  }
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '',
    '[dn]',
    'CN = fremkit',
    '',
    '[v3]',
    ...(san.length > 0 ? [`subjectAltName = ${san.join(',')}`] : []),
    'basicConstraints = CA:FALSE',
    'keyUsage = digitalSignature',
    'extendedKeyUsage = serverAuth',
    '',
  ].join('\n')
}

/**
 * A self-signed certificate for `keyPem`, valid ten years, CN `fremkit`, with `host` as a DNS
 * name (used verbatim, e.g. `<LocalHostName>.local`) and `addresses` as IP SANs.
 *
 * LibreSSL has no `-addext`, so the SANs go through a config file. It and the key are written
 * to a private temporary directory that is removed whatever happens.
 */
export async function issueCertificate(
  keyPem: string,
  names: { host: string | null; addresses: string[] },
  opts: OpensslOptions = {},
): Promise<string> {
  const exec = opts.exec ?? execFileAsync
  const openssl = opts.openssl ?? DEFAULT_OPENSSL
  const config = configFor(names)
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-tls-'))
  try {
    await chmod(dir, 0o700)
    const keyFile = join(dir, 'key.pem')
    const configFile = join(dir, 'openssl.cnf')
    await writeFile(keyFile, keyPem, { mode: 0o600 })
    await writeFile(configFile, config, { mode: 0o600 })
    let stdout: string
    try {
      ;({ stdout } = await exec(openssl, [
        'req', '-new', '-x509', '-sha256',
        '-key', keyFile,
        '-days', String(CERT_DAYS),
        '-config', configFile,
        '-extensions', 'v3',
      ]))
    } catch (err) {
      throw new Error(`${tr(undefined, 'devices.certFailed')} (${describe(err)})`)
    }
    const match = /-----BEGIN CERTIFICATE-----\n[\s\S]*?\n-----END CERTIFICATE-----/.exec(stdout)
    if (!match) throw new Error(`${tr(undefined, 'devices.certFailed')} (openssl: unexpected output)`)
    return match[0] + '\n'
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Base64url SHA-256 of the public key's SPKI DER, from a certificate or a private key PEM. */
export function spkiHash(certOrKeyPem: string): string {
  const der = createPublicKey(certOrKeyPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('base64url')
}
