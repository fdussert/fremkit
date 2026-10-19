import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Requests refused for wrong codes, within `LOCK_WINDOW_MS`, that lock pairing. */
export const MAX_EXHAUSTED_REQUESTS = 5
export const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Pairing locked after too many wrong codes, until the user unlocks it in Settings → Devices.
 *
 * Each request allows three wrong codes; a local program that forges Companion's `Origin` can
 * still make five requests a minute and keep guessing. So once `MAX_EXHAUSTED_REQUESTS` requests
 * were refused for wrong codes within a day, new requests are refused until the admin unlocks.
 *
 * Kept in memory and in a small file next to devices.json (`companion-lock.json`, mode 0600), so a
 * restart (which such a program could cause) does not clear it. Only the lock is persisted, not
 * the count before it: a restart forgets up to four refusals, which costs a guesser a restart per
 * twelve guesses. A file that cannot be read counts as locked, as does one that cannot be parsed:
 * failing closed costs the user one tap on Unlock.
 */
export class PairingLock {
  private lockedSince: number | null = null
  private exhausted: number[] = []

  constructor(private readonly filePath: string | null) {}

  /** Reads the persisted flag. A missing file is unlocked. */
  async load(): Promise<void> {
    if (this.filePath === null) return
    try {
      const body = JSON.parse(await readFile(this.filePath, 'utf8')) as { locked?: unknown; since?: unknown }
      if (body.locked === true) this.lockedSince = typeof body.since === 'number' ? body.since : 0
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.lockedSince = 0
    }
  }

  get locked(): boolean {
    return this.lockedSince !== null
  }

  /** Counts a request refused for wrong codes; true when it locked pairing. */
  async noteExhausted(now: number): Promise<boolean> {
    this.exhausted = this.exhausted.filter((t) => now - t < LOCK_WINDOW_MS)
    this.exhausted.push(now)
    if (this.locked || this.exhausted.length < MAX_EXHAUSTED_REQUESTS) return false
    this.lockedSince = now
    await this.persist()
    return true
  }

  /** The user's Unlock: pairing opens again, and the count starts over. */
  async unlock(): Promise<void> {
    this.lockedSince = null
    this.exhausted = []
    if (this.filePath !== null) await rm(this.filePath, { force: true })
  }

  private async persist(): Promise<void> {
    if (this.filePath === null) return
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify({ locked: true, since: this.lockedSince }) + '\n', { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.filePath)
  }
}
