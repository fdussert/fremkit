import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { access, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tr } from '../i18n.js'
import { HostError, sharedHost, type HostOp } from '../win/powershell-host.js'
import { nodeIo, writeFileDurably, type DurableIo } from './durable.js'
import { assertSecretKey, type SecretStore } from './types.js'

/** Owner read/write only, as for every runtime file (the folder's ACL already says so on Windows). */
const MODE = 0o600
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/**
 * A DPAPI call's own budget. The host's start-up (spawn plus its Add-Type, up to 20 s) and the
 * wait for its turn behind other calls (up to `QUEUE_WAIT_MS`, then `busy`) are timed separately
 * and before this starts, but a cold DPAPI on a loaded machine is still not instant. Worst case a
 * first read (a connection's Test) waits about a minute, then fails with a code: never forever.
 */
const DPAPI_TIMEOUT_MS = 30_000

/**
 * What the host answering means "this blob will never open here": another Windows user's or
 * machine's key file (a copied data folder, a restored backup), an altered one, or one that is not
 * base64 at all. Anything else (`dpapi-failed`: a profile not loaded, the master key out of reach;
 * `timeout`, `host-exited`, …) may pass, and must never cost the user a file.
 */
const UNREADABLE_HOST_CODES = new Set(['dpapi-foreign', 'invalid-arg'])

/** Why the store started empty: fixed codes for the log, never a byte of a key or a value. */
export type DpapiUnreadable = 'dpapi-foreign' | 'invalid-arg' | 'key-invalid' | 'key-missing' | 'index-corrupt'

/** The part of `PowerShellHost` the store uses; the tests give a fake. */
export interface DpapiHost {
  call<T>(op: HostOp, arg?: unknown, timeoutMs?: number): Promise<T>
}

export interface DpapiSecretStoreOptions {
  /** The PowerShell host; the process's shared one, started on first use, when not given. */
  host?: DpapiHost
  /** Told once why existing secrets could not be read. */
  log?: (code: DpapiUnreadable) => void
  /** The file calls of a write; the node ones when not given. */
  io?: DurableIo
}

type Index = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'ok'; entries: Record<string, string> }

/**
 * Secrets on Windows, under a key only this Windows user can unwrap.
 *
 * A random 32-byte key, DPAPI-protected (CurrentUser) through the PowerShell host, is kept in
 * `secrets.key`; each value is AES-256-GCM encrypted under it in `secrets.dpapi.json`, as
 * `{ "<id>/<field>": "<iv>.<tag>.<ct>" }` (base64url), with the entry's name as additional data so a
 * ciphertext copied under another name does not open. The key is unwrapped once per process and
 * held in memory only; it and the values cross to the host only on its stdin and stdout.
 *
 * A store that cannot be read — the key file is another user's, missing beside filled entries, or
 * the index is not JSON — reads as empty, like `FileSecretStore`, so the server boots and the user
 * retypes. Its files are never overwritten in place: the first write sets them aside as
 * `<name>.unreadable-<ms>` before starting a new key. A host that is merely unreachable is not
 * that: reads and writes throw (with the host's code only) and the next call tries again.
 */
export class DpapiSecretStore implements SecretStore {
  private readonly keyPath: string
  private readonly indexPath: string
  private readonly hostOverride: DpapiHost | undefined
  private readonly log: (code: DpapiUnreadable) => void
  private readonly io: DurableIo
  private key: Buffer | null = null
  private unwrapping: Promise<Buffer | null> | null = null
  private unreadable = false

  constructor(dataDir: string, opts: DpapiSecretStoreOptions = {}) {
    this.keyPath = join(dataDir, 'secrets.key')
    this.indexPath = join(dataDir, 'secrets.dpapi.json')
    this.hostOverride = opts.host
    this.log = opts.log ?? (() => {})
    this.io = opts.io ?? nodeIo
  }

  // Serializes mutations, as in `FileSecretStore`: two overlapping writes would each read the same
  // index and the last one would drop the other's entry.
  private queue: Promise<unknown> = Promise.resolve()

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private get host(): DpapiHost {
    return this.hostOverride ?? sharedHost()
  }

  private markUnreadable(code: DpapiUnreadable): void {
    if (this.unreadable) return
    this.unreadable = true
    this.key = null
    this.log(code)
  }

  private async readIndex(): Promise<Index> {
    let text: string
    try {
      text = await readFile(this.indexPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      throw new Error(`${tr(undefined, 'secrets.storeReadFailed')} (${(err as NodeJS.ErrnoException).code ?? 'io'})`)
    }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return { kind: 'corrupt' } }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt' }
    const entries: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') entries[k] = v
    return { kind: 'ok', entries }
  }

  /** The key, or null when there is no key file yet or it will not open here (then marked). */
  private loadKey(): Promise<Buffer | null> {
    if (this.key) return Promise.resolve(this.key)
    if (this.unreadable) return Promise.resolve(null)
    // One unwrap for every caller waiting on it; a failure clears it so the next call retries.
    this.unwrapping ??= this.unwrap().finally(() => { this.unwrapping = null })
    return this.unwrapping
  }

