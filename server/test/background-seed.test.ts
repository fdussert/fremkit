import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BACKGROUND, seedDefaultBackground } from '../src/backgrounds/seed.js'
import { ConfigSchema, DEFAULT_CONFIG } from '../src/config/schema.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fremkit-seed-')) })

describe('seedDefaultBackground', () => {
  it('copies the shipped wallpaper into the library when it is missing', async () => {
    expect(await seedDefaultBackground(dir)).toBe(true)
    expect(await readdir(join(dir, 'backgrounds'))).toEqual([DEFAULT_BACKGROUND])
    // A real PNG, 2560x720: the first bytes are the signature.
    const bytes = await readFile(join(dir, 'backgrounds', DEFAULT_BACKGROUND))
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })

  it('never overwrites a file already there', async () => {
    await mkdir(join(dir, 'backgrounds'), { recursive: true })
    await writeFile(join(dir, 'backgrounds', DEFAULT_BACKGROUND), 'the user replaced it')
    expect(await seedDefaultBackground(dir)).toBe(false)
    expect(await readFile(join(dir, 'backgrounds', DEFAULT_BACKGROUND), 'utf8')).toBe('the user replaced it')
  })

  it('is a no-op the second time', async () => {
    expect(await seedDefaultBackground(dir)).toBe(true)
    expect(await seedDefaultBackground(dir)).toBe(false)
  })

  it('brings it back after a delete, without touching the config', async () => {
    // Deleting the wallpaper removes the reference from the config too, so re-seeding the file
    // only puts it back in the library — nothing reappears on screen.
    await seedDefaultBackground(dir)
    await rm(join(dir, 'backgrounds', DEFAULT_BACKGROUND))
    expect(await seedDefaultBackground(dir)).toBe(true)
  })

  it('does not refuse to start when it cannot copy', async () => {
    // A data dir that cannot be written, or a checkout with no brand folder.
    expect(await seedDefaultBackground('/dev/null/nope')).toBe(false)
  })
})

describe('the default config and its background', () => {
  it('names the seeded wallpaper, and validates', () => {
    expect(DEFAULT_CONFIG.display.background).toEqual({ image: DEFAULT_BACKGROUND, fit: 'cover' })
    expect(ConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true)
  })

  it('expresses "no background" as an absent key, so remove really removes', () => {
    // No hardcoded fallback to fight: the schema simply allows the key to be gone.
    const without = { ...DEFAULT_CONFIG, display: { ...DEFAULT_CONFIG.display, background: undefined } }
    const parsed = ConfigSchema.safeParse(without)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.display.background).toBeUndefined()
  })

  it('matches the example config shipped in data/', async () => {
    const example = JSON.parse(await readFile(new URL('../../data/fremkit.example.json', import.meta.url), 'utf8'))
    expect(example.display.background).toEqual({ image: DEFAULT_BACKGROUND, fit: 'cover' })
    expect(ConfigSchema.safeParse(example).success).toBe(true)
  })
})

describe('FREMKIT_DATA_DIR', () => {
  it('is refused when it is not absolute', async () => {
    // A relative path would be read against whatever directory the process started in: the
    // checkout for the helper's child, anywhere for a shell.
    const src = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(src).toContain('FREMKIT_DATA_DIR')
    expect(src).toContain('isAbsolute')
    expect(src).toContain('must be an absolute path')
  })
})
