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
import { displayCommand, detectTool, isDevRuntime, isDockerHolder, isSystemProcess, parseLsofCwd, parseLsofListen, parsePs, selfTree, type ProcInfo } from './list.js'
import { createServersSystem, type ServersSystem } from './system.js'

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
}

const HELPER_NAME = 'FremkitHelper'
const RANK: Record<TabLight, number> = { red: 0, orange: 1, green: 2 }

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every occurrence of the home folder as a path written `~`. */
export function homeRewrite(text: string, home: string): string {
  const h = home.replace(/\/+$/, '')
  if (h.length <= 1) return text
  return text.replace(new RegExp(`${escapeRegExp(h)}(?=/|\\s|$)`, 'g'), '~')
}

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

const bytes = (snap: ServersSnapshot) => Buffer.byteLength(JSON.stringify(snap), 'utf8')

/**
 * Under `SERVERS_MAX_BYTES`: at most 40 rows and 20 log lines of 300 characters each; then the
 * oldest log lines go, from the longest log first; then rows from the end.
 */
export function capSnapshot(snap: ServersSnapshot): ServersSnapshot {
  const rows = snap.rows.slice(0, SERVERS_MAX_ROWS).map((r) => ({
    ...r,
    log: r.log.slice(-SERVERS_LOG_LINES).map((l) => l.slice(0, SERVERS_LOG_LINE_CHARS)),
  }))
  const out: ServersSnapshot = { ...snap, rows }
  while (bytes(out) > SERVERS_MAX_BYTES) {
    let longest: ServerRow | null = null
    for (const r of rows) if (r.log.length > 0 && (!longest || r.log.length > longest.log.length)) longest = r
    if (!longest) break
    // A handful of lines per round: a full snapshot needs a few dozen rounds, not hundreds.
    longest.log = longest.log.slice(Math.min(5, longest.log.length))
  }
  while (rows.length > 0 && bytes(out) > SERVERS_MAX_BYTES) rows.pop()
  return out
}

export function createServersProvider(opts: ServersOptions): Provider<ServersSnapshot> & { lookup(id: string): ServerRow | null } {
  const sys: ServersSystem = { ...createServersSystem(), ...opts.system }
  const selfPid = opts.selfPid ?? process.pid
  let last: ServerRow[] = []
  let byId = new Map<string, ServerRow>()
  let inFlight: Promise<ServersSnapshot> | null = null

  const canRestart = () => opts.scanner !== null

  async function project(p: ProcInfo, cwd: string | null): Promise<string> {
    if (!cwd || cwd === '/') return basename(p.comm)
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
      return p !== undefined && p.uid === sys.uid && !own.has(l.pid) && basename(p.comm) !== HELPER_NAME
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

    let docker: Map<number, string> | null = null
    if (kept.some((l) => isDockerHolder(procs.get(l.pid)!))) {
      try {
        docker = parseDockerPorts(await sys.runDockerPorts())
      } catch {
        docker = new Map()
      }
    }
    const lights = opts.tabLights()

    const rows = await Promise.all(kept.map(async (l): Promise<ServerRow> => {
      const p = procs.get(l.pid)!
      const cwd = cwds.get(l.pid) ?? null
      const dev = isDevRuntime(p, cwd)
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
        folder: cwd === null ? null : homeRewrite(cwd, sys.home),
        command: homeRewrite(displayCommand(p, dev), sys.home),
        dev,
        system: isSystemProcess(p),
        docker: docker ? (l.ports.map((port) => docker!.get(port)).find((n) => n !== undefined) ?? 'Docker') : null,
        managed: false,
        state: 'up',
        portBusy: false,
        tab,
        log: [],
      }
    }))
    return rows.sort((a, b) => a.ports[0] - b.ports[0] || a.pid - b.pid)
  }

  async function snapshot(): Promise<ServersSnapshot> {
    if (!fremdevEnabled(opts.config())) {
      last = []
      byId = new Map()
      return { enabled: false, rows: [], canRestart: canRestart() }
    }
    try {
      const snap = capSnapshot({ enabled: true, rows: await listRows(), canRestart: canRestart() })
      last = snap.rows
      byId = new Map(last.map((r) => [r.id, r]))
      return snap
    } catch {
      return { enabled: true, rows: last, canRestart: canRestart(), error: 'unavailable' }
    }
  }

  return {
    channel: COMPANION_SERVERS_CHANNEL,
    intervalMs: SERVERS_INTERVAL_MS,
    poll() {
      // A slow lsof never stacks a second run behind the first.
      inFlight ??= snapshot().finally(() => { inFlight = null })
      return inFlight
    },
    commands: {},
    lookup: (id) => byId.get(id) ?? null,
  }
}
