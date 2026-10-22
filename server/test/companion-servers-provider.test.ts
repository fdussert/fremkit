import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import {
  capSnapshot,
  COMPANION_SERVERS_CHANNEL,
  createServersProvider,
  SERVERS_INTERVAL_MS,
  SERVERS_MAX_BYTES,
  type ServerRow,
  type ServersSnapshot,
} from '../src/companion/servers/provider.js'
import { createServersSystem, type ExecFn, type ServersSystem } from '../src/companion/servers/system.js'
import { devTabLights } from '../src/companion/dev.js'

const HOME = '/Users/tester'
const UID = 501
const SELF = 900
const START = 'Wed Oct 22 09:01:02 2026'

type Proc = { pid: number; ppid?: number; uid?: number; comm: string; args?: string; cwd?: string | null; ports?: number[]; etime?: string }

function on(): Config {
  return { ...DEFAULT_CONFIG, labs: { ...DEFAULT_CONFIG.labs, fremdev: true } } as Config
}

/** A fake system answering from a process table, as lsof and ps would print it. */
function fakeSystem(procs: Proc[], extra: Partial<ServersSystem> = {}) {
  const calls: string[] = []
  const listen = procs.filter((p) => p.ports && p.ports.length > 0)
  const sys: ServersSystem = {
    uid: UID,
    home: HOME,
    runLsofListen: vi.fn(async () => {
      calls.push('lsof')
      return listen.map((p) => [`p${p.pid}`, `c${p.comm.split('/').pop()}`, `u${p.uid ?? UID}`, ...p.ports!.map((n) => `n*:${n}`)].join('\n')).join('\n') + '\n'
    }),
    runPsStats: vi.fn(async () => {
      calls.push('ps-stats')
      return procs.map((p) => `${p.pid} ${p.ppid ?? 1} ${p.pid} ${p.uid ?? UID} ${START} ${p.etime ?? '01:02:03'} 1.5 120000 ${p.comm}`).join('\n') + '\n'
    }),
    runPsArgs: vi.fn(async (pids: number[]) => {
      calls.push('ps-args')
      return procs.filter((p) => pids.includes(p.pid)).map((p) => `${p.pid} ${p.args ?? p.comm}`).join('\n') + '\n'
    }),
    runLsofCwd: vi.fn(async (pids: number[]) => {
      calls.push('cwd')
      return procs.filter((p) => pids.includes(p.pid) && p.cwd).map((p) => `p${p.pid}\nfcwd\nn${p.cwd}`).join('\n') + '\n'
    }),
    runDockerPorts: vi.fn(async () => { calls.push('docker'); return '' }),
    readPackageName: vi.fn(async () => null),
    kill: vi.fn(() => { throw new Error('no signal in a listing test') }),
    runOpen: vi.fn(async () => undefined),
    ...extra,
  }
  return { sys, calls }
}

