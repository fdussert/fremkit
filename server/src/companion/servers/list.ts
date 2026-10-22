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
 * Where `comm` ends and `args` begins in `comm= args=`. A path may hold spaces
 * (`/Applications/Visual Studio Code.app/…`), and ps pads nothing, so the split is found from the
 * args: they begin with argv[0], which is the executable's path or its basename. The shortest
 * leading run of words for which that holds is the comm; when argv[0] was rewritten (a process
 * title) the first word is.
 */
function splitCommArgs(rest: string): { comm: string; args: string } {
  const words = rest.split(' ')
  for (let k = 1; k < words.length; k++) {
    const comm = words.slice(0, k).join(' ')
    const args = words.slice(k).join(' ').trimStart()
    const name = basename(comm)
    const startsWith = (p: string) => args === p || args.startsWith(p + ' ')
    if (startsWith(comm) || startsWith(name)) return { comm, args }
  }
  return { comm: words[0] ?? '', args: words.slice(1).join(' ') }
}

/** `ps -o pid=,ppid=,pgid=,uid=,lstart=,etime=,%cpu=,rss=,comm=,args=` run with `LC_ALL=C` (lstart is five words). */
export function parsePs(out: string): Map<number, ProcInfo> {
  const procs = new Map<number, ProcInfo>()
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!m) continue
    const etimeSec = etimeToSec(m[6])
    if (Number.isNaN(etimeSec)) continue
    const { comm, args } = splitCommArgs(m[9])
    const pid = Number(m[1])
    procs.set(pid, {
      pid, ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]),
      start: m[5].replace(/\s+/g, ' '), etimeSec, cpu: Number(m[7]), rssKb: Number(m[8]), comm, args,
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

/** `[word, label]`: the first rule whose regex finds the word among the command's words wins. */
const TOOLS: Array<[RegExp, string]> = [
  [/^vite(\.js)?$/, 'Vite'],
  [/^next(-server)?$/, 'Next'],
  [/^webpack(-dev-server)?$/, 'webpack'],
  [/^(storybook|start-storybook)$/, 'Storybook'],
  [/^astro$/, 'Astro'],
  [/^nuxt(i)?$/, 'Nuxt'],
  [/^remix(-serve)?$/, 'Remix'],
  [/^(rails|puma)$/, 'Rails'],
  [/^uvicorn$/, 'uvicorn'],
  [/^flask$/, 'Flask'],
]

function knownTool(args: string, comm: string): string | null {
  const words = args.split(/\s+/).filter(Boolean)
  const names = words.map((w) => basename(w))
  for (const [re, label] of TOOLS) if (names.some((n) => re.test(n))) return label
  if (names.includes('runserver')) return 'Django'
  if (/\bhttp\.server\b/.test(args)) return 'http.server'
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
  return c.startsWith('/System/') || c.startsWith('/usr/') || c.startsWith('/Library/Apple/')
}

export function isDockerHolder(p: ProcInfo): boolean {
  const name = basename(p.comm)
  return name.startsWith('com.docker.') || name === 'vpnkit-bridge'
}

const PACKAGE_RUNNERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'turbo', 'nx', 'concurrently'])
const SCRIPT_RUNTIMES = new Set(['node', 'deno'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])

function words(p: ProcInfo): string[] {
  return p.args.split(/\s+/).filter(Boolean)
}

/** Names a package manager or runner: its own executable, argv[0], or (for node/deno) the script it runs. */
function isRunner(p: ProcInfo): boolean {
  const exe = basename(p.comm)
  const w = words(p)
  const argv0 = w.length > 0 ? basename(w[0]) : ''
  if (PACKAGE_RUNNERS.has(exe) || PACKAGE_RUNNERS.has(argv0)) return true
  if (SCRIPT_RUNTIMES.has(exe) || SCRIPT_RUNTIMES.has(argv0)) {
    return w.slice(1).some((x) => PACKAGE_RUNNERS.has(basename(x).replace(/(-cli)?\.(c|m)?js$/, '')))
  }
  return false
}

function isScriptShell(p: ProcInfo): boolean {
  const w = words(p)
  return SHELLS.has(basename(p.comm).replace(/^-/, '')) && w.slice(1).includes('-c')
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
