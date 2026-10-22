/**
 * The `companion:servers` channel: the TCP servers listening on this Mac, for Fremdev's Servers
 * segment. Read side here: lsof and ps every `SERVERS_INTERVAL_MS` while the channel has a
 * subscriber, turned into rows by `list.ts`. In the `companion` family, so `LOCAL_ONLY_CHANNELS`
 * (ws/hub.ts) keeps it from paired devices and `BUILTIN_ONLY_CHANNELS` from registry widgets; gated
 * on `labs.fremdev` like `companion:dev`.
 *
 * Never published: argv as a list, the environment, the home folder (written `~`), a non-dev
 * program's arguments (`displayCommand`).
 */

import { basename } from 'node:path'
import type { Config } from '../../config/schema.js'
import type { Provider } from '../../providers/types.js'
import { fremdevEnabled } from '../dev.js'
import { displayCommand, detectTool, isDevRuntime, isDockerHolder, isHelper, isSystemProcess, parseLsofCwd, parseLsofListen, parsePs, selfTree, type ProcInfo } from './list.js'
import { createServersSystem, type ServersSystem } from './system.js'
import { createServerCommands } from './commands.js'
import { homeToTilde } from '../../home-tilde.js'

export const COMPANION_SERVERS_CHANNEL = 'companion:servers'
export const SERVERS_INTERVAL_MS = 5_000
/** The most a snapshot may weigh as JSON, measured as Fremdev's `DEV_INSTALL_MAX_BYTES` is. */
export const SERVERS_MAX_BYTES = 60_000
export const SERVERS_MAX_ROWS = 40
export const SERVERS_LOG_LINES = 20
export const SERVERS_LOG_LINE_CHARS = 300

export type TabLight = 'red' | 'orange' | 'green'

export type ServerRow = {
  /** `${pid}:${start}`: a recycled pid has another start, so another id. */
  id: string
  pid: number
  ports: number[]
  project: string
  tool: string
  uptimeSec: number
  cpu: number
  rssKb: number
  /** The working folder, home as `~`; null when lsof gave none. */
  folder: string | null
  /** `displayCommand`, home as `~`. */
  command: string
  dev: boolean
  system: boolean
  /** A Docker Desktop port holder: the container's name, or 'Docker' when it is not known. */
  docker: string | null
  managed: boolean
  state: 'up' | 'starting' | 'failed'
  /** Holds a port a server Fremkit restarted failed on. */
  portBusy: boolean
  /** The Fremdev light of a loopback tab on one of its ports, the worst when several. */
  tab: TabLight | null
  /** Managed rows only: their last output lines. */
  log: string[]
}

export type ServersSnapshot = { enabled: boolean; rows: ServerRow[]; canRestart: boolean; error?: string }

export interface ServersOptions {
  config: () => Config
  dataDir: string
  /** `FREMKIT_SCANNER`, the helper's `fremkit-scan`: without it there is no restart. */
  scanner: string | null
  tabLights: () => ReadonlyMap<number, TabLight>
  system?: Partial<ServersSystem>
  selfPid?: number
  now?: () => number
  /** Polls the channel again: the registry's `refresh`, called 1 s after each command. */
  refresh?: () => void
}

const RANK: Record<TabLight, number> = { red: 0, orange: 1, green: 2 }

/** How long the container names from `docker ps` are reused while the holders' ports stay the same. */
export const DOCKER_NAMES_TTL_MS = 30_000

/**
 * Folders whose files macOS guards behind a privacy prompt: a `package.json` there is never read,
 * so polling never asks for Fremkit Helper's access.
 */
function isProtected(folder: string, home: string): boolean {
  return ['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents'].some((d) => {
    const dir = `${home}/${d}`
    return folder === dir || folder.startsWith(dir + '/')
  })
}