  private async unwrap(): Promise<Buffer | null> {
    let wrapped: string
    try {
      wrapped = (await readFile(this.keyPath, 'utf8')).trim()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error(`${tr(undefined, 'secrets.storeReadFailed')} (${(err as NodeJS.ErrnoException).code ?? 'io'})`)
    }
    let plain: string
    try {
      plain = await this.host.call<string>('dpapi.unprotect', wrapped, DPAPI_TIMEOUT_MS)
    } catch (err) {
      const code = err instanceof HostError ? err.code : 'error'
      if (UNREADABLE_HOST_CODES.has(code)) {
        this.markUnreadable(code as DpapiUnreadable)
        return null
      }
      throw new Error(`${tr(undefined, 'secrets.storeReadFailed')} (${code})`)
    }
    const key = typeof plain === 'string' ? Buffer.from(plain, 'base64') : Buffer.alloc(0)
    if (key.length !== KEY_BYTES) {
      key.fill(0)
      this.markUnreadable('key-invalid')
      return null
    }
    this.key = key
    return key
  }

  /** The key and the entries, or null for a store that is empty (fresh) or unreadable (marked). */
  private async open(): Promise<{ key: Buffer; entries: Record<string, string> } | null> {
    if (this.unreadable) return null
    const index = await this.readIndex()
    if (index.kind === 'corrupt') {
      this.markUnreadable('index-corrupt')
      return null
    }
    const key = await this.loadKey()
    if (key === null) {
      // Entries with no key to open them: as unreadable as another user's key.
      if (!this.unreadable && index.kind === 'ok' && Object.keys(index.entries).length > 0) this.markUnreadable('key-missing')
      return null
    }
    return { key, entries: index.kind === 'ok' ? index.entries : {} }
  }

  /**
   * Moves an unreadable store's files out of the way, under one stamp free for both names, so the
   * key and the index it opened stay a pair; a name already taken is never replaced.
   */
  private async setAside(): Promise<void> {
    let stamp = Date.now()
    const paths = [this.keyPath, this.indexPath]
    while ((await Promise.all(paths.map((p) => exists(`${p}.unreadable-${stamp}`)))).some(Boolean)) stamp++
    for (const path of paths) {
      try {
        await rename(path, `${path}.unreadable-${stamp}`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`${tr(undefined, 'secrets.storeWriteFailed')} (${(err as NodeJS.ErrnoException).code ?? 'io'})`)
        }
      }
    }
    this.unreadable = false
    this.key = null
  }

  private async createKey(): Promise<Buffer> {
    const key = randomBytes(KEY_BYTES)
    let wrapped: string
    try {
      wrapped = await this.host.call<string>('dpapi.protect', key.toString('base64'), DPAPI_TIMEOUT_MS)
    } catch (err) {
      key.fill(0)
      throw new Error(`${tr(undefined, 'secrets.storeWriteFailed')} (${err instanceof HostError ? err.code : 'error'})`)
    }
    if (typeof wrapped !== 'string' || wrapped === '') {
      key.fill(0)
      throw new Error(`${tr(undefined, 'secrets.storeWriteFailed')} (format)`)
    }
    await this.writeAtomic(this.keyPath, `${wrapped}\n`)
    this.key = key
    return key
  }

  /**
   * Flushed to disk before the rename and the folder after it: the move from `secrets.json`
   * deletes the plaintext copy on the strength of these files, so a power cut must not find them
   * renamed into place but empty.
   */
  private writeAtomic(path: string, text: string): Promise<void> {
    return writeFileDurably(this.io, path, text, MODE)
  }

  async get(key: string): Promise<string | null> {
    assertSecretKey(key)
    const opened = await this.open()
    const sealed = opened?.entries[key]
    return opened && sealed !== undefined ? unseal(opened.key, key, sealed) : null
  }

  async set(key: string, value: string): Promise<void> {
    assertSecretKey(key)
    return this.enqueue(async () => {
      let opened = await this.open()
      if (this.unreadable) {
        await this.setAside()
        opened = null
      }
      const cipherKey = opened?.key ?? (await this.createKey())
      const entries = opened?.entries ?? {}
      entries[key] = seal(cipherKey, key, value)
      await this.writeAtomic(this.indexPath, JSON.stringify(entries, null, 2) + '\n')
    })
  }

  async delete(key: string): Promise<void> {
    assertSecretKey(key)
    return this.enqueue(async () => {
      // Nothing readable holds the key: nothing to write, and an unreadable store stays as it is.
      const opened = await this.open()
      if (!opened || !(key in opened.entries)) return
      delete opened.entries[key]
      await this.writeAtomic(this.indexPath, JSON.stringify(opened.entries, null, 2) + '\n')
    })
  }

  async keysOf(connectionId: string): Promise<string[]> {
    const prefix = `${connectionId}/`
    const opened = await this.open()
    return opened ? Object.keys(opened.entries).filter((k) => k.startsWith(prefix)) : []
  }

  /** Every key the store can open: what the move from `secrets.json` checks it against. */
  async keys(): Promise<string[]> {
    const opened = await this.open()
    return opened ? Object.keys(opened.entries) : []
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function seal(key: Buffer, name: string, value: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(name, 'utf8'))
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.')
}

/** The value, or null for anything that does not authenticate: tampered, moved, or not ours. */
function unseal(key: Buffer, name: string, sealed: string): string | null {
  const parts = sealed.split('.')
  if (parts.length !== 3) return null
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'))
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(name, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
