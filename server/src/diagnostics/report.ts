import { execFile } from 'node:child_process'
import { homedir, hostname, release, userInfo } from 'node:os'
import type { Config, Connection } from '../config/schema.js'
import { CONFIG_VERSION } from '../config/schema.js'
import type { ChannelStatus } from '../providers/registry.js'
import type { WidgetSource } from '../widgets/catalog.js'
import { FREMKIT_VERSION } from '../version.js'
import { hostOf, redact, type RedactionContext } from './redact.js'
import type { LogSource } from './log-tail.js'

/** Lines of the server log a report carries. */
export const LOG_LINES = 200
/** Raw lines read to fill them: request pairs fold into one, and plain asset fetches drop out. */
const RAW_LOG_LINES = 1000

/**
 * Everything a report says, gathered first and rendered second so the rendering can be tested
 * on a fixture. Nothing here is a name the user typed, a URL or a credential: those are the
 * redaction context's business, and never reach the text except through a log line.
 */
export interface DiagnosticsFacts {
  generatedAt: string
  version: string
  install: 'checkout' | 'app'
  dev: boolean
  node: string
  macos: string | null
  darwin: string
  arch: string
  configVersion: number
  theme: string
  locale: string
  secretsBackend: string
  screens: { edge: number; device: number }
  pages: number
  /** Widget instances in the config, placed or in a bar. */
  instances: number
  widgets: { id: string; version: string | null; source: WidgetSource | 'missing'; instances: number }[]
  connections: { type: string; kind: 'coded' | 'declared' | 'unknown'; state: string }[]
  /** Channels that are watched or have polled; the rest are only counted. */
  providers: { channel: string; watched: boolean; state: string }[]
  idleProviders: number
  devices: { paired: number; remoteAccess: boolean }
  log: LogSource | null
}

const SOURCE_LABEL: Record<DiagnosticsFacts['widgets'][number]['source'], string> = {
  builtin: 'built-in',
  installed: 'Sietch',
  dev: 'author folder',
  missing: 'missing',
}

/** The report, as Markdown that reads well both pasted in an issue and as plain text. */
export function renderReport(f: DiagnosticsFacts): string {
  const out: string[] = []
  out.push('## Fremkit diagnostics', '')
  out.push(`- Generated: ${f.generatedAt}`)
  out.push(`- Fremkit: ${f.version} (${f.install}${f.dev ? ', FREMKIT_DEV=1' : ''})`)
  out.push(`- macOS: ${f.macos ?? 'unknown'} (Darwin ${f.darwin}), ${f.arch}`)
  out.push(`- Node: ${f.node}`)
  out.push(`- Config schema: v${f.configVersion}`)
  out.push(`- Theme: ${f.theme}`)
  out.push(`- Language: ${f.locale}`)
  out.push(`- Secrets backend: ${f.secretsBackend}`)
  out.push(`- Screens: ${f.screens.edge + f.screens.device} (edge ${f.screens.edge}, device ${f.screens.device})`)
  out.push(`- Pages: ${f.pages}`)
  out.push(`- Widget instances: ${f.instances}`)
  out.push(`- Paired devices: ${f.devices.paired} (remote access ${f.devices.remoteAccess ? 'on' : 'off'})`)
  out.push('')

  out.push('### Widgets in use', '')
  if (f.widgets.length === 0) out.push('None.')
  else {
    out.push('| Widget | Version | Source | Instances |', '|---|---|---|---|')
    for (const w of f.widgets) out.push(`| ${w.id} | ${w.version ?? '–'} | ${SOURCE_LABEL[w.source]} | ${w.instances} |`)
  }
  out.push('')

  out.push('### Connections', '')
  if (f.connections.length === 0) out.push('None.')
  else {
    out.push('| Type | Kind | State |', '|---|---|---|')
    for (const c of f.connections) out.push(`| ${c.type} | ${c.kind} | ${c.state} |`)
  }
  out.push('')

  out.push('### Providers', '')
  if (f.providers.length === 0) out.push('None active.')
  else {
    out.push('| Channel | Watched | Last poll |', '|---|---|---|')
    for (const p of f.providers) out.push(`| ${p.channel} | ${p.watched ? 'yes' : 'no'} | ${p.state} |`)
  }
  if (f.idleProviders > 0) out.push('', `${f.idleProviders} other channels idle, never polled.`)
  out.push('')

  if (f.log) {
    const where = f.log.kind === 'file' ? 'server.log' : 'since this server started'
    out.push(`### Server log (last ${f.log.lines.length} lines, ${where}, redacted)`, '')
    out.push('```text', ...f.log.lines.map((l) => l.replace(/```/g, "'''")), '```')
  } else {
    out.push('### Server log', '', 'Not available.')
  }
  out.push('')
  return out.join('\n')
}

const LEVELS: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }
/** Keys every pino line carries, or that the compact form already shows. */
const DROPPED_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'req', 'res', 'err', 'reqId', 'responseTime'])

