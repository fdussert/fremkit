/**
 * Fremdev's server list, pure half: turns `lsof` and `ps` output into rows, decides which
 * listeners are dev servers, which may never be touched, and which process a "restart" or a
 * "kill" really targets (the launch root). No I/O here: the provider runs the programs.
 */

import { basename } from 'node:path'

export type ProcInfo = {
  pid: number
  ppid: number
  pgid: number
  uid: number
  /** `lstart` under `LC_ALL=C`, e.g. `Wed Oct 22 09:01:02 2026`: with the pid, the identity of a process. */
  start: string
  etimeSec: number
  cpu: number
  rssKb: number
  /** The executable's full path when ps gives it. */
  comm: string
  args: string
}

export type Listener = { pid: number; ports: number[]; comm: string }

function portOf(name: string): number | null {
  const m = /:(\d{1,5})$/.exec(name)
  if (!m) return null
  const port = Number(m[1])
  return port >= 1 && port <= 65535 ? port : null
}

/** `lsof -F pcuLn` output: one record per process, one `n` line per socket. IPv4 and IPv6 of a port, and every port of a pid, merge. */
export function parseLsofListen(out: string): Listener[] {
  const byPid = new Map<number, Listener>()
  let cur: Listener | null = null
  for (const line of out.split('\n')) {
    if (!line) continue
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number(value)
      if (!Number.isInteger(pid)) { cur = null; continue }
      cur = byPid.get(pid) ?? { pid, ports: [], comm: '' }
      byPid.set(pid, cur)
    } else if (!cur) {
      continue
    } else if (tag === 'c') {
      cur.comm = value
    } else if (tag === 'n') {
      const port = portOf(value)
      if (port !== null && !cur.ports.includes(port)) cur.ports.push(port)
    }
  }
  return [...byPid.values()].filter((l) => l.ports.length > 0).map((l) => ({ ...l, ports: [...l.ports].sort((a, b) => a - b) }))
}

/** `[[dd-]hh:]mm:ss` to seconds; NaN when it is none of those. */
function etimeToSec(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (!m) return NaN
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

/**
 * Two `ps` outputs run with `LC_ALL=C` and merged by pid. macOS cuts `comm` to 16 characters
 * unless it is the last column, so the stats come with `comm=` last
 * (`-o pid=,ppid=,pgid=,uid=,lstart=,etime=,%cpu=,rss=,comm=`, full path, spaces allowed) and the
 * command lines from `-o pid=,args=`. `lstart` is five words.
 */
export function parsePs(statsOut: string, argsOut: string): Map<number, ProcInfo> {
  const argsByPid = new Map<number, string>()
  for (const raw of argsOut.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(raw)
    if (m) argsByPid.set(Number(m[1]), m[2].trim())
  }
  const procs = new Map<number, ProcInfo>()
  for (const raw of statsOut.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!m) continue
    const etimeSec = etimeToSec(m[6])
    if (Number.isNaN(etimeSec)) continue
    const pid = Number(m[1])
    const comm = m[9].trim()
    procs.set(pid, {
      pid, ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]),
      start: m[5].replace(/\s+/g, ' '), etimeSec, cpu: Number(m[7]), rssKb: Number(m[8]), comm, args: argsByPid.get(pid) ?? comm,
    })
  }
  return procs
}

/** `lsof -a -p <pids> -d cwd -Fn` output. */
export function parseLsofCwd(out: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | null = null
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid !== null && Number.isInteger(pid)) cwds.set(pid, line.slice(1))
  }
  return cwds
}

/** `[name, label]`: matched against argv[0]'s basename and the script argument, extension stripped. */
const TOOLS: Array<[RegExp, string]> = [
  [/^vite$/, 'Vite'],
  [/^next(-server)?$/, 'Next'],
  [/^webpack(-dev-server)?$/, 'webpack'],
  [/^(storybook|start-storybook)$/, 'Storybook'],
  [/^astro$/, 'Astro'],
  [/^nuxti?$/, 'Nuxt'],
  [/^remix(-serve)?$/, 'Remix'],
  [/^(rails|puma)$/, 'Rails'],
  [/^manage\.py$/, 'Django'],
  [/^uvicorn$/, 'uvicorn'],
  [/^flask$/, 'Flask'],
]

