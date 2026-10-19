import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCK_WINDOW_MS, MAX_EXHAUSTED_REQUESTS, PairingLock } from '../src/companion/lock.js'
import { tr } from '../src/i18n.js'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-companion-lock-'))
  file = join(dir, 'companion-lock.json')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('PairingLock', () => {
  it('locks on the fifth refused request within a day, and writes the flag, 0600', async () => {
    const lock = new PairingLock(file)
    await lock.load()
    expect(MAX_EXHAUSTED_REQUESTS).toBe(5)
    for (let i = 0; i < 4; i++) expect(await lock.noteExhausted(1_000 + i)).toBe(false)
    expect(lock.locked).toBe(false)
    expect(await lock.noteExhausted(2_000)).toBe(true)
    expect(lock.locked).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ locked: true, since: 2_000 })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('counts only the last day', async () => {
    const lock = new PairingLock(null)
    for (let i = 0; i < 4; i++) await lock.noteExhausted(i)
    expect(await lock.noteExhausted(LOCK_WINDOW_MS + 10)).toBe(false)
    expect(lock.locked).toBe(false)
  })

  it('reads the flag back, and unlocking removes it and starts the count over', async () => {
    await writeFile(file, JSON.stringify({ locked: true, since: 5 }))
    const lock = new PairingLock(file)
    await lock.load()
    expect(lock.locked).toBe(true)
    await lock.unlock()
    expect(lock.locked).toBe(false)
    await expect(stat(file)).rejects.toThrow()
    for (let i = 0; i < 4; i++) expect(await lock.noteExhausted(i)).toBe(false)
  })

  it('a missing file is unlocked; one that cannot be parsed is locked', async () => {
    const fresh = new PairingLock(file)
    await fresh.load()
    expect(fresh.locked).toBe(false)
    await writeFile(file, '{not json')
    const broken = new PairingLock(file)
    await broken.load()
    expect(broken.locked).toBe(true)
  })

  it('says why in both languages, word for word', () => {
    expect(tr('fr', 'companion.pairLocked')).toBe('Appairage bloqué après trop de codes faux. Débloquez-le dans Réglages → Appareils.')
    expect(tr('en', 'companion.pairLocked')).toBe('Pairing locked after too many wrong codes. Unlock it in Settings → Devices.')
    expect(tr('fr', 'companion.disabled')).toBe('Activez le compagnon dans les fonctions expérimentales de Fremkit.')
    expect(tr('en', 'companion.disabled')).toBe("Turn the companion on in Fremkit's experimental features.")
  })
})