/**
 * A pino JSON line made readable: `time LEVEL message`, the request or response it is about,
 * an error's type and message, and whatever else the line carried, as JSON. A line that is not
 * pino's (a `console.error`, a stack frame) is left as it is.
 */
export function formatLogLine(line: string): string {
  if (!line.startsWith('{')) return line
  let entry: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return line
    entry = parsed as Record<string, unknown>
  } catch {
    return line
  }
  if (typeof entry.level !== 'number' || typeof entry.time !== 'number') return line
  const parts = [new Date(entry.time).toISOString(), LEVELS[entry.level] ?? String(entry.level)]
  if (typeof entry.reqId === 'string') parts.push(entry.reqId)
  if (typeof entry.msg === 'string') parts.push(entry.msg)
  const req = entry.req as { method?: unknown; url?: unknown } | undefined
  if (req && typeof req === 'object') parts.push(`${String(req.method ?? '')} ${String(req.url ?? '')}`.trim())
  const res = entry.res as { statusCode?: unknown } | undefined
  if (res && typeof res === 'object' && res.statusCode !== undefined) {
    const ms = typeof entry.responseTime === 'number' ? ` ${Math.round(entry.responseTime)}ms` : ''
    parts.push(`${String(res.statusCode)}${ms}`)
  }
  const err = entry.err as { type?: unknown; message?: unknown; stack?: unknown } | undefined
  if (err && typeof err === 'object') {
    parts.push(`${String(err.type ?? 'Error')}: ${String(err.message ?? '')}`)
    if (typeof err.stack === 'string') {
      // The first frames say where; the rest is node internals.
      const frames = err.stack.split('\n').slice(1, 4).map((f) => f.trim())
      if (frames.length) parts.push(`(${frames.join(' / ')})`)
    }
  }
  const rest = Object.fromEntries(Object.entries(entry).filter(([k]) => !DROPPED_KEYS.has(k)))
  if (Object.keys(rest).length > 0) parts.push(JSON.stringify(rest))
  return parts.join(' ')
}

/** Paths whose successful fetch says nothing: the UI's files, the widgets', the SDK. */
const QUIET_PATH = /^\/(?:assets\/|widgets\/|fremkit\.js$|favicon|api\/backgrounds\/|api\/favicon|api\/apps\/icon|api\/dock\/icon)/

interface PinoLine { level?: unknown; reqId?: unknown; req?: { method?: unknown; url?: unknown }; res?: { statusCode?: unknown } }

function parsePino(line: string): PinoLine | null {
  if (!line.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as PinoLine : null
  } catch {
    return null
  }
}

/**
 * The log as a report shows it: each request's two lines folded into one (the URL is on the
 * first, the status on the second), a successful fetch of a static file left out, every line made
 * readable by `formatLogLine`, and the last `LOG_LINES` of that kept. Errors and everything that
 * is not a request line are always kept.
 */