/** `docker ps --format '{{.Names}}\t{{.Ports}}'`: the container publishing each host port. */
export function parseDockerPorts(out: string): Map<number, string> {
  const byPort = new Map<number, string>()
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const name = line.slice(0, tab).trim().slice(0, 128)
    for (const m of line.slice(tab + 1).matchAll(/:(\d{1,5})(?:-(\d{1,5}))?->/g)) {
      const from = Number(m[1])
      const to = m[2] ? Math.min(Number(m[2]), from + 1024) : from
      for (let port = from; port <= to; port++) if (!byPort.has(port)) byPort.set(port, name)
    }
  }
  return byPort
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** The rows kept first when some must go: dev or managed ones, then by port. */
function keepOrder(a: ServerRow, b: ServerRow): number {
  const rank = (r: ServerRow) => (r.dev || r.managed ? 0 : 1)
  return rank(a) - rank(b) || a.ports[0] - b.ports[0] || a.pid - b.pid
}
const byPort = (a: ServerRow, b: ServerRow) => a.ports[0] - b.ports[0] || a.pid - b.pid

/**
 * Under `SERVERS_MAX_BYTES`: at most 40 rows (non-dev, unmanaged ones go first, then the highest
 * ports) and 20 log lines of 300 characters each; then the oldest log lines go, from the longest
 * log first; then rows, in the same order as the 40-row cut. Each row is measured once and again
 * only when its log is cut: the total is the empty snapshot plus the rows and their commas, which
 * is exactly what `JSON.stringify` writes.
 */
export function capSnapshot(snap: ServersSnapshot): ServersSnapshot {
  const rows = [...snap.rows].sort(keepOrder).slice(0, SERVERS_MAX_ROWS).map((r) => ({
    ...r,
    log: r.log.slice(-SERVERS_LOG_LINES).map((l) => l.slice(0, SERVERS_LOG_LINE_CHARS)),
  }))
  const sizes = rows.map((r) => bytes(r))
  const base = bytes({ ...snap, rows: [] })
  let total = base + sizes.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1)
  while (total > SERVERS_MAX_BYTES) {
    let longest = -1
    for (let i = 0; i < rows.length; i++) if (rows[i].log.length > 0 && (longest < 0 || rows[i].log.length > rows[longest].log.length)) longest = i
    if (longest < 0) break
    // A handful of lines per round: a full snapshot needs a few dozen rounds, not hundreds.
    const r = rows[longest]
    r.log = r.log.slice(Math.min(5, r.log.length))
    const size = bytes(r)
    total += size - sizes[longest]
    sizes[longest] = size
  }
  while (rows.length > 0 && total > SERVERS_MAX_BYTES) {
    total -= sizes.pop()! + (rows.length > 1 ? 1 : 0)
    rows.pop()
  }
  return { ...snap, rows: rows.sort(byPort) }
}

