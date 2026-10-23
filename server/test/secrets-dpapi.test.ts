import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DpapiSecretStore, type DpapiHost } from '../src/secrets/dpapi.js'
import { HostError, PowerShellHost } from '../src/win/powershell-host.js'
import { expectMode } from './helpers/modes.js'

const dir = () => mkdtemp(join(tmpdir(), 'fremkit-dpapi-'))

/** Stands in for DPAPI: a reversible XOR, so a "protected" key is not the key itself. */
class FakeHost implements DpapiHost {
  calls: { op: string; timeoutMs?: number }[] = []
  /** When set, unprotect answers this code, as DPAPI does for another user's or machine's blob. */
  failUnprotect: string | null = null
  failProtect: string | null = null
  /** A different mask is a different Windows user: what one protected, the other cannot read. */
  constructor(private readonly mask = 0x5a) {}

  async call<T>(op: string, arg?: unknown, timeoutMs?: number): Promise<T> {
    this.calls.push({ op, timeoutMs })
    if (op === 'dpapi.unprotect' && this.failUnprotect) throw new HostError(this.failUnprotect)
    if (op === 'dpapi.protect' && this.failProtect) throw new HostError(this.failProtect)
    if (op !== 'dpapi.protect' && op !== 'dpapi.unprotect') throw new HostError('unknown-op')
    const bytes = Buffer.from(arg as string, 'base64')
    return Buffer.from(bytes.map((b) => b ^ this.mask)).toString('base64') as T
  }
}

const store = (dataDir: string, host: DpapiHost, log?: (code: string) => void) => new DpapiSecretStore(dataDir, { host, log })