export function compactLog(source: LogSource): LogSource {
  const pending = new Map<string, string>()
  const out: string[] = []
  for (const raw of source.lines) {
    const entry = parsePino(raw)
    const reqId = typeof entry?.reqId === 'string' ? entry.reqId : null
    if (entry && reqId && entry.req && typeof entry.req === 'object') {
      pending.set(reqId, `${String(entry.req.method ?? '')} ${String(entry.req.url ?? '')}`)
      continue
    }
    if (entry && reqId && entry.res && typeof entry.res === 'object' && pending.has(reqId)) {
      const request = pending.get(reqId)!
      pending.delete(reqId)
      const status = Number(entry.res.statusCode)
      const path = request.split(' ')[1] ?? ''
      if (status < 400 && QUIET_PATH.test(path)) continue
      const merged = { ...entry, req: { method: request.split(' ')[0], url: path } } as Record<string, unknown>
      out.push(formatLogLine(JSON.stringify(merged)))
      continue
    }
    out.push(formatLogLine(raw))
  }
  return { kind: source.kind, lines: out.slice(-LOG_LINES) }
}

/** What a channel's last poll is reported as. */
function pollState(status: ChannelStatus | undefined): string {
  if (!status || status.lastError === undefined) return 'not polled'
  return status.lastError === null ? 'ok' : `error: ${status.lastError}`
}

/** What the collector needs from the running server. Plain functions, so a test can fake each. */
export interface DiagnosticsDeps {
  config: () => Config
  /** Built-in or installed, and the version, of a widget id the catalogue knows. */
  widget: (id: string) => { version: string; source: WidgetSource } | undefined
  /** Whether a connection type is known, and whether a widget declared it. */
  connectionKind: (type: string) => 'coded' | 'declared' | 'unknown'
  channelFor: (connection: Connection) => string
  secretsFor: (connection: Connection) => Promise<Record<string, string>>
  channels: () => ChannelStatus[]
  devices: () => { name: string }[]
  remoteAccess: () => boolean
  accessToken: string | null
  log?: (count: number) => Promise<LogSource>
  /** Overridable for the tests; the real ones read the Mac. */
  system?: Partial<SystemFacts>
  now?: () => Date
}

export interface SystemFacts {
  node: string
  macos: string | null
  darwin: string
  arch: string
  home: string
  username: string
  machineNames: string[]
  install: 'checkout' | 'app'
  dev: boolean
}

/** A program's trimmed output, or null; never throws, never waits more than two seconds. */
function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 2000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null))
  })
}

export async function readSystemFacts(env: NodeJS.ProcessEnv = process.env): Promise<SystemFacts> {
  const [macos, computerName, localHostName] = await Promise.all([
    run('/usr/bin/sw_vers', ['-productVersion']),
    run('/usr/sbin/scutil', ['--get', 'ComputerName']),
    run('/usr/sbin/scutil', ['--get', 'LocalHostName']),
  ])
  let username = ''
  try { username = userInfo().username } catch { username = '' }
  const host = hostname()
  const names = [host, host.replace(/\.local$/i, ''), computerName, localHostName]
  return {
    node: process.version,
    macos,
    darwin: release(),
    arch: process.arch,
    home: homedir(),
    username,
    machineNames: names.filter((n): n is string => typeof n === 'string' && n.length > 0),
    install: env.FREMKIT_ROOT ? 'app' : 'checkout',
    dev: env.FREMKIT_DEV === '1',
  }
}

/** Counts every instance id a screen shows, grid and bar alike, once per instance. */
function widgetUsage(config: Config): Map<string, number> {
  const counts = new Map<string, number>()
  for (const widget of Object.values(config.widgets)) {
    counts.set(widget.widgetId, (counts.get(widget.widgetId) ?? 0) + 1)
  }
  return counts
}

/**
 * Builds the report: gathers the facts, renders them, and passes the whole text — not only the
 * log — through `redact()`, so nothing a later edit adds to the facts can slip past it.
 */
