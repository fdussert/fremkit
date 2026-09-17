import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertSecretKey, type SecretStore } from './types.js'

/** Owner read/write only: the file holds plaintext secrets. */
const MODE = 0o600

/**
 * Secrets in `data/secrets.json`, the fallback backend when there is no macOS keychain.
 *
 * Reads are forgiving (a missing or corrupt file is an empty store, never an exception) because
 * losing the file must degrade to "the user retypes the secrets", not to a server that refuses
 * to boot. Writes are atomic and never widen the mode.
 */
export class FileSecretStore implements SecretStore {
  constructor(private readonly filePath: string) {}

  // Serializes mutations on this instance: without it, two overlapping set/delete calls would
  // each read the same on-disk snapshot and the last write would silently clobber the other's
  // change. Reads (`get`) are not queued — they only read the file, so there is nothing to race.
  private queue: Promise<unknown> = Promise.resolve()

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    // Chain onward regardless of outcome: a failed mutation must not wedge the queue and block
    // every later call, and the failure still reaches the caller through `result`.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async readAll(): Promise<Record<string, string>> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch {
      return {}
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
    return out
  }

  private async writeAll(all: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    // The mode is given at creation *and* forced afterwards: `writeFile` only applies `mode`
    // when it creates the file, so a leftover temporary from a crashed run would keep its own.
    await writeFile(tmp, JSON.stringify(all, null, 2) + '\n', { encoding: 'utf8', mode: MODE })
    await chmod(tmp, MODE)
    await rename(tmp, this.filePath)
  }

  async get(key: string): Promise<string | null> {
    assertSecretKey(key)
    return (await this.readAll())[key] ?? null
  }

  async set(key: string, value: string): Promise<void> {
    assertSecretKey(key)
    return this.enqueue(async () => {
      const all = await this.readAll()
      all[key] = value
      await this.writeAll(all)
    })
  }

  async delete(key: string): Promise<void> {
    assertSecretKey(key)
    return this.enqueue(async () => {
      const all = await this.readAll()
      if (!(key in all)) return
      delete all[key]
      await this.writeAll(all)
    })
  }
}