describe('DpapiSecretStore', () => {
  it('round-trips set, get and delete, and a fresh store reads null without asking DPAPI', async () => {
    const d = await dir()
    const host = new FakeHost()
    const s = store(d, host)
    expect(await s.get('gh-x1z9/token')).toBeNull()
    expect(host.calls).toEqual([])
    await s.set('gh-x1z9/token', 'placeholder-token')
    await s.set('ado-a1b2/pat', 'pat-value-é')
    expect(await s.get('gh-x1z9/token')).toBe('placeholder-token')
    expect(await s.get('ado-a1b2/pat')).toBe('pat-value-é')
    await s.delete('gh-x1z9/token')
    expect(await s.get('gh-x1z9/token')).toBeNull()
    await expect(s.delete('gh-x1z9/token')).resolves.toBeUndefined()
    expect(await s.get('ado-a1b2/pat')).toBe('pat-value-é')
  })

  it('wraps a 32-byte key once, keeps nothing in clear on disk, and writes both files 600', async () => {
    const d = await dir()
    const host = new FakeHost()
    await store(d, host).set('gh-x1z9/token', 'placeholder-token')
    const keyFile = (await readFile(join(d, 'secrets.key'), 'utf8')).trim()
    // The file holds DPAPI's output (here the XOR), never the key: unwrapping gives 32 bytes.
    expect(Buffer.from(await host.call<string>('dpapi.unprotect', keyFile), 'base64')).toHaveLength(32)
    const raw = await readFile(join(d, 'secrets.dpapi.json'), 'utf8')
    expect(raw).not.toContain('placeholder-token')
    const index = JSON.parse(raw) as Record<string, string>
    expect(Object.keys(index)).toEqual(['gh-x1z9/token'])
    expect(index['gh-x1z9/token']).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    await expectMode(join(d, 'secrets.key'), 0o600)
    await expectMode(join(d, 'secrets.dpapi.json'), 0o600)
  })

  it('unwraps the key once per process, with a timeout that leaves room for the host to start', async () => {
    const d = await dir()
    await store(d, new FakeHost()).set('gh-x1z9/token', 'placeholder-token')
    const host = new FakeHost()
    const s = store(d, host)
    await Promise.all([s.get('gh-x1z9/token'), s.get('gh-x1z9/token'), s.keysOf('gh-x1z9')])
    await s.set('gh-x1z9/other', 'v')
    expect(await s.get('gh-x1z9/token')).toBe('placeholder-token')
    const unwraps = host.calls.filter((c) => c.op === 'dpapi.unprotect')
    expect(unwraps).toHaveLength(1)
    expect(unwraps[0].timeoutMs).toBeGreaterThanOrEqual(20_000)
    expect(host.calls.filter((c) => c.op === 'dpapi.protect')).toHaveLength(0)
  })

  it('lists only the keys of one connection', async () => {
    const s = store(await dir(), new FakeHost())
    await s.set('c1/token', 'a')
    await s.set('c1/user', 'b')
    await s.set('c10/token', 'c')
    await s.set('c2/token', 'd')
    expect((await s.keysOf('c1')).sort()).toEqual(['c1/token', 'c1/user'])
    expect(await s.keysOf('c3')).toEqual([])
  })

  it('serialises overlapping writes so none is lost', async () => {
    const d = await dir()
    const s = store(d, new FakeHost())
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.set(`c${i}/token`, `v${i}`)))
    const again = store(d, new FakeHost())
    for (let i = 0; i < 10; i++) expect(await again.get(`c${i}/token`)).toBe(`v${i}`)
  })

  it('reads a tampered or moved ciphertext as null, without throwing', async () => {
    const d = await dir()
    await store(d, new FakeHost()).set('c1/token', 'first')
    await store(d, new FakeHost()).set('c2/token', 'second')
    const path = join(d, 'secrets.dpapi.json')
    const index = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>
    const [iv, tag, ct] = index['c1/token'].split('.')
    const flipped = Buffer.from(ct, 'base64url')
    flipped[0] ^= 1
    index['c1/token'] = [iv, tag, flipped.toString('base64url')].join('.')
    // A valid ciphertext filed under another key is bound to its own name and does not open.
    index['c3/token'] = index['c2/token']
    index['c4/token'] = 'not.a-ciphertext'
    index['c5/token'] = 'garbage'
    await writeFile(path, JSON.stringify(index))
    const s = store(d, new FakeHost())
    for (const key of ['c1/token', 'c3/token', 'c4/token', 'c5/token']) expect(await s.get(key), key).toBeNull()
    expect(await s.get('c2/token')).toBe('second')
  })

  it('starts empty when the key cannot be unwrapped, sets the old files aside on the first write and logs the code only', async () => {
    const d = await dir()
    await store(d, new FakeHost()).set('gh-x1z9/token', 'placeholder-token')
    const oldKey = await readFile(join(d, 'secrets.key'), 'utf8')
    const oldIndex = await readFile(join(d, 'secrets.dpapi.json'), 'utf8')

    const host = new FakeHost(0x33)
    host.failUnprotect = 'dpapi-failed'
    const logged: unknown[] = []
    const s = store(d, host, (code) => logged.push(code))
    expect(await s.get('gh-x1z9/token')).toBeNull()
    expect(await s.keysOf('gh-x1z9')).toEqual([])
    // Reading never touches the files.
    expect(await readFile(join(d, 'secrets.key'), 'utf8')).toBe(oldKey)
    expect(await readFile(join(d, 'secrets.dpapi.json'), 'utf8')).toBe(oldIndex)
    // Deleting what is not readable writes nothing either.
    await s.delete('gh-x1z9/token')
    expect(await readFile(join(d, 'secrets.dpapi.json'), 'utf8')).toBe(oldIndex)

    await s.set('gh-x1z9/token', 'retyped')
    expect(await s.get('gh-x1z9/token')).toBe('retyped')
    const files = await readdir(d)
    const keyAside = files.find((f) => /^secrets\.key\.unreadable-\d+$/.test(f))
    const indexAside = files.find((f) => /^secrets\.dpapi\.json\.unreadable-\d+$/.test(f))
    expect(keyAside).toBeDefined()
    expect(indexAside).toBeDefined()
    expect(await readFile(join(d, keyAside!), 'utf8')).toBe(oldKey)
    expect(await readFile(join(d, indexAside!), 'utf8')).toBe(oldIndex)
    expect(logged).toEqual(['dpapi-failed'])
    // Reopened by the user the new key belongs to, the new store reads.
    expect(await store(d, new FakeHost(0x33)).get('gh-x1z9/token')).toBe('retyped')
  })

  it('treats a missing key beside a filled index, and a corrupt index, as unreadable rather than overwriting them', async () => {
    for (const [name, prepare, code] of [
      ['missing key', async (d: string) => {
        await store(d, new FakeHost()).set('c1/token', 'v')
        await rm(join(d, 'secrets.key'))
      }, 'key-missing'],
      ['corrupt index', async (d: string) => {
        await store(d, new FakeHost()).set('c1/token', 'v')
        await writeFile(join(d, 'secrets.dpapi.json'), '{ not json')
      }, 'index-corrupt'],
      ['short key', async (d: string) => {
        await writeFile(join(d, 'secrets.key'), Buffer.from(new Uint8Array(8).fill(0x5a)).toString('base64'))
      }, 'key-invalid'],
    ] as const) {
      const d = await dir()
      await prepare(d)
      const before = await readFile(join(d, 'secrets.dpapi.json'), 'utf8').catch(() => null)
      const logged: string[] = []
      const s = store(d, new FakeHost(), (c) => logged.push(c))
      expect(await s.get('c1/token'), name).toBeNull()
      await s.set('c2/token', 'new')
      expect(await s.get('c2/token'), name).toBe('new')
      expect(logged, name).toEqual([code])
      if (before !== null) {
        const aside = (await readdir(d)).find((f) => f.startsWith('secrets.dpapi.json.unreadable-'))
        expect(aside, name).toBeDefined()
        expect(await readFile(join(d, aside!), 'utf8'), name).toBe(before)
      }
    }
  })

  it('throws a code, not a value, when DPAPI is not reachable, and keeps the files for the next try', async () => {
    const d = await dir()
    await store(d, new FakeHost()).set('gh-x1z9/token', 'placeholder-token')
    const host = new FakeHost()
    host.failUnprotect = 'host-start-timeout'
    const logged: string[] = []
    const s = store(d, host, (c) => logged.push(c))
    const err = await s.get('gh-x1z9/token').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/host-start-timeout/)
    expect((err as Error).message).not.toContain('placeholder-token')
    await expect(s.set('gh-x1z9/token', 'x')).rejects.toThrow(/host-start-timeout/)
    expect((await readdir(d)).filter((f) => f.includes('unreadable'))).toEqual([])
    expect(logged).toEqual([])
    // The host is back: the same store unwraps and reads what was there.
    host.failUnprotect = null
    expect(await s.get('gh-x1z9/token')).toBe('placeholder-token')
  })

  it('refuses to write when the key cannot be wrapped, and leaves nothing behind', async () => {
    const d = await dir()
    const host = new FakeHost()
    host.failProtect = 'timeout'
    const s = store(d, host)
    await expect(s.set('c1/token', 'v')).rejects.toThrow(/timeout/)
    expect(await readdir(d)).toEqual([])
    host.failProtect = null
    await s.set('c1/token', 'v')
    expect(await s.get('c1/token')).toBe('v')
  })

  it('rejects a malformed key like the other stores', async () => {
    const s = store(await dir(), new FakeHost())
    await expect(s.get('../x')).rejects.toThrow(/invalid secret key/)
    await expect(s.set('a b/c', 'v')).rejects.toThrow(/invalid secret key/)
  })

  // The real thing, in the VM: DPAPI under the current user, through the PowerShell host.
  it.runIf(process.platform === 'win32')('keeps a secret across two stores through real DPAPI', async () => {
    const d = await dir()
    const host = new PowerShellHost()
    try {
      await store(d, host).set('gh-x1z9/token', 'placeholder-token')
      const again = new PowerShellHost()
      try {
        expect(await store(d, again).get('gh-x1z9/token')).toBe('placeholder-token')
      } finally { again.close() }
    } finally { host.close() }
  }, 60_000)
})