const MODULE_TOOLS: Record<string, string> = { 'http.server': 'http.server', uvicorn: 'uvicorn', flask: 'Flask' }

function words(p: { args: string }): string[] {
  return p.args.split(/\s+/).filter(Boolean)
}

const VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--cwd', '--title', '-m', '-C', '--conditions', '--config'])

/** The first argument after argv[0] that is not an option or the value of one that takes a separate value: a runtime's script. */
function scriptArg(w: string[], exe = ''): string {
  const deno = exe === 'deno' || basename(w[0] ?? '') === 'deno' // deno's -r is --reload, a flag
  for (let i = 1; i < w.length; i++) {
    if (VALUE_OPTIONS.has(w[i]) && !(deno && w[i] === '-r')) { i++; continue }
    if (!w[i].startsWith('-')) return w[i]
  }
  return ''
}

function stem(path: string): string {
  return basename(path).replace(/\.(c|m)?(js|ts)$/, '').replace(/-cli$/, '')
}

function knownTool(args: string, comm: string): string | null {
  const w = words({ args })
  const script = scriptArg(w, basename(comm))
  const names = [basename(w[0] ?? ''), basename(script), stem(script)]
  for (const [re, label] of TOOLS) if (names.some((n) => re.test(n))) return label
  const m = w.indexOf('-m')
  if (m >= 0 && [basename(w[0] ?? ''), basename(comm)].some((n) => /^python(\d+(\.\d+)*)?$/i.test(n)) && w[m + 1] && MODULE_TOOLS[w[m + 1]]) return MODULE_TOOLS[w[m + 1]]
  const exe = basename(comm).toLowerCase()
  if (exe === 'dotnet') return '.NET'
  if (exe === 'php' || exe === 'php-fpm') return 'PHP'
  return null
}

/** A label for the row: the tool the command runs, else the program's name. */
export function detectTool(args: string, comm: string): string {
  return knownTool(args, comm) ?? basename(comm)
}

const RUNTIMES = /^(node|bun|deno|python(\d+(\.\d+)*)?|ruby|php|java|dotnet|go)$/i

export function isDevRuntime(p: ProcInfo, cwd: string | null): boolean {
  if (RUNTIMES.test(basename(p.comm))) return true
  if (knownTool(p.args, p.comm) !== null) return true
  // A Go or Rust server built in the folder it runs from.
  return cwd !== null && cwd.length > 1 && p.comm.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')
}

/** Programs shipped with macOS: Open only, never a kill. `/usr/local/` is the user's. */
export function isSystemProcess(p: ProcInfo): boolean {
  const c = p.comm
  if (c.startsWith('/usr/local/')) return false
  return ['/System/', '/usr/', '/bin/', '/sbin/', '/Library/Apple/'].some((d) => c.startsWith(d))
}

export function isDockerHolder(p: ProcInfo): boolean {
  const name = basename(p.comm)
  return name.startsWith('com.docker.') || name === 'vpnkit-bridge'
}

const RUNNER_NAMES = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bunx', 'turbo', 'nx', 'concurrently'])
const SCRIPT_RUNTIMES = new Set(['node', 'deno', 'bun'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])

/**
 * A package manager or runner: its own executable (or argv[0]), or a node/deno/bun running one as
 * its script, the first non-option argument. A runner's name elsewhere in the arguments
 * (`node agent.js -p "pnpm dev"`) does not count: that is an agent, not a runner.
 */
function isRunner(p: ProcInfo): boolean {
  const w = words(p)
  const exe = basename(p.comm)
  const argv0 = basename(w[0] ?? '')
  if (RUNNER_NAMES.has(exe) || RUNNER_NAMES.has(argv0)) return true
  if (!SCRIPT_RUNTIMES.has(exe) && !SCRIPT_RUNTIMES.has(argv0)) return false
  const script = scriptArg(w, exe)
  if (RUNNER_NAMES.has(stem(script))) return true
  return (exe === 'bun' || argv0 === 'bun') && (script === 'x' || (script === 'run' && isScriptName(w)))
}

/** `bun run <word>` where the word is a package.json script name, not a file. */
function isScriptName(w: string[]): boolean {
  const i = w.indexOf('run')
  const name = w.slice(i + 1).find((x) => !x.startsWith('-')) ?? ''
  return name !== '' && !name.includes('/') && !/\.(c|m)?[jt]sx?$/.test(name)
}

