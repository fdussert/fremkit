import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as realSpawn, type SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import { tr } from '../src/i18n.js'
import { createServersProvider, type ServersSnapshot } from '../src/companion/servers/provider.js'
import { KILL_GRACE_MS } from '../src/companion/servers/commands.js'
import {
  busyPorts, cleanLogLine, createManagedServers, cutBack, LOG_CUT_BYTES, LOG_KEEP_BYTES, LOG_RETAIN_MS, managedState,
  readLogTail, START_TIMEOUT_MS, type SpawnFn,
} from '../src/companion/servers/managed.js'
import { parsePs } from '../src/companion/servers/list.js'
import type { ServersSystem } from '../src/companion/servers/system.js'
import type { CommandContext } from '../src/providers/types.js'

const HOME = '/Users/tester'
const UID = 501
const SELF = 900
const START = 'Wed Oct 22 09:01:02 2026'
const CHILD_START = 'Wed Oct 22 11:00:00 2026'
const LOCAL: CommandContext = { loopback: true, paired: false }
const SENTINEL = 's3cr3t'
const ENV = { PATH: '/usr/bin:/bin', SECRET_TOKEN: SENTINEL }
const ARGV = ['node', '/opt/homebrew/bin/pnpm', 'dev', '--title', 'my app']

function on(): Config {
  return { ...DEFAULT_CONFIG, labs: { ...DEFAULT_CONFIG.labs, fremdev: true } } as Config
}
const msg = (key: Parameters<typeof tr>[1]) => tr(on().locale, key)
const mode = (path: string) => statSync(path).mode & 0o777

let dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'fremkit-managed-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('managed server logs', () => {
  it('cleans a line: ANSI colours, the home folder, URL credentials and secrets, 300 characters', () => {
    expect(cleanLogLine('\x1b[32m✓\x1b[39m ready in \x1b[1m312\x1b[22m ms', HOME)).toBe('✓ ready in 312 ms')
    expect(cleanLogLine(`watching ${HOME}/code/shop/src`, HOME)).toBe('watching ~/code/shop/src')
    expect(cleanLogLine('DATABASE_URL=postgres://app:hunter2@db.example.com/app', HOME)).toBe('DATABASE_URL=postgres://app:•••@db.example.com/app')
    expect(cleanLogLine(`SECRET_TOKEN=${SENTINEL} PORT=3000`, HOME)).toBe('SECRET_TOKEN=••• PORT=3000')
    expect(cleanLogLine(`Authorization: Bearer ${SENTINEL}`, HOME)).not.toContain(SENTINEL)
    expect(cleanLogLine('x'.repeat(500), HOME)).toHaveLength(300)
    // Masked before the cut: a credential is never left half-shown at the edge.
    expect(cleanLogLine('x'.repeat(280) + ' postgres://app:hunter2hunter2@db.example.com', HOME)).not.toContain('hunter2')
  })

  it('reads the last 20 lines', async () => {
    const log = join(tmp(), 'a.log')
    writeFileSync(log, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const tail = await readLogTail(log, HOME)
    expect(tail).toHaveLength(20)
    expect(tail[0]).toBe('line 30')
    expect(tail[19]).toBe('line 49')
    expect(await readLogTail(join(tmp(), 'missing.log'), HOME)).toEqual([])
  })

  it('cuts a log past 1 MB back to its last 512 KB', async () => {
    const log = join(tmp(), 'big.log')
    const body = Buffer.alloc(LOG_CUT_BYTES + 4096)
    for (let i = 0; i < body.length; i++) body[i] = 97 + (i % 26)
    writeFileSync(log, body)
    expect(await cutBack(log)).toBe(true)
    const after = readFileSync(log)
    expect(after.length).toBe(LOG_KEEP_BYTES)
    expect(after.equals(body.subarray(body.length - LOG_KEEP_BYTES))).toBe(true)
    // Under the limit: untouched.
    writeFileSync(log, 'small\n')
    expect(await cutBack(log)).toBe(false)
    expect(readFileSync(log, 'utf8')).toBe('small\n')
  })

  it('names the busy ports from addresses and `port N`, never from a timestamp', () => {
    const entry = { pid: 2000, start: CHILD_START, log: '/x.log', ports: [5173], startedAt: 0 }
    expect(busyPorts(entry, ['10:42:01 Error: listen EADDRINUSE: address already in use :::3000']).sort()).toEqual([3000, 5173])
    expect(busyPorts(entry, ['[10:42:01] EADDRINUSE 127.0.0.1:8080']).sort()).toEqual([5173, 8080])
    expect(busyPorts(entry, ['2026-10-22 10:42:01 port 4000 is already in use']).sort()).toEqual([4000, 5173])
    expect(busyPorts(entry, ['EADDRINUSE localhost:4001 PORT=4002']).sort()).toEqual([4001, 4002, 5173])
    expect(busyPorts(entry, ['10:42:01 ready'])).toEqual([5173])
  })

  it('decides the state: listening is up, a port in use or a death is failed, a clean exit leaves', () => {
    const base = { alive: true, listening: false, tail: [] as string[], startedAt: 0, now: 1_000, exitCode: undefined as number | null | undefined }
    expect(managedState({ ...base, listening: true })).toBe('up')
    // Vite says it and moves to the next port: it listens, so it is up.
    expect(managedState({ ...base, listening: true, tail: ['Port 5173 is in use, trying another one...'] })).toBe('up')
    expect(managedState(base)).toBe('starting')
    expect(managedState({ ...base, now: START_TIMEOUT_MS + 1 })).toBe('failed')
    expect(managedState({ ...base, tail: ['Error: listen EADDRINUSE: address already in use :::5173'] })).toBe('failed')
    expect(managedState({ ...base, tail: ['port 3000 is already in use'] })).toBe('failed')
    expect(managedState({ ...base, alive: false, exitCode: 1 })).toBe('failed')
    expect(managedState({ ...base, alive: false, exitCode: undefined })).toBe('failed')
    expect(managedState({ ...base, alive: false, exitCode: null })).toBe('failed')
    expect(managedState({ ...base, alive: false, exitCode: 0 })).toBe('drop')
  })
})