export function createServersProvider(opts: ServersOptions): Provider<ServersSnapshot> & { lookup(id: string): ServerRow | null } {
  const sys: ServersSystem = { ...createServersSystem(), ...opts.system }
  const selfPid = opts.selfPid ?? process.pid
  let last: ServerRow[] = []
  let byId = new Map<string, ServerRow>()
  /** The real working folder of each row of the last snapshot: what Reveal opens, never published. */
  let folders = new Map<string, string>()
  /** Filled by `listRows`, read once the snapshot is cut. */
  let polledFolders = new Map<string, string>()
  const now = opts.now ?? Date.now
  /** The last `docker ps` names, with the holders' ports they were asked for. */
  let dockerNames: { key: string; at: number; names: Map<number, string> } | null = null

  const canRestart = () => opts.scanner !== null

  async function project(p: ProcInfo, cwd: string | null): Promise<string> {
    // The home folder's basename is the account's name: never a project's.
    if (!cwd || cwd === '/' || cwd.replace(/\/+$/, '') === sys.home.replace(/\/+$/, '')) return basename(p.comm)
    if (!isProtected(cwd, sys.home)) {
      const name = await sys.readPackageName(cwd)
      if (name) return name
    }
    return basename(cwd)
  }

  async function listRows(): Promise<ServerRow[]> {
    const listeners = parseLsofListen(await sys.runLsofListen())
    if (listeners.length === 0) return []
    const statsText = await sys.runPsStats()
    // Every process, once: the listeners' parents (the launch root) and Fremkit's own descendants.
    const stats = parsePs(statsText, '')
    const own = selfTree(selfPid, stats)
    const kept = listeners.filter((l) => {
      const p = stats.get(l.pid)
      return p !== undefined && p.uid === sys.uid && !own.has(l.pid) && !isHelper(p)
    })
    if (kept.length === 0) return []

    // Command lines for the listeners and their parents up to launchd, nothing else.
    const wanted: number[] = []
    const seen = new Set<number>()
    for (const l of kept) {
      let pid: number | undefined = l.pid
      while (pid !== undefined && pid > 1 && !seen.has(pid)) {
        seen.add(pid)
        wanted.push(pid)
        pid = stats.get(pid)?.ppid
      }
    }
    const [argsText, cwdText] = await Promise.all([sys.runPsArgs(wanted), sys.runLsofCwd(kept.map((l) => l.pid))])
    const procs = parsePs(statsText, argsText)
    const cwds = parseLsofCwd(cwdText)

    const holders = kept.filter((l) => isDockerHolder(procs.get(l.pid)!))
    const docker = holders.length > 0 ? await containerNames(holders.flatMap((l) => l.ports)) : null
    const lights = opts.tabLights()
    polledFolders = new Map()

    const rows = await Promise.all(kept.map(async (l): Promise<ServerRow> => {
      const p = procs.get(l.pid)!
      const cwd = cwds.get(l.pid) ?? null
      const dev = isDevRuntime(p, cwd)
      if (cwd !== null) polledFolders.set(`${p.pid}:${p.start}`, cwd)
      let tab: TabLight | null = null
      for (const port of l.ports) {
        const light = lights.get(port)
        if (light && (tab === null || RANK[light] < RANK[tab])) tab = light
      }
      return {
        id: `${p.pid}:${p.start}`,
        pid: p.pid,
        ports: l.ports,
        project: await project(p, cwd),
        tool: detectTool(p.args, p.comm),
        uptimeSec: p.etimeSec,
        cpu: p.cpu,
        rssKb: p.rssKb,
        folder: cwd === null ? null : homeToTilde(cwd, sys.home),
        command: homeToTilde(displayCommand(p, dev), sys.home),
        dev,
        system: isSystemProcess(p),
        docker: docker && isDockerHolder(p) ? (l.ports.map((port) => docker.get(port)).find((n) => n !== undefined) ?? 'Docker') : null,
        managed: false,
        state: 'up',
        portBusy: false,
        tab,
        log: [],
      }
    }))
    return rows.sort(byPort)
  }

  /** Docker's container names by host port: asked again when the holders' ports change, or after 30 s. */
  async function containerNames(ports: number[]): Promise<Map<number, string>> {
    const key = [...new Set(ports)].sort((a, b) => a - b).join(',')
    const t = now()
    if (dockerNames && dockerNames.key === key && t - dockerNames.at < DOCKER_NAMES_TTL_MS) return dockerNames.names
    let names: Map<number, string>
    try {
      names = parseDockerPorts(await sys.runDockerPorts())
    } catch {
      names = new Map()
    }
    dockerNames = { key, at: t, names }
    return names
  }

  async function snapshot(): Promise<ServersSnapshot> {
    if (!fremdevEnabled(opts.config())) {
      last = []
      byId = new Map()
      folders = new Map()
      return { enabled: false, rows: [], canRestart: canRestart() }
    }
    try {
      const snap = capSnapshot({ enabled: true, rows: await listRows(), canRestart: canRestart() })
      last = snap.rows
      byId = new Map(last.map((r) => [r.id, r]))
      folders = new Map(last.flatMap((r) => { const f = polledFolders.get(r.id); return f === undefined ? [] : [[r.id, f] as const] }))
      return snap
    } catch {
      return { enabled: true, rows: last, canRestart: canRestart(), error: 'unavailable' }
    }
  }

  return {
    channel: COMPANION_SERVERS_CHANNEL,
    intervalMs: SERVERS_INTERVAL_MS,
    // The registry never starts a poll while one is running (its inFlight/pollAgain).
    poll: snapshot,
    commands: createServerCommands({
      sys,
      selfPid,
      config: opts.config,
      lookup: (id) => byId.get(id) ?? null,
      folderOf: (id) => folders.get(id) ?? null,
      refresh: opts.refresh,
    }),
    lookup: (id) => byId.get(id) ?? null,
  }
}
