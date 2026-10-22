import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import { tr } from '../src/i18n.js'
import { createServersProvider, type ServersSnapshot } from '../src/companion/servers/provider.js'
import { COMMAND_REFRESH_MS, KILL_GRACE_MS, killGroup } from '../src/companion/servers/commands.js'
import { parsePs, selfTree, type ProcInfo } from '../src/companion/servers/list.js'
import type { ServersSystem } from '../src/companion/servers/system.js'
import type { CommandContext } from '../src/providers/types.js'

const HOME = '/Users/tester'
const UID = 501
const SELF = 900
const START = 'Wed Oct 22 09:01:02 2026'
const OTHER_START = 'Wed Oct 22 10:11:12 2026'
const LOCAL: CommandContext = { loopback: true, paired: false }

type Proc = { pid: number; ppid?: number; pgid?: number; uid?: number; start?: string; comm: string; args?: string; cwd?: string | null; ports?: number[] }

/** A process table lsof and ps answer from; tests change it between the poll and the command. */
function world(initial: Proc[], opts: { config?: () => Config; dieOn?: 'SIGTERM' | 'never' } = {}) {
  let procs = [...initial]
  const signals: Array<[number, string]> = []
  const opened: string[][] = []
  const line = (p: Proc) => `${p.pid} ${p.ppid ?? 1} ${p.pgid ?? p.pid} ${p.uid ?? UID} ${p.start ?? START} 01:02:03 1.5 120000 ${p.comm}`
  const sys: ServersSystem = {
    uid: UID,
    home: HOME,
    runLsofListen: async () => procs.filter((p) => p.ports?.length).map((p) => [`p${p.pid}`, `c${p.comm.split('/').pop()}`, `u${p.uid ?? UID}`, ...p.ports!.map((n) => `n*:${n}`)].join('\n')).join('\n') + '\n',
    runPsStats: async () => [{ pid: 1, ppid: 0, comm: '/sbin/launchd', uid: 0 } as Proc, ...procs].map(line).join('\n') + '\n',
    runPsArgs: async (pids) => procs.filter((p) => pids.includes(p.pid)).map((p) => `${p.pid} ${p.args ?? p.comm}`).join('\n') + '\n',
    runLsofCwd: async (pids) => procs.filter((p) => pids.includes(p.pid) && p.cwd).map((p) => `p${p.pid}\nfcwd\nn${p.cwd}`).join('\n') + '\n',
    runDockerPorts: async () => '',
    readPackageName: async () => null,
    kill: vi.fn((pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal])
      if (opts.dieOn === 'SIGTERM' || signal === 'SIGKILL') {
        procs = procs.filter((p) => (pid < 0 ? (p.pgid ?? p.pid) !== -pid : p.pid !== pid))
      }
    }),
    runOpen: vi.fn(async (args: string[]) => { opened.push(args) }),
  }
  const refresh = vi.fn()
  const provider = createServersProvider({
    config: opts.config ?? on,
    dataDir: '/nonexistent',
    scanner: null,
    tabLights: () => new Map(),
    system: sys,
    selfPid: SELF,
    refresh,
  })
  return {
    provider,
    sys,
    signals,
    opened,
    refresh,
    set: (next: Proc[]) => { procs = next },
    get: () => procs,
    poll: async () => (await provider.poll!()) as ServersSnapshot,
    /** `null`: no context at all, as a command from inside the server has. */
    run: (name: string, id: string, ctx: CommandContext | null = LOCAL) => provider.commands![name]({ instanceId: 'w1', id }, ctx ?? undefined) as Promise<{ ok: boolean; error?: string }>,
  }
}

function on(): Config {
  return { ...DEFAULT_CONFIG, labs: { ...DEFAULT_CONFIG.labs, fremdev: true } } as Config
}
const msg = (key: Parameters<typeof tr>[1]) => tr(on().locale, key)