/** A child `spawn` hands back, that never runs anything. */
function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void }
  child.pid = pid
  child.unref = vi.fn()
  return child
}

describe('managed server spawn', () => {
  let savedMask = 0
  beforeEach(() => { savedMask = process.umask(0o077) })
  afterEach(() => { process.umask(savedMask) })

  it('spawns the exe with the exact argv, the folder and the environment read, detached, no shell, umask 022 for the child only', async () => {
    const dataDir = tmp()
    const calls: Array<{ file: string; args: string[]; options: SpawnOptions; mask: number }> = []
    const spawn: SpawnFn = (file, args, options) => {
      const mask = process.umask(0o022); process.umask(mask)
      calls.push({ file, args, options, mask })
      return fakeChild(2000)
    }
    const managed = createManagedServers({ dataDir, home: HOME, spawn })
    const logs: string[] = []
    for (const k of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')) })
    const entry = await managed.start({ exe: '/opt/homebrew/bin/node', argv: ARGV, cwd: '/tmp/shop', env: { ...ENV }, ports: [5173] }, async () => CHILD_START)
    vi.restoreAllMocks()

    expect(calls).toHaveLength(1)
    const c = calls[0]
    expect(c.file).toBe('/opt/homebrew/bin/node')
    expect(c.args).toEqual(['/opt/homebrew/bin/pnpm', 'dev', '--title', 'my app'])
    // argv[0] replayed as it was, so the command reads the same as the original.
    expect(c.options.argv0).toBe('node')
    expect(c.options.cwd).toBe('/tmp/shop')
    expect(c.options.env).toEqual(ENV)
    expect(c.options.detached).toBe(true)
    expect(c.options.shell ?? false).toBe(false)
    expect((c.options.stdio as unknown[])[0]).toBe('ignore')
    expect(typeof (c.options.stdio as unknown[])[1]).toBe('number')
    expect((c.options.stdio as unknown[])[2]).toBe((c.options.stdio as unknown[])[1])
    expect(c.mask).toBe(0o022)
    const after = process.umask(0o077)
    expect(after).toBe(0o077)
    expect(c.args.join(' ')).not.toContain(SENTINEL)

    expect(entry).toMatchObject({ pid: 2000, start: CHILD_START, ports: [5173] })
    const dir = join(dataDir, 'servers')
    expect(mode(dir)).toBe(0o700)
    expect(mode(entry.log)).toBe(0o600)
    expect(entry.log.startsWith(dir + '/')).toBe(true)
    const file = join(dir, 'managed.json')
    expect(mode(file)).toBe(0o600)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    expect(saved).toHaveLength(1)
    expect(Object.keys(saved[0]).sort()).toEqual(['log', 'pid', 'ports', 'start', 'startedAt'])
    expect(readFileSync(file, 'utf8')).not.toContain(SENTINEL)
    expect(readFileSync(file, 'utf8')).not.toContain('pnpm')
    expect(logs.join('\n')).not.toContain(SENTINEL)
  })

  it('saves one after another, and a failed save after a good spawn keeps the server and writes it later', async () => {
    const dataDir = tmp()
    let next = 3000
    const managed = createManagedServers({ dataDir, home: HOME, spawn: () => fakeChild(next++) })
    const launch = { exe: '/bin/x', argv: ['x'], cwd: '/tmp', env: {}, ports: [1] }
    await Promise.all([managed.start(launch, async () => CHILD_START), managed.start(launch, async () => CHILD_START), managed.start(launch, async () => CHILD_START)])
    const file = join(dataDir, 'servers', 'managed.json')
    const pids = () => (JSON.parse(readFileSync(file, 'utf8')) as Array<{ pid: number }>).map((e) => e.pid).sort()
    expect(pids()).toEqual([3000, 3001, 3002])

    // managed.json cannot be replaced (a folder sits there): the spawn still counts.
    rmSync(file)
    mkdirSync(join(file, 'blocker'), { recursive: true })
    const entry = await managed.start(launch, async () => CHILD_START)
    expect(managed.list()).toContain(entry)
    rmSync(file, { recursive: true })
    const stats = parsePs([3000, 3001, 3002, 3003].map((pid) => `${pid} ${SELF} ${pid} ${UID} ${CHILD_START} 01:00 0.0 1000 /bin/x`).join('\n') + '\n', '')
    await managed.reconcile(stats)
    expect(pids()).toEqual([3000, 3001, 3002, 3003])
    expect(readdirSync(join(dataDir, 'servers')).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('reads the start time again when it was missed, and stops a child it can never identify', async () => {
    const dataDir = tmp()
    const kill = vi.fn()
    let next = 4000
    const managed = createManagedServers({ dataDir, home: HOME, spawn: () => fakeChild(next++), selfPid: SELF, kill })
    const launch = { exe: '/bin/x', argv: ['x'], cwd: '/tmp', env: {}, ports: [1] }
    const found = await managed.start(launch, async () => null)
    const lost = await managed.start(launch, async () => { throw new Error('ps') })
    expect(found.start).toBe('')
    // ps shows 4000 as Fremkit's child now; 4001 not at all.
    await managed.reconcile(parsePs(`4000 ${SELF} 4000 ${UID} ${CHILD_START} 01:00 0.0 1000 /bin/x\n`, ''))
    expect(found.start).toBe(CHILD_START)
    const saved = JSON.parse(readFileSync(join(dataDir, 'servers', 'managed.json'), 'utf8')) as Array<{ pid: number; start: string }>
    expect(saved.find((e) => e.pid === 4000)!.start).toBe(CHILD_START)
    expect(kill.mock.calls).toEqual([[-4001, 'SIGKILL'], [4001, 'SIGKILL']])
    expect(managed.list().map((e) => e.pid)).toContain(4001)
    expect(managedState({ alive: false, listening: false, tail: [], startedAt: lost.startedAt, now: Date.now(), exitCode: managed.exitCode(lost) })).toBe('failed')
    // Never a second time, and never a pid that is not Fremkit's child.
    await managed.reconcile(parsePs(`4001 1 4001 ${UID} ${CHILD_START} 01:00 0.0 1000 /bin/x\n`, ''))
    expect(kill).toHaveBeenCalledTimes(2)
    expect(lost.start).toBe('')
  })

  it('puts the umask back even when spawn throws', async () => {
    const managed = createManagedServers({ dataDir: tmp(), home: HOME, spawn: () => { throw new Error('nope') } })
    await expect(managed.start({ exe: '/bin/x', argv: ['x'], cwd: '/tmp', env: {}, ports: [1] }, async () => null)).rejects.toThrow()
    expect(process.umask(0o077)).toBe(0o077)
  })

  it('sees a real child that exits 1 as failed', async () => {
    const dataDir = tmp()
    const cwd = tmp()
    const managed = createManagedServers({ dataDir, home: HOME, spawn: realSpawn as unknown as SpawnFn })
    const entry = await managed.start({ exe: process.execPath, argv: ['node', '-e', 'console.log("boom"); process.exit(1)'], cwd, env: { PATH: '/usr/bin:/bin' }, ports: [18191] }, async () => CHILD_START)
    for (let i = 0; i < 100 && managed.exitCode(entry) === undefined; i++) await new Promise((r) => setTimeout(r, 20))
    expect(managed.exitCode(entry)).toBe(1)
    const tail = await readLogTail(entry.log, HOME)
    expect(tail).toEqual(['boom'])
    expect(managedState({ alive: false, listening: false, tail, startedAt: entry.startedAt, now: Date.now(), exitCode: managed.exitCode(entry) })).toBe('failed')
  })

  it('reloads managed.json: drops the processes that are gone, keeps the living, deletes old logs a day later', async () => {
    const dataDir = tmp()
    let t = 200 * LOG_RETAIN_MS
    const first = createManagedServers({ dataDir, home: HOME, spawn: (_f, _a, _o) => fakeChild(2000), now: () => t })
    const alive = await first.start({ exe: '/bin/x', argv: ['x'], cwd: '/tmp', env: {}, ports: [5173] }, async () => CHILD_START)
    const second = createManagedServers({ dataDir, home: HOME, spawn: (_f, _a, _o) => fakeChild(2001), now: () => t })
    const gone = await second.start({ exe: '/bin/x', argv: ['x'], cwd: '/tmp', env: {}, ports: [3000] }, async () => CHILD_START)
    expect(gone.log).not.toBe(alive.log)

    // Fremkit restarts: 2000 still runs (now under launchd), 2001 is gone.
    const stats = parsePs(`2000 1 2000 ${UID} ${CHILD_START} 01:00 0.0 1000 /bin/x\n`, '')
    const reloaded = createManagedServers({ dataDir, home: HOME, now: () => t })
    await reloaded.ready()
    await reloaded.reconcile(stats)
    expect(reloaded.list().map((e) => e.pid)).toEqual([2000])
    expect(reloaded.list()[0].log).toBe(alive.log)
    const saved = JSON.parse(readFileSync(join(dataDir, 'servers', 'managed.json'), 'utf8')) as Array<{ pid: number }>
    expect(saved.map((e) => e.pid)).toEqual([2000])

    // The gone one's log stays a day, then goes; a referenced log never does.
    await reloaded.maintain()
    expect(existsSync(gone.log)).toBe(true)
    const old = (t - LOG_RETAIN_MS - 60_000) / 1000
    utimesSync(gone.log, old, old)
    utimesSync(alive.log, old, old)
    t += 120_000
    await reloaded.maintain()
    expect(existsSync(gone.log)).toBe(false)
    expect(existsSync(alive.log)).toBe(true)
    expect(readdirSync(join(dataDir, 'servers')).sort()).toEqual([alive.log.split('/').pop(), 'managed.json'].sort())
  })
})

type Proc = { pid: number; ppid?: number; pgid?: number; uid?: number; start?: string; comm: string; args?: string; cwd?: string | null; ports?: number[] }

const SHELL: Proc = { pid: 1000, comm: '/bin/zsh', args: '-zsh' }
const PNPM: Proc = { pid: 1001, ppid: 1000, comm: '/opt/homebrew/bin/node', args: 'node /opt/homebrew/bin/pnpm dev', cwd: `${HOME}/code/shop` }
const VITE: Proc = { pid: 1002, ppid: 1001, pgid: 1001, comm: '/opt/homebrew/bin/node', args: `node ${HOME}/code/shop/node_modules/.bin/vite --port 5173`, cwd: `${HOME}/code/shop/web`, ports: [5173] }
const FREMKIT: Proc = { pid: SELF, ppid: 800, pgid: 800, comm: '/opt/homebrew/bin/node', args: 'node tsx src/index.ts' }
const API: Proc = { pid: 1700, ppid: 1, comm: '/opt/homebrew/bin/node', args: 'node server.js', cwd: `${HOME}/code/api`, ports: [3000] }
const viteId = `1002:${START}`
/** What the restart spawns: pnpm again (Fremkit's child, its own group), and the vite under it once it listens. */
const NEW_PNPM: Proc = { pid: 2000, ppid: SELF, pgid: 2000, start: CHILD_START, comm: '/opt/homebrew/bin/node', args: 'node /opt/homebrew/bin/pnpm dev --title my app', cwd: `${HOME}/code/shop` }
const NEW_VITE: Proc = { pid: 2001, ppid: 2000, pgid: 2000, start: CHILD_START, comm: '/opt/homebrew/bin/node', args: `node ${HOME}/code/shop/node_modules/.bin/vite --port 5173`, cwd: `${HOME}/code/shop/web`, ports: [5173] }

function world(initial: Proc[], o: { dataDir: string; scanner?: string | null; procargs?: string; spawned?: Proc[]; t?: { now: number }; takePort?: boolean }) {
  let procs = [...initial]
  const signals: Array<[number, string]> = []
  const spawns: Array<{ file: string; args: string[]; options: SpawnOptions }> = []
  const line = (p: Proc) => `${p.pid} ${p.ppid ?? 1} ${p.pgid ?? p.pid} ${p.uid ?? UID} ${p.start ?? START} 01:02:03 1.5 120000 ${p.comm}`
  const sys: ServersSystem = {
    uid: UID,
    home: HOME,
    runLsofListen: async () => procs.filter((p) => p.ports?.length).map((p) => [`p${p.pid}`, `c${p.comm.split('/').pop()}`, `u${p.uid ?? UID}`, ...p.ports!.map((n) => `n*:${n}`)].join('\n')).join('\n') + '\n',
    runPsStats: async () => [{ pid: 1, ppid: 0, comm: '/sbin/launchd', uid: 0 } as Proc, ...(procs.some((p) => p.pid === SELF) ? [] : [FREMKIT]), ...procs].map(line).join('\n') + '\n',
    runPsArgs: async (pids) => procs.filter((p) => pids.includes(p.pid)).map((p) => `${p.pid} ${p.args ?? p.comm}`).join('\n') + '\n',
    runLsofCwd: async (pids) => procs.filter((p) => pids.includes(p.pid) && p.cwd).map((p) => `p${p.pid}\nfcwd\nn${p.cwd}`).join('\n') + '\n',
    runDockerPorts: async () => '',
    readPackageName: async () => null,
    kill: vi.fn((pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal])
      procs = procs.filter((p) => (pid < 0 ? (p.pgid ?? p.pid) !== -pid : p.pid !== pid))
      // Something else picks the port up the moment it is let go.
      if (o.takePort && !procs.some((p) => p.pid === 1800)) procs.push({ ...API, pid: 1800, ports: [5173] })
    }),
    runOpen: vi.fn(async () => undefined),
  }
  const runScanner = vi.fn(async (_scanner: string, _args: string[]) => o.procargs ?? JSON.stringify({ type: 'procargs', exe: '/opt/homebrew/bin/node', argv: ARGV, env: ENV }))
  const spawn: SpawnFn = (file, args, options) => {
    spawns.push({ file, args, options })
    procs.push(...(o.spawned ?? [NEW_PNPM]))
    return fakeChild((o.spawned ?? [NEW_PNPM])[0].pid)
  }
  const make = () => createServersProvider({
    config: on,
    dataDir: o.dataDir,
    scanner: o.scanner === undefined ? '/scanner/fremkit-scan' : o.scanner,
    tabLights: () => new Map(),
    system: sys,
    selfPid: SELF,
    runScanner,
    spawn,
    now: o.t ? () => o.t!.now : undefined,
  })
  let provider = make()
  return {
    sys, signals, spawns, runScanner,
    get provider() { return provider },
    set: (next: Proc[]) => { procs = next },
    get: () => procs,
    /** Fremkit restarts: a new provider over the same data folder. */
    restartFremkit: () => { provider = make() },
    poll: async () => (await provider.poll!()) as ServersSnapshot,
    run: (name: string, id: string) => provider.commands![name]({ instanceId: 'w1', id }, LOCAL) as Promise<{ ok: boolean; error?: string }>,
  }
}

/** Runs a restart through its kill grace and port wait (fake timers), then lets the file writes finish. */
async function restart(w: ReturnType<typeof world>, id: string) {
  const p = w.run('restart', id)
  await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 6_000)
  return p
}

describe('companion:servers restart', () => {
  let savedMask = 0
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); savedMask = process.umask(0o077) })
  afterEach(() => { vi.useRealTimers(); process.umask(savedMask); vi.restoreAllMocks() })

  it('replays the launch root: procargs of pnpm, its own folder, kill, then spawn; the environment goes nowhere else', async () => {
    const dataDir = tmp()
    const w = world([SHELL, PNPM, VITE], { dataDir })
    await w.poll()
    const logs: string[] = []
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')) })
    expect(await restart(w, viteId)).toEqual({ ok: true })
    expect(w.runScanner).toHaveBeenCalledWith('/scanner/fremkit-scan', ['procargs', '1001'])
    expect(w.signals[0]).toEqual([-1001, 'SIGTERM'])
    expect(w.spawns).toHaveLength(1)
    const s = w.spawns[0]
    expect(s.file).toBe('/opt/homebrew/bin/node')
    expect(s.args).toEqual(['/opt/homebrew/bin/pnpm', 'dev', '--title', 'my app'])
    // pnpm's folder, not vite's.
    expect(s.options.argv0).toBe('node')
    expect(s.options.cwd).toBe(`${HOME}/code/shop`)
    expect(s.options.env).toEqual(ENV)
    expect(s.options.detached).toBe(true)
    expect(s.options.shell ?? false).toBe(false)

    // Starting: Fremkit's own child is listed all the same, as managed.
    const starting = await w.poll()
    const row = starting.rows.find((r) => r.pid === 2000)!
    expect(row).toMatchObject({ managed: true, state: 'starting', ports: [5173] })

    // It listens, and prints.
    const managedFile = join(dataDir, 'servers', 'managed.json')
    const log = (JSON.parse(readFileSync(managedFile, 'utf8')) as Array<{ log: string }>)[0].log
    appendFileSync(log, `\x1b[32mVITE\x1b[0m ready\nSECRET_TOKEN=${SENTINEL}\n  ➜  Local: http://localhost:5173/\n`)
    w.set([...w.get(), NEW_VITE])
    const up = await w.poll()
    const vite = up.rows.find((r) => r.pid === 2001)!
    expect(vite).toMatchObject({ managed: true, state: 'up', portBusy: false })
    expect(vite.log).toEqual(['VITE ready', 'SECRET_TOKEN=•••', '  ➜  Local: http://localhost:5173/'])
    expect(up.rows.filter((r) => r.managed)).toHaveLength(1)

    for (const text of [JSON.stringify(starting), JSON.stringify(up), readFileSync(managedFile, 'utf8'), logs.join('\n'), JSON.stringify(s.args)]) {
      expect(text).not.toContain(SENTINEL)
    }
  })

  it('kills a managed row through its own process group and forgets it', async () => {
    const dataDir = tmp()
    const w = world([SHELL, PNPM, VITE], { dataDir, spawned: [NEW_PNPM, NEW_VITE] })
    await w.poll()
    expect(await restart(w, viteId)).toEqual({ ok: true })
    const snap = await w.poll()
    const id = snap.rows.find((r) => r.pid === 2001)!.id
    w.signals.length = 0
    const p = w.run('kill', id)
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 100)
    expect(await p).toEqual({ ok: true })
    expect(w.signals[0]).toEqual([-2000, 'SIGTERM'])
    expect((await w.poll()).rows.filter((r) => r.managed)).toEqual([])
  })

  it('still sends KILL to a managed server that ignores TERM, though the kill forgot it', async () => {
    const w = world([SHELL, PNPM, VITE], { dataDir: tmp(), spawned: [NEW_PNPM, NEW_VITE] })
    await w.poll()
    expect(await restart(w, viteId)).toEqual({ ok: true })
    const id = (await w.poll()).rows.find((r) => r.pid === 2001)!.id
    const kill = w.sys.kill as ReturnType<typeof vi.fn>
    kill.mockImplementation((pid: number, signal: NodeJS.Signals) => {
      w.signals.push([pid, signal])
      if (signal === 'SIGKILL') w.set(w.get().filter((p) => (p.pgid ?? p.pid) !== -pid))
    })
    w.signals.length = 0
    const p = w.run('kill', id)
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 100)
    expect(await p).toEqual({ ok: true })
    expect(w.signals).toEqual([[-2000, 'SIGTERM'], [-2000, 'SIGKILL']])
  })

  it('shows a server that died at once as failed, its port’s holder as busy, and never respawns it', async () => {
    const dataDir = tmp()
    const w = world([SHELL, PNPM, VITE], { dataDir })
    await w.poll()
    expect(await restart(w, viteId)).toEqual({ ok: true })
    const log = (JSON.parse(readFileSync(join(dataDir, 'servers', 'managed.json'), 'utf8')) as Array<{ log: string }>)[0].log
    // Someone took 5173 in between; pnpm prints the error and exits.
    appendFileSync(log, 'Error: listen EADDRINUSE: address already in use :::5173\n')
    w.set([SHELL, { ...API, pid: 1800, ports: [5173] }])
    const snap = await w.poll()
    const failed = snap.rows.find((r) => r.managed)!
    expect(failed).toMatchObject({ pid: 2000, state: 'failed', ports: [5173] })
    expect(failed.log).toContain('Error: listen EADDRINUSE: address already in use :::5173')
    expect(snap.rows.find((r) => r.pid === 1800)).toMatchObject({ portBusy: true, managed: false })
    await w.poll()
    expect(w.spawns).toHaveLength(1)
    // Kill on the red row dismisses it.
    expect(await w.run('kill', failed.id)).toEqual({ ok: true })
    expect((await w.poll()).rows.filter((r) => r.managed)).toEqual([])
  })

  it('turns a server that never listens red after 30 s', async () => {
    const t = { now: 1_000_000 }
    const w = world([SHELL, PNPM, VITE], { dataDir: tmp(), t })
    await w.poll()
    expect(await restart(w, viteId)).toEqual({ ok: true })
    expect((await w.poll()).rows.find((r) => r.managed)!.state).toBe('starting')
    t.now += START_TIMEOUT_MS + 1
    expect((await w.poll()).rows.find((r) => r.managed)!.state).toBe('failed')
  })

  it('keeps a managed server as Fremkit’s after Fremkit restarts, with its log', async () => {
    const dataDir = tmp()
    const w = world([SHELL, PNPM, VITE], { dataDir, spawned: [NEW_PNPM, NEW_VITE] })
    await w.poll()
    expect(await restart(w, viteId)).toEqual({ ok: true })
    const log = (JSON.parse(readFileSync(join(dataDir, 'servers', 'managed.json'), 'utf8')) as Array<{ log: string }>)[0].log
    appendFileSync(log, 'ready\n')
    // The old Fremkit is gone: pnpm is now launchd's.
    w.set(w.get().map((p) => (p.pid === 2000 ? { ...p, ppid: 1 } : p)))
    w.restartFremkit()
    const snap = await w.poll()
    expect(snap.rows.find((r) => r.pid === 2001)).toMatchObject({ managed: true, state: 'up', log: ['ready'] })
  })

  it('refuses without the scanner, and the snapshot says so', async () => {
    const w = world([SHELL, PNPM, VITE], { dataDir: tmp(), scanner: null })
    expect((await w.poll()).canRestart).toBe(false)
    expect(await restart(w, viteId)).toEqual({ ok: false, error: msg('companion.serversNoRestart') })
    expect(w.signals).toEqual([])
    expect(w.runScanner).not.toHaveBeenCalled()
    expect(w.spawns).toEqual([])
  })

  it('refuses, killing nothing, when the environment is hidden or procargs fails', async () => {
    for (const procargs of [
      JSON.stringify({ type: 'procargs', exe: '/opt/homebrew/bin/node', argv: ARGV, env: null }),
      '{"type":"error","code":"denied"}',
      'garbage',
    ]) {
      const w = world([SHELL, PNPM, VITE], { dataDir: tmp(), procargs })
      await w.poll()
      const r = await restart(w, viteId)
      expect(r).toEqual({ ok: false, error: msg('companion.serversNoRestart') })
      expect(w.signals).toEqual([])
      expect(w.spawns).toEqual([])
    }
  })

  it('refuses a program that is not a dev server', async () => {
    const other: Proc = { pid: 1900, comm: '/Applications/Some.app/Contents/MacOS/Some', ports: [7000], cwd: '/' }
    const w = world([other], { dataDir: tmp() })
    await w.poll()
    expect(await restart(w, `1900:${START}`)).toEqual({ ok: false, error: msg('companion.serversNotAllowed') })
    expect(w.signals).toEqual([])
    expect(w.runScanner).not.toHaveBeenCalled()
  })

  it('refuses when the port is still taken 5 s after the kill, and spawns nothing', async () => {
    const w = world([SHELL, PNPM, VITE], { dataDir: tmp(), takePort: true })
    await w.poll()
    expect(await restart(w, viteId)).toEqual({ ok: false, error: msg('companion.serversPortBusy') })
    expect(w.spawns).toEqual([])
  })
})
