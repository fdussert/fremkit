import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type Config } from '../src/config/schema.js'
import { ConfigHistory } from '../src/config/history.js'
import { ConfigStore } from '../src/config/store.js'
import { DpapiSecretStore, type DpapiHost } from '../src/secrets/dpapi.js'
import { nodeIo, syncDir, type DurableHandle, type DurableIo } from '../src/secrets/durable.js'
import { FileSecretStore } from '../src/secrets/file.js'
import { moveFileSecretsToDpapi, type MoveCode, type MoveToDpapiDeps } from '../src/secrets/move-to-dpapi.js'
import { HostError } from '../src/win/powershell-host.js'
import { expectMode } from './helpers/modes.js'

/**
 * Stands in for DPAPI, as in secrets-dpapi.test.ts: a reversible XOR. `unprotectMask` different
 * from `protectMask` is a DPAPI that hands back other bytes than it was given.
 */
class FakeHost implements DpapiHost {
  calls = 0
  failProtect: string | null = null
  constructor(private readonly protectMask = 0x5a, private readonly unprotectMask = protectMask) {}

  async call<T>(op: string, arg?: unknown): Promise<T> {
    this.calls++
    if (op === 'dpapi.protect' && this.failProtect) throw new HostError(this.failProtect)
    const mask = op === 'dpapi.protect' ? this.protectMask : this.unprotectMask
    const bytes = Buffer.from(arg as string, 'base64')
    return Buffer.from(bytes.map((b) => b ^ mask)).toString('base64') as T
  }
}

const SECRETS: Record<string, string> = {
  'gh-x1z9/token': 'placeholder-token-1',
  'ado-a1b2/pat': 'placeholder-pat-é',
}

let dir: string
let logged: MoveCode[]
let counts: number[]
let consoleSpies: ReturnType<typeof vi.spyOn>[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-move-dpapi-'))
  logged = []
  counts = []
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})

afterEach(() => {
  // No secret value and no key name reaches a log line, ours or anything the move calls into.
  const everything = JSON.stringify([logged, counts, ...consoleSpies.map((s) => s.mock.calls)])
  for (const [key, value] of Object.entries(SECRETS)) {
    expect(everything).not.toContain(key)
    expect(everything).not.toContain(key.split('/')[0])
    expect(everything).not.toContain(value)
  }
  for (const s of consoleSpies) s.mockRestore()
})

const configFile = () => join(dir, 'fremkit.json')
const plainFile = () => join(dir, 'secrets.json')