const SHELL: Proc = { pid: 1000, comm: '/bin/zsh', args: '-zsh' }
const PNPM: Proc = { pid: 1001, ppid: 1000, comm: '/opt/homebrew/bin/node', args: 'node /opt/homebrew/bin/pnpm dev', cwd: `${HOME}/code/shop` }
const VITE: Proc = { pid: 1002, ppid: 1001, pgid: 1001, comm: '/opt/homebrew/bin/node', args: `node ${HOME}/code/shop/node_modules/.bin/vite --port 5173`, cwd: `${HOME}/code/shop`, ports: [5173] }
const ESBUILD: Proc = { pid: 1003, ppid: 1002, pgid: 1001, comm: `${HOME}/code/shop/node_modules/@esbuild/darwin-arm64/bin/esbuild`, args: 'esbuild --service' }
const FREMKIT: Proc = { pid: SELF, ppid: 800, pgid: 800, comm: '/opt/homebrew/bin/node', args: 'node tsx src/index.ts' }
const RAPPORTD: Proc = { pid: 1500, comm: '/usr/libexec/rapportd', ports: [49152] }
const DOCKER: Proc = { pid: 1600, comm: '/Applications/Docker.app/Contents/MacOS/com.docker.backend', ports: [5432], cwd: '/' }
const viteId = `1002:${START}`

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('companion:servers commands: who may ask', () => {
  it('refuses without a context, from another machine, and from a paired device', async () => {
    const w = world([SHELL, PNPM, VITE, ESBUILD, FREMKIT])
    await w.poll()
    for (const name of ['kill', 'open', 'reveal']) {
      await expect(w.run(name, viteId, null)).rejects.toThrow(msg('provider.localOnly'))
      await expect(w.run(name, viteId, { loopback: false, paired: false })).rejects.toThrow(msg('provider.localOnly'))
      await expect(w.run(name, viteId, { loopback: false, paired: true, deviceId: 'd1' })).rejects.toThrow(msg('provider.localOnly'))
    }
    expect(w.signals).toEqual([])
    expect(w.opened).toEqual([])
  })

  it('refuses a payload with anything more than the instance and the id', async () => {
    const w = world([SHELL, PNPM, VITE])
    await w.poll()
    await expect(w.provider.commands!.kill({ instanceId: 'w1', id: viteId, pid: 1002 }, LOCAL)).rejects.toThrow(msg('provider.invalidPayload'))
    await expect(w.provider.commands!.kill({ instanceId: 'w1', id: 'x'.repeat(65) }, LOCAL)).rejects.toThrow(msg('provider.invalidPayload'))
    expect(w.signals).toEqual([])
  })

  it('refuses everything while Fremdev is off', async () => {
    let config = on()
    const w = world([SHELL, PNPM, VITE], { config: () => config })
    await w.poll()
    config = DEFAULT_CONFIG as Config
    for (const name of ['kill', 'open', 'reveal']) expect(await w.run(name, viteId)).toEqual({ ok: false, error: msg('companion.devDisabled') })
    expect(w.signals).toEqual([])
    expect(w.opened).toEqual([])
  })

  it('refuses an id that is not in the snapshot', async () => {
    const w = world([SHELL, PNPM, VITE])
    await w.poll()
    for (const name of ['kill', 'open', 'reveal']) expect(await w.run(name, `1002:${OTHER_START}`)).toEqual({ ok: false, error: msg('companion.serversUnknown') })
    expect(w.signals).toEqual([])
  })

  it('refuses to kill a pid that now has another start time: the server died and its pid was reused', async () => {
    const w = world([SHELL, PNPM, VITE])
    await w.poll()
    w.set([SHELL, PNPM, { ...VITE, start: OTHER_START }])
    expect(await w.run('kill', viteId)).toEqual({ ok: false, error: msg('companion.serversUnknown') })
    w.set([SHELL, PNPM])
    expect(await w.run('kill', viteId)).toEqual({ ok: false, error: msg('companion.serversUnknown') })
    expect(w.signals).toEqual([])
  })

  it("never kills a system program, but opens it", async () => {
    const w = world([RAPPORTD])
    await w.poll()
    const id = `1500:${START}`
    expect(await w.run('kill', id)).toEqual({ ok: false, error: msg('companion.serversNotAllowed') })
    expect(w.signals).toEqual([])
    expect(await w.run('open', id)).toEqual({ ok: true })
    expect(w.opened).toEqual([['http://localhost:49152/']])
  })

  it('gives a Docker holder no action at all', async () => {
    const w = world([DOCKER])
    await w.poll()
    const id = `1600:${START}`
    for (const name of ['kill', 'open', 'reveal']) expect(await w.run(name, id)).toEqual({ ok: false, error: msg('companion.serversNotAllowed') })
    expect(w.signals).toEqual([])
    expect(w.opened).toEqual([])
  })

  it('refuses a kill whose launch root belongs to another account', async () => {
    const w = world([SHELL, { ...PNPM, uid: 0 }, VITE])
    await w.poll()
    expect(await w.run('kill', viteId)).toEqual({ ok: false, error: msg('companion.serversNotAllowed') })
    expect(w.signals).toEqual([])
  })
})