export async function buildDiagnostics(deps: DiagnosticsDeps): Promise<string> {
  const config = deps.config()
  const system = { ...(await readSystemFactsUnlessGiven(deps.system)) }
  const statuses = new Map(deps.channels().map((s) => [s.channel, s]))

  const connectionChannels = new Map<string, string>()
  const connections: DiagnosticsFacts['connections'] = []
  const secrets: string[] = []
  const hosts: string[] = []
  const names: string[] = []
  const typeCounters = new Map<string, number>()
  for (const connection of config.connections) {
    const kind = deps.connectionKind(connection.type)
    const channel = deps.channelFor(connection)
    const n = (typeCounters.get(connection.type) ?? 0) + 1
    typeCounters.set(connection.type, n)
    connectionChannels.set(channel, `${connection.type} #${n}`)
    const status = statuses.get(channel)
    connections.push({
      type: connection.type,
      kind,
      // A declared connection has no provider: the widget calls it through the proxy.
      state: status ? pollState(status) : kind === 'declared' ? 'used through the proxy' : 'no provider',
    })
    try {
      secrets.push(...Object.values(await deps.secretsFor(connection)))
    } catch {
      // A keychain that will not answer still leaves the shape rules to catch a leak.
    }
    for (const value of Object.values(connection.fields)) {
      const host = hostOf(value)
      if (host) hosts.push(host)
    }
    names.push(connection.name)
  }

  const usage = widgetUsage(config)
  const widgets: DiagnosticsFacts['widgets'] = [...usage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, instances]) => {
      const known = deps.widget(id)
      return { id, version: known?.version ?? null, source: known?.source ?? 'missing', instances }
    })

  // A connection's channel is named after its id, which the user may have derived from a name:
  // shown as its type and rank instead.
  const allChannels = deps.channels()
  const active = allChannels.filter((s) => s.watched || s.lastError !== undefined)
  const providers = active
    .map((s) => ({
      channel: connectionChannels.get(s.channel) ?? (s.channel.includes(':') ? `${s.channel.split(':')[0]}:…` : s.channel),
      watched: s.watched,
      state: pollState(s),
    }))
    .sort((a, b) => a.channel.localeCompare(b.channel))

  const pairedDevices = deps.devices()
  names.push(...pairedDevices.map((d) => d.name))
  names.push(...config.screens.filter((s) => s.kind === 'device').map((s) => s.name))
  if (deps.accessToken) secrets.push(deps.accessToken)

  const facts: DiagnosticsFacts = {
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    version: FREMKIT_VERSION,
    install: system.install,
    dev: system.dev,
    node: system.node,
    macos: system.macos,
    darwin: system.darwin,
    arch: system.arch,
    configVersion: config.version ?? CONFIG_VERSION,
    theme: config.theme,
    locale: config.locale,
    secretsBackend: config.secrets.backend,
    screens: {
      edge: config.screens.filter((s) => s.kind === 'edge').length,
      device: config.screens.filter((s) => s.kind === 'device').length,
    },
    pages: config.screens.reduce((sum, s) => sum + s.pages.length, 0),
    instances: Object.keys(config.widgets).length,
    widgets,
    connections,
    providers,
    idleProviders: allChannels.length - active.length,
    devices: { paired: pairedDevices.length, remoteAccess: deps.remoteAccess() },
    log: deps.log ? await deps.log(RAW_LOG_LINES).then(compactLog, () => null) : null,
  }

  // A name equal to a widget or type id would blank that id out of the tables: the id says
  // nothing about the user, and the name is then not worth more than the id.
  const reserved = new Set([
    ...config.connections.map((c) => c.type),
    ...widgets.map((w) => w.id),
    config.theme,
  ].map((v) => v.toLowerCase()))
  const context: RedactionContext = {
    secrets,
    hosts,
    names: names.filter((n) => !reserved.has(n.trim().toLowerCase())),
    machineNames: system.machineNames,
    home: system.home,
    username: system.username,
  }
  return redact(renderReport(facts), context)
}

async function readSystemFactsUnlessGiven(given: Partial<SystemFacts> | undefined): Promise<SystemFacts> {
  const base = given && isComplete(given) ? given : { ...(await readSystemFacts()), ...given }
  return base as SystemFacts
}

function isComplete(given: Partial<SystemFacts>): given is SystemFacts {
  return ['node', 'macos', 'darwin', 'arch', 'home', 'username', 'machineNames', 'install', 'dev'].every((k) => k in given)
}
