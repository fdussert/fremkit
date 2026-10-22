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

/**
 * Whether a listener is a dev server. A program inside an app bundle (`.app`, `.sdPlugin`,
 * `.bundle`, `.plugin`) or working in the home's `~/Library` never is, runtimes included: Stream
 * Deck runs its plugins with its own node from `~/Library/Application Support`. The one bundle that
 * is a runtime is a framework Python's launcher, `Python.framework/Versions/x/Resources/Python.app`
 * (Homebrew, python.org and the Command Line Tools all run `python3` through it).
 */
export function isDevRuntime(p: ProcInfo, cwd: string | null, home: string): boolean {
  if (inBundle(p.comm) || (cwd !== null && underLibrary(cwd, home))) return false
  if (RUNTIMES.test(basename(p.comm))) return true
  if (knownTool(p.args, p.comm) !== null) return true
  return builtInFolder(p.comm, cwd)
}

function inBundle(comm: string): boolean {
  const parts = comm.split('/')
  return parts.some((part, i) => {
    if (!/\.(app|sdPlugin|bundle|plugin)$/i.test(part)) return false
    const frameworkLauncher = /\.app$/i.test(part) && parts[i - 1] === 'Resources' && parts.slice(0, i - 1).some((x) => /\.framework$/i.test(x))
    return !frameworkLauncher
  })
}

function underLibrary(cwd: string, home: string): boolean {
  const lib = `${home.replace(/\/+$/, '')}/Library`
  return cwd === lib || cwd.startsWith(lib + '/')
}

/** Folders that hold installed software, never a project being built. */
const INSTALLED = /^(\/Users\/[^/]+)?\/Library(\/|$)|^\/(Applications|opt\/homebrew|usr\/local)(\/|$)/
/** Where a build puts its binary, relative to the project folder. */
const BUILD_OUTPUT = /^(?:(?:target\/(?:debug|release)|bin|build|dist|out)\/)?[^/]+$/

/** A Go or Rust server built in the folder it runs from: the binary directly in it or in a build output folder. */
function builtInFolder(comm: string, cwd: string | null): boolean {
  if (cwd === null || cwd.length <= 1 || INSTALLED.test(cwd)) return false
  const dir = cwd.endsWith('/') ? cwd : cwd + '/'
  return comm.startsWith(dir) && BUILD_OUTPUT.test(comm.slice(dir.length))
}

/** Programs shipped with macOS: Open only, never a kill. `/usr/local/` is the user's. */
export function isSystemProcess(p: ProcInfo): boolean {
  const c = p.comm
  if (c.startsWith('/usr/local/')) return false
  return ['/System/', '/usr/', '/bin/', '/sbin/', '/Library/Apple/'].some((d) => c.startsWith(d))
}

/** Fremkit Helper, which supervises this server: never listed, never signalled. */
export function isHelper(p: Pick<ProcInfo, 'comm'>): boolean {
  return basename(p.comm) === 'FremkitHelper'
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
 * A line of a server's output with what `displayCommand` hides hidden there too, its spacing kept:
 * URL credentials, the value of a sensitive `KEY=value` or `--key=value` word, and a bearer or basic
 * credential, and a sensitive name followed by a colon. A dev server may print its `DATABASE_URL` or
 * its whole environment.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 •••')
    // `NAME: value` in its printed forms: util.inspect, JSON, YAML or dotenv-ish (`maskColonValues`).
    .split('\n').map(maskColonValues).join('\n')
    .replace(/\S+/g, (word) => {
      const x = maskUrl(word)
      const eq = x.indexOf('=')
      if (eq <= 0) return x
      const name = x.slice(0, eq).replace(/^--?/, '')
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) && SENSITIVE.test(name) && !name.startsWith('no-')) return `${x.slice(0, eq)}=•••`
      return x
    })
}

/** One part of a name that marks it secret: `API_KEY`, `apiKey`, `x-auth-token`, `passWord`, `db.credentials`. */
const SENSITIVE_PART = /^(token|secret|key|apikey|password|passwd|pass|passphrase|auth|authorization|cred|creds|credential|credentials)s?$/i
/** Words strong enough to count inside a one-word name; `key`, `pass` and `auth` only count whole. */
const STRONG = 'token|secret|password|passwd|apikey|credentials?'
/** A one-word name ending in a strong word: `authtoken` (ngrok's own key), `accesstoken`, `clientsecret`. */
const STRONG_END = new RegExp(`(${STRONG})s?$`, 'i')
/** A strong word followed by another sensitive word: `secretkey`, `tokensecret`; never `tokenizer`. */
const STRONG_START = new RegExp(`^(${STRONG})(${STRONG}|key|pass|auth|passphrase)s?$`, 'i')

/**
 * Whether a name holds a sensitive word as one of its parts, split on `_`, `-`, `.` and camelCase
 * boundaries, or holds a strong one inside a one-word part (`authtoken`, `SECRETKEY`); a word
 * merely containing a word (`passed`, `monkey`, `keyboard`, `tokenizer`) does not count. Used for `NAME: value`, where the name is often a plain word of a log line.
 */
function sensitiveName(name: string): boolean {
  return name.split(/[_.-]+/).flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .some((part) => SENSITIVE_PART.test(part) || STRONG_END.test(part) || STRONG_START.test(part))
}

/**
 * `NAME: value` with a sensitive name, in one line: util.inspect (`SECRET_TOKEN: 'x',`), JSON
 * (`"SECRET_TOKEN":"x"`), YAML or dotenv-ish (`API_KEY: x`). A quoted value keeps its quotes; an
 * unquoted one is hidden to the end of the line, or to the next `,` or `}` inside braces, so a
 * value with spaces never shows its tail.
 */
function maskColonValues(line: string): string {
  const re = /(["']?)\b([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*:\s*)/g
  let out = ''
  let last = 0
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    const start = m.index + m[0].length
    const rest = line.slice(start)
    if (!sensitiveName(m[2]) || rest === '' || rest.startsWith('//')) continue
    let end: number
    let mask: string
    const quote = rest[0]
    if (quote === '"' || quote === "'") {
      let i = 1
      while (i < rest.length && rest[i] !== quote) i += rest[i] === '\\' ? 2 : 1
      end = start + Math.min(i + 1, rest.length)
      mask = i < rest.length ? `${quote}•••${quote}` : `${quote}•••`
    } else {
      const before = line.slice(0, m.index)
      const inBraces = (before.match(/\{/g)?.length ?? 0) > (before.match(/\}/g)?.length ?? 0)
      const stop = inBraces ? rest.search(/[,}]/) : -1
      // Inside braces the space before the `,` or `}` stays, as the value's own spacing.
      end = stop < 0 ? line.length : start + stop - (rest.slice(0, stop).length - rest.slice(0, stop).trimEnd().length)
      mask = '•••'
    }
    out += line.slice(last, start) + mask
    last = end
    re.lastIndex = Math.max(end, re.lastIndex)
  }
  return out + line.slice(last)
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