describe('companion:servers commands: kill', () => {
  it("signals the launch root's own group with TERM, then KILL after 3 s when it is still alive", async () => {
    const w = world([SHELL, { ...PNPM, pgid: 1001 }, VITE, ESBUILD, FREMKIT])
    await w.poll()
    expect(await w.run('kill', viteId)).toEqual({ ok: true })
    expect(w.signals).toEqual([[-1001, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1)
    expect(w.signals).toEqual([[-1001, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(1)
    expect(w.signals).toEqual([[-1001, 'SIGTERM'], [-1001, 'SIGKILL']])
    expect(KILL_GRACE_MS).toBe(3_000)
  })

  it('sends no KILL when the group left on TERM', async () => {
    const w = world([SHELL, { ...PNPM, pgid: 1001 }, VITE, ESBUILD], { dieOn: 'SIGTERM' })
    await w.poll()
    expect(await w.run('kill', viteId)).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
    expect(w.signals).toEqual([[-1001, 'SIGTERM']])
  })

  it("signals pid by pid when the server shares its parent's group (an IDE task, no job control)", async () => {
    const ide: Proc = { pid: 1000, pgid: 1000, comm: '/Applications/Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper', args: 'Code Helper' }
    const w = world([ide, { ...VITE, ppid: 1000, pgid: 1000 }, { ...ESBUILD, pgid: 1000 }])
    await w.poll()
    expect(await w.run('kill', viteId)).toEqual({ ok: true })
    expect(w.signals).toEqual([[1002, 'SIGTERM'], [1003, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
    expect(w.signals).toEqual([[1002, 'SIGTERM'], [1003, 'SIGTERM'], [1002, 'SIGKILL'], [1003, 'SIGKILL']])
    expect(w.signals.some(([pid]) => pid === 1000 || pid === -1000)).toBe(false)
  })

  it("never sends KILL to a pid reused during the 3 s", async () => {
    const ide: Proc = { pid: 1000, pgid: 1000, comm: '/Applications/Code.app/Contents/MacOS/Code Helper', args: 'Code Helper' }
    const w = world([ide, { ...VITE, ppid: 1000, pgid: 1000 }])
    await w.poll()
    expect(await w.run('kill', viteId)).toEqual({ ok: true })
    w.set([ide, { ...VITE, ppid: 1000, pgid: 1000, start: OTHER_START }])
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
    expect(w.signals).toEqual([[1002, 'SIGTERM']])
  })

  it("says so when nothing could be signalled", async () => {
    const w = world([SHELL, { ...PNPM, pgid: 1001 }, VITE])
    await w.poll()
    vi.mocked(w.sys.kill).mockImplementation(() => { throw Object.assign(new Error('nope'), { code: 'EPERM' }) })
    expect(await w.run('kill', viteId)).toEqual({ ok: false, error: msg('companion.serversKillFailed') })
  })
})

describe('killGroup', () => {
  const table = (list: Proc[]): Map<number, ProcInfo> => parsePs(list.map((p) => `${p.pid} ${p.ppid ?? 1} ${p.pgid ?? p.pid} ${p.uid ?? UID} ${START} 00:10 0.0 1 ${p.comm}`).join('\n'), list.map((p) => `${p.pid} ${p.args ?? p.comm}`).join('\n'))

  it("takes the root's group when it is its own job", () => {
    const procs = table([SHELL, { ...PNPM, pgid: 1001 }, VITE, ESBUILD, FREMKIT])
    expect(killGroup(procs.get(1001)!, procs, selfTree(SELF, procs))).toEqual({ pgid: 1001 })
  })

  it("falls back to the root's tree when the group is the parent's", () => {
    // tmux is the user's own (Homebrew): only the shared group sends the kill pid by pid.
    const tmux: Proc = { pid: 1000, comm: '/opt/homebrew/bin/tmux', args: 'tmux' }
    const procs = table([tmux, { ...PNPM, pgid: 1000 }, { ...VITE, pgid: 1000 }, { ...ESBUILD, pgid: 1000 }])
    expect(killGroup(procs.get(1001)!, procs, selfTree(SELF, procs))).toEqual({ pids: [1001, 1002, 1003] })
  })

  it("falls back when the group is Fremkit's own, or holds Fremkit's tree", () => {
    const procs = table([{ pid: 800, comm: '/bin/zsh' }, { ...FREMKIT, pgid: 1001 }, { ...SHELL }, { ...PNPM, pgid: 1001 }, VITE])
    expect(killGroup(procs.get(1001)!, procs, selfTree(SELF, procs))).toEqual({ pids: [1001, 1002] })
    const child = table([FREMKIT, { pid: 901, ppid: SELF, pgid: 1001, comm: '/opt/homebrew/bin/node' }, SHELL, { ...PNPM, pgid: 1001 }, VITE])
    expect(killGroup(child.get(1001)!, child, selfTree(SELF, child))).toEqual({ pids: [1001, 1002] })
  })

  it('falls back when a system program or another account sits in the group, and never lists one', () => {
    const procs = table([SHELL, { ...PNPM, pgid: 1001 }, VITE, { pid: 1004, ppid: 1002, pgid: 1001, comm: '/usr/bin/caffeinate' }])
    expect(killGroup(procs.get(1001)!, procs, selfTree(SELF, procs))).toEqual({ pids: [1001, 1002] })
    const other = table([SHELL, { ...PNPM, pgid: 1001 }, VITE, { pid: 1004, ppid: 1002, pgid: 1001, uid: 0, comm: '/opt/x' }])
    expect(killGroup(other.get(1001)!, other, selfTree(SELF, other))).toEqual({ pids: [1001, 1002] })
  })
})

describe('companion:servers commands: open and reveal', () => {
  it('opens the first port on localhost with /usr/bin/open', async () => {
    const w = world([SHELL, PNPM, { ...VITE, ports: [5173, 24678] }])
    await w.poll()
    expect(await w.run('open', viteId)).toEqual({ ok: true })
    expect(w.opened).toEqual([['http://localhost:5173/']])
  })

  it('reveals the real folder in Finder, not the ~ it shows', async () => {
    const w = world([SHELL, PNPM, VITE])
    const snap = await w.poll()
    expect(snap.rows[0].folder).toBe('~/code/shop')
    expect(JSON.stringify(snap)).not.toContain(HOME)
    expect(await w.run('reveal', viteId)).toEqual({ ok: true })
    expect(w.opened).toEqual([['-R', `${HOME}/code/shop`]])
  })

  it('refuses to reveal a server without a known folder', async () => {
    const w = world([SHELL, PNPM, { ...VITE, cwd: null }])
    await w.poll()
    expect(await w.run('reveal', viteId)).toEqual({ ok: false, error: msg('companion.serversNoFolder') })
    expect(w.opened).toEqual([])
  })

  it('says so when open fails', async () => {
    const w = world([SHELL, PNPM, VITE])
    await w.poll()
    vi.mocked(w.sys.runOpen).mockRejectedValue(new Error('unavailable'))
    expect(await w.run('open', viteId)).toEqual({ ok: false, error: msg('companion.serversOpenFailed') })
  })
})

describe('companion:servers commands: refresh', () => {
  it('polls again 1 s after each command', async () => {
    const w = world([SHELL, { ...PNPM, pgid: 1001 }, VITE])
    await w.poll()
    for (const name of ['open', 'reveal', 'kill']) {
      w.refresh.mockClear()
      await w.run(name, viteId)
      await vi.advanceTimersByTimeAsync(COMMAND_REFRESH_MS - 1)
      expect(w.refresh).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(w.refresh).toHaveBeenCalledTimes(1)
    }
    expect(COMMAND_REFRESH_MS).toBe(1_000)
  })

  it('polls again after a command refused for a stale row', async () => {
    const w = world([SHELL, PNPM, VITE])
    await w.poll()
    await w.run('kill', `1002:${OTHER_START}`)
    await vi.advanceTimersByTimeAsync(COMMAND_REFRESH_MS)
    expect(w.refresh).toHaveBeenCalledTimes(1)
  })
})