function isScriptShell(p: ProcInfo): boolean {
  const w = words(p)
  return SHELLS.has(basename(p.comm).replace(/^-/, '')) && w.slice(1).some((x) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x))
}

/**
 * The process a kill or a restart targets: climb from the listener only while the parent is a
 * package manager or runner (or the `sh -c` such a runner started for a script). An interactive
 * shell, a terminal, tmux, an IDE helper, an agent or launchd stops the climb, so a server an IDE
 * task started never takes its parent with it.
 */
export function launchRoot(pid: number, procs: Map<number, ProcInfo>): number {
  let root = pid
  const seen = new Set<number>([pid])
  for (;;) {
    const cur = procs.get(root)
    const parent = cur ? procs.get(cur.ppid) : undefined
    if (!cur || !parent || seen.has(parent.pid)) return root
    const climb = isScriptShell(parent)
      ? (() => { const up = procs.get(parent.ppid); return !!up && !isScriptShell(up) && isRunner(up) })()
      : isRunner(parent)
    if (!climb) return root
    seen.add(parent.pid)
    root = parent.pid
  }
}

/** `selfPid` and everything below it. */
export function selfTree(selfPid: number, procs: Map<number, ProcInfo>): Set<number> {
  const children = new Map<number, number[]>()
  for (const p of procs.values()) {
    const list = children.get(p.ppid)
    if (list) list.push(p.pid)
    else children.set(p.ppid, [p.pid])
  }
  const tree = new Set<number>([selfPid])
  const queue = [selfPid]
  while (queue.length > 0) {
    for (const c of children.get(queue.pop()!) ?? []) {
      if (!tree.has(c)) { tree.add(c); queue.push(c) }
    }
  }
  return tree
}

const SENSITIVE = /token|secret|key|password|pass|auth|cred/i

/**
 * What a row shows of its command. A dev row keeps its arguments with the value of any sensitive
 * long option (`--token x`, `--token=x`) or `KEY=VALUE` argument hidden; any other program shows
 * its name only, since its arguments are not ours to publish.
 */
export function displayCommand(p: ProcInfo, dev: boolean): string {
  if (!dev) return basename(p.comm)
  const w = p.args.split(/\s+/).filter(Boolean).map(maskUrl)
  const out: string[] = []
  for (let i = 0; i < w.length; i++) {
    const x = w[i]
    const eq = x.indexOf('=')
    if (x.startsWith('--')) {
      const name = eq >= 0 ? x.slice(0, eq) : x
      if (SENSITIVE.test(name) && !name.startsWith('--no-')) {
        if (eq >= 0) out.push(`${name}=•••`)
        else {
          out.push(x)
          if (w[i + 1] !== undefined && !w[i + 1].startsWith('--')) { out.push('•••'); i++ }
        }
        continue
      }
    } else if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x.slice(0, eq)) && SENSITIVE.test(x.slice(0, eq))) {
      out.push(`${x.slice(0, eq)}=•••`)
      continue
    }
    out.push(x)
  }
  return out.join(' ')
}

/**
 * Credentials in one argument: the userinfo of a URL starting the word or following an `=`
 * (`DATABASE_URL=…`, `--db=…`), taken as everything up to the last `@` before the first `?` or `#`
 * so a password holding `@` or `/` does not leak while an `@` in the query keeps the host; a
 * scheme-less `user:pass@host`; and sensitive query values.
 */
function maskUrl(x: string): string {
  let out = x.replace(/(^|=)([a-z][a-z0-9+.-]*:\/\/)([^?#]*)@/i, (_m, lead: string, scheme: string, info: string) => {
    const colon = info.indexOf(':')
    return colon >= 0 ? `${lead}${scheme}${info.slice(0, colon)}:•••@` : `${lead}${scheme}•••@`
  })
  if (out === x && !x.includes('://')) out = x.replace(/^([^\s:@/=]+):[^\s@]*@(?=[^\s@]+$)/, '$1:•••@')
  return out.replace(/([?&;])([^=&#\s]*(?:token|secret|key|password|pass|auth|cred)[^=&#\s]*)=[^&#\s]*/gi, '$1$2=•••')
}