async function seed(backend: Config['secrets']['backend'], secrets: Record<string, string> = SECRETS): Promise<ConfigStore> {
  const config = ConfigSchema.parse({
    version: 4,
    screens: [{ id: 'edge', name: 'Xeneon Edge', kind: 'edge', pages: [{ id: 'home', name: 'Home' }] }],
    secrets: { backend },
  })
  await writeFile(configFile(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  const file = new FileSecretStore(plainFile())
  for (const [k, v] of Object.entries(secrets)) await file.set(k, v)
  const store = new ConfigStore(configFile(), { history: new ConfigHistory(join(dir, 'history')) })
  await store.load()
  return store
}

function deps(store: MoveToDpapiDeps['store'], host: DpapiHost, over: Partial<MoveToDpapiDeps> = {}): MoveToDpapiDeps {
  return {
    platform: 'win32',
    demo: false,
    dataDir: dir,
    configFile: configFile(),
    store,
    dpapi: () => new DpapiSecretStore(dir, { host }),
    log: (code, count) => {
      logged.push(code)
      if (count !== undefined) counts.push(count)
    },
    ...over,
  }
}

const exists = (path: string) => access(path).then(() => true, () => false)
const savedBackend = async () => (JSON.parse(await readFile(configFile(), 'utf8')) as Config).secrets.backend
const dpapiRead = (host: DpapiHost) => new DpapiSecretStore(dir, { host })

describe('moveFileSecretsToDpapi', () => {
  it('moves every secret to DPAPI, switches the config with its own history entry, then removes secrets.json', async () => {
    const store = await seed('file')
    await writeFile(`${plainFile()}.tmp`, '{"gh-x1z9/token":"stale"}', { mode: 0o600 })
    const host = new FakeHost()

    expect(await moveFileSecretsToDpapi(deps(store, host))).toBe('moved')

    expect(logged).toEqual(['moved'])
    const read = dpapiRead(new FakeHost())
    for (const [k, v] of Object.entries(SECRETS)) expect(await read.get(k)).toBe(v)
    expect(store.get().secrets.backend).toBe('dpapi')
    expect(await savedBackend()).toBe('dpapi')
    expect(await exists(plainFile())).toBe(false)
    expect(await exists(`${plainFile()}.tmp`)).toBe(false)
    // Data-folder modes: the DPAPI files are owner-only, and the config the store wrote too.
    await expectMode(join(dir, 'secrets.key'), 0o600)
    await expectMode(join(dir, 'secrets.dpapi.json'), 0o600)
    await expectMode(configFile(), 0o600)
    // The history keeps the version before, still on `file`, under an entry of its own.
    const history = store.history!
    const entries = await history.list()
    expect(entries[0].kind).toBe('secrets-moved')
    expect((await history.read(entries[1].id))!.config.secrets.backend).toBe('file')

    // Idempotent: a second start has nothing left to do.
    logged = []
    expect(await moveFileSecretsToDpapi(deps(store, host))).toBe('nothing')
    expect(logged).toEqual([])
  })

  it('moves a config with no secrets.json at all without asking DPAPI', async () => {
    const store = await seed('file', {})
    const host = new FakeHost()
    expect(await moveFileSecretsToDpapi(deps(store, host))).toBe('moved')
    expect(await savedBackend()).toBe('dpapi')
    expect(host.calls).toBe(0)
  })

  it('leaves everything as it was when a secret does not read back the same', async () => {
    const store = await seed('file')
    const plainBefore = await readFile(plainFile(), 'utf8')
    const configBefore = await readFile(configFile(), 'utf8')
    // The writer's key wraps under one mask and unwraps under another: the read-back store opens
    // a different key, so no value authenticates.
    const host = new FakeHost(0x5a, 0x33)

    expect(await moveFileSecretsToDpapi(deps(store, host))).toBe('failed')

    expect(logged).toEqual(['mismatch'])
    expect(await readFile(plainFile(), 'utf8')).toBe(plainBefore)
    expect(await readFile(configFile(), 'utf8')).toBe(configBefore)
    expect(store.get().secrets.backend).toBe('file')
    expect((await store.history!.list()).some((e) => e.kind === 'secrets-moved')).toBe(false)
  })

  it('leaves everything as it was when DPAPI refuses, and logs only the kind', async () => {
    const store = await seed('file')
    const plainBefore = await readFile(plainFile(), 'utf8')
    const host = new FakeHost()
    host.failProtect = 'timeout'
    expect(await moveFileSecretsToDpapi(deps(store, host))).toBe('failed')
    expect(logged).toEqual(['dpapi-failed'])
    expect(await readFile(plainFile(), 'utf8')).toBe(plainBefore)
    expect(await savedBackend()).toBe('file')
  })

  it('keeps a secrets.json that is not a JSON object', async () => {
    const store = await seed('file', {})
    await writeFile(plainFile(), '["gh-x1z9/token"]', { mode: 0o600 })
    expect(await moveFileSecretsToDpapi(deps(store, new FakeHost()))).toBe('failed')
    expect(logged).toEqual(['file-unreadable'])
    expect(await exists(plainFile())).toBe(true)
    expect(await savedBackend()).toBe('file')
  })

  it('redoes a move interrupted between the DPAPI writes and the switch, without loss or a stale copy', async () => {
    const store = await seed('file')
    const host = new FakeHost()
    // The crash: every secret is in DPAPI, the config never switched.
    const crashing = {
      get degraded() { return store.degraded },
      get: () => store.get(),
      save: () => Promise.reject(new Error('crash')),
    }
    expect(await moveFileSecretsToDpapi(deps(crashing, host))).toBe('failed')
    expect(logged).toEqual(['config-save'])
    expect(await savedBackend()).toBe('file')
    expect(await exists(plainFile())).toBe(true)

    // Before the next start the user, still on the file store, deletes one secret and changes one.
    const file = new FileSecretStore(plainFile())
    await file.delete('ado-a1b2/pat')
    await file.set('gh-x1z9/token', 'placeholder-token-2')

    logged = []
    expect(await moveFileSecretsToDpapi(deps(store, host))).toBe('moved')
    expect(logged).toEqual(['moved'])
    const read = dpapiRead(new FakeHost())
    expect(await read.get('gh-x1z9/token')).toBe('placeholder-token-2')
    // The copy the first attempt wrote for the deleted secret does not come back.
    expect(await read.keys()).toEqual(['gh-x1z9/token'])
    expect(await savedBackend()).toBe('dpapi')
    expect(await exists(plainFile())).toBe(false)
  })

  it('removes a secrets.json left behind a completed switch when DPAPI holds the same values', async () => {
    const store = await seed('file')
    const left = await readFile(plainFile(), 'utf8')
    expect(await moveFileSecretsToDpapi(deps(store, new FakeHost()))).toBe('moved')
    // The crash between the switch and the removal.
    await writeFile(plainFile(), left, { mode: 0o600 })

    logged = []
    expect(await moveFileSecretsToDpapi(deps(store, new FakeHost()))).toBe('leftover-removed')
    expect(logged).toEqual(['leftover-removed'])
    expect(await exists(plainFile())).toBe(false)
  })

  it('keeps a leftover secrets.json whose values differ from DPAPI', async () => {
    const store = await seed('file')
    expect(await moveFileSecretsToDpapi(deps(store, new FakeHost()))).toBe('moved')
    const differing = { ...SECRETS, 'gh-x1z9/token': 'placeholder-token-other' }
    await writeFile(plainFile(), JSON.stringify(differing), { mode: 0o600 })

    logged = []
    expect(await moveFileSecretsToDpapi(deps(store, new FakeHost()))).toBe('leftover-kept')
    expect(logged).toEqual(['leftover-differs'])
    expect(JSON.parse(await readFile(plainFile(), 'utf8'))).toEqual(differing)
    // DPAPI keeps what it had: the leftover is never read into it.
    expect(await dpapiRead(new FakeHost()).get('gh-x1z9/token')).toBe(SECRETS['gh-x1z9/token'])
  })

  it('never runs on darwin, in a demo or on a degraded config store', async () => {
    for (const over of [{ platform: 'darwin' }, { demo: true }] as Partial<MoveToDpapiDeps>[]) {
      const store = await seed('file')
      const plainBefore = await readFile(plainFile(), 'utf8')
      const configBefore = await readFile(configFile(), 'utf8')
      const host = new FakeHost()
      expect(await moveFileSecretsToDpapi(deps(store, host, over))).toBe('skipped')
      expect(host.calls).toBe(0)
      expect(await readFile(plainFile(), 'utf8')).toBe(plainBefore)
      expect(await readFile(configFile(), 'utf8')).toBe(configBefore)
      expect(await exists(join(dir, 'secrets.dpapi.json'))).toBe(false)
    }
    const store = await seed('file')
    const degraded = { degraded: true, get: () => store.get(), save: () => Promise.reject(new Error('degraded')) }
    expect(await moveFileSecretsToDpapi(deps(degraded, new FakeHost()))).toBe('skipped')
    expect(logged).toEqual([])
  })
  it('moves what the file store can read and leaves out, counted, what no store can', async () => {
    const store = await seed('file')
    const all = JSON.parse(await readFile(plainFile(), 'utf8')) as Record<string, unknown>
    // A name `assertSecretKey` refuses and a value that is not text: nothing ever reads either.
    await writeFile(plainFile(), JSON.stringify({ ...all, 'not a key': 'x', 'gh-x1z9/number': 42 }), { mode: 0o600 })

    expect(await moveFileSecretsToDpapi(deps(store, new FakeHost()))).toBe('moved')

    expect(logged).toEqual(['entries-skipped', 'moved'])
    expect(counts).toEqual([2])
    const read = dpapiRead(new FakeHost())
    expect((await read.keys()).sort()).toEqual(Object.keys(SECRETS).sort())
    for (const [k, v] of Object.entries(SECRETS)) expect(await read.get(k)).toBe(v)
    expect(await exists(plainFile())).toBe(false)
  })

  it('puts the config back in memory when its save does not reach the disk', async () => {
    const store = await seed('file')
    const plainBefore = await readFile(plainFile(), 'utf8')
    // The store writes `fremkit.json.tmp` and renames it: a folder there makes the write fail.
    await mkdir(`${configFile()}.tmp`)

    expect(await moveFileSecretsToDpapi(deps(store, new FakeHost()))).toBe('failed')

    expect(logged).toEqual(['config-save'])
    expect(store.get().secrets.backend).toBe('file')
    expect(await savedBackend()).toBe('file')
    expect(await readFile(plainFile(), 'utf8')).toBe(plainBefore)
    // The next ordinary save, once the disk takes it again, writes what this run uses.
    await rmdir(`${configFile()}.tmp`)
    await store.save(store.get())
    expect(await savedBackend()).toBe('file')
  })

  it('flushes the DPAPI files and the config to disk before removing secrets.json', async () => {
    const store = await seed('file')
    const events: string[] = []
    const io = recordingIo(events)
    const host = new FakeHost()
    const d = deps(store, host, { io, dpapi: () => new DpapiSecretStore(dir, { host, io }) })

    expect(await moveFileSecretsToDpapi(d)).toBe('moved')

    const at = (event: string) => {
      const i = events.lastIndexOf(event)
      expect(i, event).toBeGreaterThanOrEqual(0)
      return i
    }
    const name = (file: string) => join(dir, file)
    // Each DPAPI file: written, flushed, then renamed, then its folder flushed.
    for (const file of ['secrets.key', 'secrets.dpapi.json']) {
      expect(at(`sync ${name(file)}.tmp`)).toBeLessThan(at(`rename ${name(file)}.tmp`))
    }
    expect(at(`rename ${name('secrets.dpapi.json')}.tmp`)).toBeLessThan(events.lastIndexOf(`sync ${dir}`))
    // The config flushed, then its folder, then the plaintext removed.
    const unlinked = at(`unlink ${plainFile()}`)
    expect(at(`sync ${configFile()}`)).toBeLessThan(unlinked)
    expect(events.lastIndexOf(`sync ${dir}`)).toBeLessThan(unlinked)
    expect(at(`sync ${configFile()}`)).toBeLessThan(events.lastIndexOf(`sync ${dir}`))
  })

  it('keeps secrets.json when the saved config cannot be flushed, and removes it at the next start', async () => {
    const store = await seed('file')
    const failing: DurableIo = {
      ...nodeIo,
      open: (path, flags, mode) => path === configFile() && flags === 'r+'
        ? Promise.reject(Object.assign(new Error('io'), { code: 'EIO' }))
        : nodeIo.open(path, flags, mode),
    }
    expect(await moveFileSecretsToDpapi(deps(store, new FakeHost(), { io: failing }))).toBe('moved')
    expect(logged).toEqual(['config-sync'])
    expect(await exists(plainFile())).toBe(true)

    logged = []
    expect(await moveFileSecretsToDpapi(deps(store, new FakeHost()))).toBe('leftover-removed')
    expect(await exists(plainFile())).toBe(false)
  })
})

describe('syncDir', () => {
  it('passes over the EPERM or EISDIR Windows answers for a folder, and nothing else', async () => {
    const refusing = (code: string): DurableIo => ({ ...nodeIo, open: () => Promise.reject(Object.assign(new Error(code), { code })) })
    await expect(syncDir(refusing('EPERM'), dir)).resolves.toBeUndefined()
    await expect(syncDir(refusing('EISDIR'), dir)).resolves.toBeUndefined()
    await expect(syncDir(refusing('EIO'), dir)).rejects.toThrow('EIO')
  })
})

/** The node calls, each one noted as `<call> <path>`, a handle's flush as `sync <path>`. */
function recordingIo(events: string[]): DurableIo {
  return {
    mkdir: (path, opts) => nodeIo.mkdir(path, opts),
    chmod: (path, mode) => nodeIo.chmod(path, mode),
    rename: async (from, to) => {
      events.push(`rename ${from}`)
      await nodeIo.rename(from, to)
    },
    unlink: async (path) => {
      events.push(`unlink ${path}`)
      await nodeIo.unlink(path)
    },
    open: async (path, flags, mode) => {
      const handle = await nodeIo.open(path, flags, mode)
      const recorded: DurableHandle = {
        writeFile: (data, encoding) => handle.writeFile(data, encoding),
        sync: async () => {
          events.push(`sync ${path}`)
          await handle.sync()
        },
        close: () => handle.close(),
      }
      return recorded
    },
  }
}