function provider(procs: Proc[], opts: { extra?: Partial<ServersSystem>; config?: () => Config; tabLights?: Map<number, 'red' | 'orange' | 'green'>; scanner?: string | null; now?: () => number } = {}) {
  const { sys, calls } = fakeSystem(procs, opts.extra)
  const p = createServersProvider({
    config: opts.config ?? on,
    dataDir: '/nonexistent',
    scanner: opts.scanner === undefined ? null : opts.scanner,
    tabLights: () => opts.tabLights ?? new Map(),
    system: sys,
    selfPid: SELF,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { p, sys, calls }
}

const poll = async (p: { poll?: () => Promise<unknown> }) => (await p.poll!()) as ServersSnapshot

const VITE: Proc = { pid: 1001, ppid: 1000, comm: '/opt/homebrew/bin/node', args: `node ${HOME}/code/shop/node_modules/.bin/vite --port 5173`, cwd: `${HOME}/code/shop`, ports: [5173] }

describe('companion:servers provider', () => {
  it('declares its channel and period', () => {
    const { p } = provider([])
    expect(p.channel).toBe(COMPANION_SERVERS_CHANNEL)
    expect(COMPANION_SERVERS_CHANNEL).toBe('companion:servers')
    expect(p.intervalMs).toBe(SERVERS_INTERVAL_MS)
    expect(SERVERS_INTERVAL_MS).toBe(5_000)
  })

  it('runs nothing while Fremdev is off', async () => {
    const off = () => DEFAULT_CONFIG as Config
    const { p, calls } = provider([VITE], { config: off })
    expect(await poll(p)).toEqual({ enabled: false, rows: [], canRestart: false })
    expect(calls).toEqual([])
  })

  it('lists the listeners by port, dropping other accounts, its own tree and the helper', async () => {
    const { p } = provider([
      { pid: 1000, comm: '/bin/zsh', args: '-zsh' },
      VITE,
      { pid: 1100, comm: '/opt/homebrew/bin/node', args: 'node server.js', cwd: `${HOME}/code/api`, ports: [3000] },
      { pid: 1200, uid: 502, comm: '/opt/homebrew/bin/node', args: 'node other.js', ports: [4000] },
      { pid: SELF, comm: '/opt/homebrew/bin/node', args: 'node tsx src/index.ts', ports: [4242] },
      { pid: 901, ppid: SELF, comm: '/opt/homebrew/bin/node', args: 'node child.js', ports: [4243] },
      { pid: 1300, comm: '/Applications/Fremkit Helper.app/Contents/MacOS/FremkitHelper', ports: [4500] },
      { pid: 1400, comm: '/Applications/Spotify.app/Contents/MacOS/Spotify', args: '/Applications/Spotify.app/Contents/MacOS/Spotify --secret-flag x', ports: [57621] },
      { pid: 1500, comm: '/usr/libexec/rapportd', ports: [49152] },
    ])
    const snap = await poll(p)
    expect(snap.enabled).toBe(true)
    expect(snap.rows.map((r) => r.ports[0])).toEqual([3000, 5173, 49152, 57621])
    const vite = snap.rows.find((r) => r.pid === 1001)!
    expect(vite).toMatchObject({
      id: `1001:${START}`, ports: [5173], project: 'shop', tool: 'Vite', uptimeSec: 3723, cpu: 1.5, rssKb: 120000,
      folder: '~/code/shop', command: 'node ~/code/shop/node_modules/.bin/vite --port 5173',
      dev: true, system: false, docker: null, managed: false, state: 'up', portBusy: false, tab: null, log: [],
    })
    const spotify = snap.rows.find((r) => r.pid === 1400)!
    expect(spotify.dev).toBe(false)
    // A non-dev row shows its program's name only.
    expect(spotify.command).toBe('Spotify')
    expect(snap.rows.find((r) => r.pid === 1500)).toMatchObject({ system: true, dev: false })
  })

  it('names the project from package.json, but never reads one under a protected folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-servers-'))
    try {
      await mkdir(join(dir, 'web'))
      await writeFile(join(dir, 'web', 'package.json'), JSON.stringify({ name: '@acme/web' }))
      await mkdir(join(dir, 'bare'))
      const real = createServersSystem(async () => '')
      const readPackageName = vi.fn((folder: string) => real.readPackageName(folder))
      const { p } = provider([
        { pid: 2001, comm: '/opt/homebrew/bin/node', args: 'node a.js', cwd: join(dir, 'web'), ports: [3001] },
        { pid: 2002, comm: '/opt/homebrew/bin/node', args: 'node b.js', cwd: join(dir, 'bare'), ports: [3002] },
        { pid: 2003, comm: '/opt/homebrew/bin/node', args: 'node c.js', cwd: `${HOME}/Documents/secret-app`, ports: [3003] },
        { pid: 2004, comm: '/opt/homebrew/bin/node', args: 'node d.js', cwd: `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/x`, ports: [3004] },
      ], { extra: { readPackageName } })
      const rows = (await poll(p)).rows
      expect(rows.map((r) => r.project)).toEqual(['@acme/web', 'bare', 'secret-app', 'x'])
      expect(readPackageName.mock.calls.map((c) => c[0])).toEqual([join(dir, 'web'), join(dir, 'bare')])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('names a Docker holder after its container, asking Docker only when one is listed', async () => {
    const runDockerPorts = vi.fn(async () => 'web-1\t0.0.0.0:8080->80/tcp, [::]:8080->80/tcp\ndb-1\t5432/tcp\n')
    const { p } = provider([
      { pid: 3001, comm: '/Applications/Docker.app/Contents/MacOS/com.docker.backend', ports: [8080, 9999] },
    ], { extra: { runDockerPorts } })
    const rows = (await poll(p)).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].docker).toBe('web-1')
    expect(runDockerPorts).toHaveBeenCalledTimes(1)

    const none = vi.fn(async () => '')
    const { p: p2 } = provider([VITE], { extra: { runDockerPorts: none } })
    await poll(p2)
    expect(none).not.toHaveBeenCalled()
  })

  it('names only the Docker holder: a dev row beside it, or on a port Docker lists, stays null', async () => {
    const runDockerPorts = vi.fn(async () => 'web-1\t0.0.0.0:8080->80/tcp\napi-1\t0.0.0.0:5173->5173/tcp\n')
    const { p } = provider([VITE, { pid: 3001, comm: '/Applications/Docker.app/Contents/MacOS/com.docker.backend', ports: [8080] }], { extra: { runDockerPorts } })
    const rows = (await poll(p)).rows
    expect(rows.find((r) => r.pid === 1001)!.docker).toBeNull()
    expect(rows.find((r) => r.pid === 3001)!.docker).toBe('web-1')
  })

  it("reuses Docker's names for 30 s while the holders' ports stay the same", async () => {
    let t = 0
    let ports = [8080]
    const runDockerPorts = vi.fn(async () => 'web-1\t0.0.0.0:8080->80/tcp\n')
    const holder = { pid: 3001, comm: '/Applications/Docker.app/Contents/MacOS/com.docker.backend', get ports() { return ports } } as unknown as Proc
    const { p } = provider([holder], { extra: { runDockerPorts }, now: () => t })
    await poll(p)
    t = 29_000
    await poll(p)
    expect(runDockerPorts).toHaveBeenCalledTimes(1)
    ports = [8080, 9090]
    await poll(p)
    expect(runDockerPorts).toHaveBeenCalledTimes(2)
    t = 60_000
    await poll(p)
    expect(runDockerPorts).toHaveBeenCalledTimes(3)
  })

  it('never names a project after the home folder, which is the account name', async () => {
    const readPackageName = vi.fn(async () => null)
    const { p } = provider([{ pid: 4001, comm: '/opt/homebrew/bin/python3', args: 'python3 -m http.server 8000', cwd: HOME, ports: [8000] }], { extra: { readPackageName } })
    const row = (await poll(p)).rows[0]
    expect(row.project).toBe('python3')
    expect(row.folder).toBe('~')
  })

  it('writes the home folder as ~ before any punctuation, and masks secrets in a dev command', async () => {
    const { p } = provider([{
      pid: 5001, comm: '/opt/homebrew/bin/node', cwd: `${HOME}/code/api`, ports: [3000],
      args: `node ${HOME}/code/api/server.js --token abc123 DATABASE_URL=postgres://u:p@db.example.com/x X=${HOME}:/bin --root=(${HOME}),'${HOME}'`,
    }])
    const command = (await poll(p)).rows[0].command
    expect(command).toBe("node ~/code/api/server.js --token ••• DATABASE_URL=postgres://u:•••@db.example.com/x X=~:/bin --root=(~),'~'")
    expect(command).not.toContain('abc123')
    expect(command).not.toContain('tester')
  })

  it('says Docker when the container is not found or docker fails', async () => {
    const { p } = provider([{ pid: 3001, comm: '/usr/local/bin/vpnkit-bridge', ports: [7000] }], { extra: { runDockerPorts: async () => { throw new Error('unavailable') } } })
    expect((await poll(p)).rows[0].docker).toBe('Docker')
  })

  it("lights a row with the Fremdev tab on one of its ports, the worst first", async () => {
    const { p } = provider([VITE, { pid: 1100, comm: '/opt/homebrew/bin/node', args: 'node s.js', ports: [3000, 3001] }], {
      tabLights: new Map([[5173, 'orange'], [3000, 'green'], [3001, 'red']]),
    })
    const rows = (await poll(p)).rows
    expect(rows.find((r) => r.pid === 1001)!.tab).toBe('orange')
    expect(rows.find((r) => r.pid === 1100)!.tab).toBe('red')
  })

  it('says whether a restart is possible: the scanner is there', async () => {
    expect((await poll(provider([], { scanner: '/x/fremkit-scan' }).p)).canRestart).toBe(true)
    expect((await poll(provider([]).p)).canRestart).toBe(false)
  })

  it('asks ps for the command lines of the listeners and their parents only', async () => {
    const { p, sys } = provider([{ pid: 1000, ppid: 999, comm: '/opt/homebrew/bin/pnpm', args: 'pnpm dev' }, { pid: 999, comm: '/bin/zsh' }, VITE, { pid: 5, comm: '/sbin/launchd' }])
    await poll(p)
    expect((sys.runPsArgs as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([1001, 1000, 999])
  })

  it('keeps the last rows with an error when lsof fails', async () => {
    let fail = false
    const base = fakeSystem([VITE]).sys
    const listen = base.runLsofListen
    const p = createServersProvider({
      config: on, dataDir: '/x', scanner: null, tabLights: () => new Map(), selfPid: SELF,
      system: { ...base, runLsofListen: async () => { if (fail) throw new Error('unavailable'); return listen() } },
    })
    expect((await poll(p)).rows).toHaveLength(1)
    fail = true
    const snap = await poll(p)
    expect(snap.error).toBe('unavailable')
    expect(snap.rows).toHaveLength(1)
  })

  it('finds a row by id from the last snapshot', async () => {
    const { p } = provider([VITE])
    await poll(p)
    expect(p.lookup(`1001:${START}`)?.pid).toBe(1001)
    expect(p.lookup('1001:Thu Oct 23 09:01:02 2026')).toBeNull()
  })
})

describe('capSnapshot', () => {
  function row(i: number): ServerRow {
    return {
      id: `${i}:${START}`, pid: i, ports: [3000 + i], project: `p${i}`, tool: 'Vite', uptimeSec: 1, cpu: 0, rssKb: 1,
      folder: '~/x', command: 'node vite', dev: true, system: false, docker: null, managed: true, state: 'up', portBusy: false, tab: null,
      log: Array.from({ length: 20 }, (_, j) => `${j}`.padEnd(300, 'x')),
    }
  }

  it('drops log lines before rows, and keeps at most 40 rows under the cap', () => {
    const snap = capSnapshot({ enabled: true, canRestart: true, rows: Array.from({ length: 60 }, (_, i) => row(i)) })
    expect(Buffer.byteLength(JSON.stringify(snap), 'utf8')).toBeLessThanOrEqual(SERVERS_MAX_BYTES)
    expect(SERVERS_MAX_BYTES).toBe(60_000)
    expect(snap.rows).toHaveLength(40)
    expect(snap.rows.some((r) => r.log.length > 0)).toBe(true)
    expect(snap.rows.some((r) => r.log.length < 20)).toBe(true)
  })

  it('cuts to 40 rows keeping dev and managed ones first, then the lowest ports, sorted by port', () => {
    const other = (i: number): ServerRow => ({ ...row(i), dev: false, managed: false, log: [] })
    const devRow = (i: number): ServerRow => ({ ...row(i), managed: false, log: [] })
    const rows = [...Array.from({ length: 30 }, (_, i) => other(i)), ...Array.from({ length: 30 }, (_, i) => devRow(100 + i))]
    const snap = capSnapshot({ enabled: true, canRestart: true, rows })
    expect(snap.rows).toHaveLength(40)
    expect(snap.rows.filter((r) => r.dev)).toHaveLength(30)
    expect(snap.rows.filter((r) => !r.dev).map((r) => r.pid)).toEqual(Array.from({ length: 10 }, (_, i) => i))
    expect(snap.rows.map((r) => r.ports[0])).toEqual([...snap.rows.map((r) => r.ports[0])].sort((a, b) => a - b))
  })

  it('clips a log to its last 20 lines of 300 characters', () => {
    const long = { ...row(1), log: Array.from({ length: 30 }, (_, j) => `${j}:`.padEnd(400, 'y')) }
    const snap = capSnapshot({ enabled: true, canRestart: true, rows: [long] })
    expect(snap.rows[0].log).toHaveLength(20)
    expect(snap.rows[0].log[0].startsWith('10:')).toBe(true)
    expect(snap.rows[0].log.every((l) => l.length <= 300)).toBe(true)
  })

  it('drops rows past the cap once no log line is left', () => {
    const fat = (i: number): ServerRow => ({ ...row(i), log: [], command: 'c'.repeat(2_000) })
    const snap = capSnapshot({ enabled: true, canRestart: true, rows: Array.from({ length: 40 }, (_, i) => fat(i)) })
    expect(Buffer.byteLength(JSON.stringify(snap), 'utf8')).toBeLessThanOrEqual(SERVERS_MAX_BYTES)
    expect(snap.rows.length).toBeLessThan(40)
  })
})

describe('servers system runners', () => {
  let calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>
  let exec: ExecFn
  beforeEach(() => {
    calls = []
    exec = async (file, args, opts) => { calls.push({ file, args, env: opts.env }); return '' }
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('runs ps by absolute path under LC_ALL=C, comm last', async () => {
    const sys = createServersSystem(exec, { PATH: '/usr/bin', HOME: HOME, SECRET_TOKEN: 'nope' })
    await sys.runPsStats()
    await sys.runPsArgs([12, 34])
    expect(calls[0]).toEqual({ file: '/bin/ps', args: ['-ax', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,etime=,%cpu=,rss=,comm='], env: expect.objectContaining({ LC_ALL: 'C' }) })
    expect(calls[1]).toEqual({ file: '/bin/ps', args: ['-o', 'pid=,args=', '-p', '12,34'], env: expect.objectContaining({ LC_ALL: 'C' }) })
    expect(calls[0].env.SECRET_TOKEN).toBeUndefined()
  })

  it('runs lsof by absolute path with an argument list', async () => {
    const sys = createServersSystem(exec, {})
    await sys.runLsofListen()
    await sys.runLsofCwd([7, 8])
    expect(calls.map((c) => [c.file, c.args])).toEqual([
      ['/usr/sbin/lsof', ['-nP', '-a', '-u', String(sys.uid), '-iTCP', '-sTCP:LISTEN', '-F', 'pcuLn']],
      ['/usr/sbin/lsof', ['-a', '-p', '7,8', '-d', 'cwd', '-Fn']],
    ])
  })

  it('runs nothing for an empty pid list', async () => {
    const sys = createServersSystem(exec, {})
    expect(await sys.runPsArgs([])).toBe('')
    expect(await sys.runLsofCwd([])).toBe('')
    expect(calls).toEqual([])
  })
})

describe('devTabLights', () => {
  const tab = (host: string, errors: number, requests: number, server: 'up' | 'down' = 'up') => ({
    tabId: 1, app: 'a', host,
    errors: { total: errors, open: errors, seen: errors, last: null },
    requests: { total: requests, open: requests, seen: 0, last: null },
    history: [], devServer: null, inFlight: 0, perf: {}, server, activity: 1,
  })
  const snap = (tabs: ReturnType<typeof tab>[]) => ({ enabled: true, paired: 1, installs: [{ deviceId: 'd', name: 'n', on: true, connected: true, report: true, features: [], tabs }] })

  it('lights loopback ports only, the worst tab of a port winning', () => {
    const lights = devTabLights(snap([
      tab('localhost:5173', 0, 1),
      tab('127.0.0.1:5173', 0, 0),
      tab('[::1]:3000', 1, 0),
      tab('shop.localhost:4000', 0, 0, 'down'),
      tab('app.localhost:8080', 0, 0),
      tab('192.0.2.10:9000', 1, 0),
      tab('example.com:9001', 1, 0),
      tab('localhost', 1, 0),
    ]) as never)
    expect([...lights].sort((a, b) => a[0] - b[0])).toEqual([[3000, 'red'], [4000, 'red'], [5173, 'orange'], [8080, 'green']])
  })
})
