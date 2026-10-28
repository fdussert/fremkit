import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { z } from 'zod'
import { targetPlatform, WINDOWS_CHILD_ENV_KEYS } from '../platform/index.js'
import { HistorySourceSchema } from './sources.js'

export type CodexFailure = 'offline' | 'unauthorized' | 'unsupported' | 'invalid' | 'refused' | 'unconfigured'
/** Fixed reason codes only. Child stderr, protocol error messages and credentials never escape. */
export class CodexError extends Error {
  constructor(public readonly reason: CodexFailure) {
    super(reason)
    this.name = 'CodexError'
  }
}
const requestSchemas: Record<string, z.ZodType> = {
  'account/read': z.object({ refreshToken: z.literal(false) }).strict(),
  'account/rateLimits/read': z
    .object({ supportsLunaReserve: z.literal(false), excludeResetCreditDetails: z.literal(true) })
    .strict(),
  'account/usage/read': z.object({}).strict(),
  'thread/list': z
    .object({
      sourceKinds: z.array(HistorySourceSchema).min(1).max(10),
      useStateDbOnly: z.literal(true),
      limit: z.number().int().min(1).max(50),
      sortKey: z.literal('updated_at'),
      archived: z.literal(false),
    })
    .strict(),
}
export interface ReadTransport {
  write(line: string): void
  onLine(fn: (line: string) => void): void
  onClose(fn: () => void): void
  close(): void
}
export interface CodexClient {
  request(method: string, params: unknown): Promise<unknown>
  supports(method: string): boolean
  close(): void
}
interface ClientOptions {
  methods: ReadonlySet<string>
  connect: () => Promise<ReadTransport>
  timeoutMs?: number
}
interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: CodexError): void
  timer: ReturnType<typeof setTimeout>
}

/** Dedicated child connection. Never connects to a daemon, proxy, socket or desktop process. */
export class CodexReadClient implements CodexClient {
  private wire?: ReadTransport
  private ready?: Promise<void>
  private pending = new Map<number, Pending>()
  private unsupported = new Set<string>()
  private id = 0
  private generation = 0
  constructor(private readonly options: ClientOptions) {}
  supports(method: string): boolean {
    return this.options.methods.has(method) && !this.unsupported.has(method)
  }
  async request(method: string, params: unknown): Promise<unknown> {
    const schema = Object.hasOwn(requestSchemas, method) ? requestSchemas[method] : undefined
    const parsed = schema?.safeParse(params)
    if (!parsed?.success) throw new CodexError('refused')
    if (!this.supports(method) || !this.supports('initialize')) throw new CodexError('unsupported')
    await this.initialize()
    return this.send(method, parsed.data)
  }
  private initialize(): Promise<void> {
    if (this.ready) return this.ready
    const generation = this.generation
    this.ready = (async () => {
      const wire = await this.options.connect()
      if (generation !== this.generation) {
        wire.close()
        throw new CodexError('offline')
      }
      this.wire = wire
      wire.onLine((line) => {
        if (this.wire === wire) this.receive(line)
      })
      wire.onClose(() => {
        if (this.wire === wire) this.close()
      })
      await this.send('initialize', {
        clientInfo: { name: 'fremkit_readonly', title: 'Fremkit', version: '1.0.0' },
        capabilities: { experimentalApi: true, explicitGatewayOauth: true, requestAttestation: false },
      })
      if (this.wire !== wire) throw new CodexError('offline')
      wire.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    })().catch(() => {
      if (generation === this.generation) this.close()
      throw new CodexError('offline')
    })
    return this.ready
  }
  private send(method: string, params: unknown): Promise<unknown> {
    const wire = this.wire
    if (!wire) return Promise.reject(new CodexError('offline'))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), this.options.timeoutMs ?? 15000)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        wire.write(JSON.stringify({ id, method, params }) + '\n')
      } catch {
        this.close()
      }
    })
  }
  private receive(line: string): void {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
      this.close()
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.close()
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.close()
      return
    }
    const m = raw as Record<string, unknown>
    // Deny all server-initiated requests, including approval and token-refresh requests.
    if (typeof m.method === 'string') {
      if (m.id !== undefined && (typeof m.id === 'string' || typeof m.id === 'number')) {
        try {
          this.wire?.write(
            JSON.stringify({
              id: m.id,
              error: { code: -32601, message: 'Read-only client' },
            }) + '\n',
          )
        } catch {
          this.close()
        }
      }
      return
    }
    if (typeof m.id !== 'number') return
    const pending = this.pending.get(m.id)
    if (!pending) return
    this.pending.delete(m.id)
    clearTimeout(pending.timer)
    if (m.error && typeof m.error === 'object') {
      const e = m.error as Record<string, unknown>
      const message = typeof e.message === 'string' ? e.message : ''
      const reason: CodexFailure =
        e.code === -32601
          ? 'unsupported'
          : e.code === 401 ||
              e.code === 403 ||
              /unauthorized|not authenticated|authentication required|not logged in|sign in|invalid.*token|expired.*token/i.test(
                message,
              )
            ? 'unauthorized'
            : 'offline'
      if (reason === 'unsupported') this.unsupported.add(pending.method)
      pending.reject(new CodexError(reason))
    } else if ('result' in m) pending.resolve(m.result)
    else pending.reject(new CodexError('invalid'))
  }
  close(): void {
    const wire = this.wire
    this.wire = undefined
    this.ready = undefined
    this.generation++
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CodexError('offline'))
    }
    this.pending.clear()
    wire?.close()
  }
}

/** An environment variable by name; Windows names ignore case, and an injected plain object does not. */
function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (env[key] !== undefined || targetPlatform(platform) !== 'win32') return env[key]
  const found = Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase())
  return found === undefined ? undefined : env[found]
}

/** Allowlist prevents unknown provider credentials and loader variables from leaking. */
export function safeChildEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  // Codex finds its home through USERPROFILE and APPDATA on Windows.
  for (const key of [
    ...(targetPlatform(platform) === 'win32' ? WINDOWS_CHILD_ENV_KEYS : []),
    'PATH',
    'HOME',
    'CODEX_HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SYSTEMROOT',
    'WINDIR',
  ]) {
    const value = envValue(env, key, platform)
    if (value !== undefined) out[key] = value
  }
  return out
}
const WINDOWS_TRIPLES: Record<string, string> = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }

/**
 * The executable the Codex CLI is run as. On macOS that is `codex` found on `PATH`, as it always
 * was. On Windows `PATH` holds only npm's `codex.cmd` / `codex.ps1` shims, which cannot be spawned
 * without a shell, so the vendored native binary that npm installs under `%APPDATA%` is named
 * directly. Null when it is not there (a shim alone does not count). `CODEX_HOME` moves Codex's
 * data folder, not its binary, so it plays no part here.
 */
export function resolveCodexBinary(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  arch: string = process.arch,
): string | null {
  if (targetPlatform(platform) !== 'win32') return 'codex'
  const triple = WINDOWS_TRIPLES[arch]
  const appData = envValue(env, 'APPDATA', platform)
  if (!triple || !appData || !win32.isAbsolute(appData)) return null
  const binary = win32.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'vendor', triple, 'codex', 'codex.exe')
  return exists(binary) ? binary : null
}
const childArgs = [
  'app-server',
  '--listen',
  'stdio://',
  '-c',
  'features.hooks=false',
  '-c',
  'features.codex_hooks=false',
  '-c',
  'analytics.enabled=false',
]
export interface StdioOptions {
  binary?: string
  env?: NodeJS.ProcessEnv
  spawn?: typeof spawn
}
export function createStdioTransport(options: StdioOptions = {}): ReadTransport {
  const child = (options.spawn ?? spawn)(options.binary ?? 'codex', childArgs, {
    env: safeChildEnv(options.env ?? process.env),
    shell: false,
    cwd: homedir(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let ended = false
  let exited = false
  let stopping = false
  let buffer = ''
  let onLine: (line: string) => void = () => {}
  let onClose = () => {}
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const finish = () => {
    if (ended) return
    ended = true
    onClose()
  }
  child.on('error', () => {
    exited = true
    clearTimeout(killTimer)
    finish()
  })
  child.on('close', () => {
    exited = true
    clearTimeout(killTimer)
    finish()
  })
  child.stdin!.on('error', finish)
  child.stdout!.on('error', finish)
  child.stderr!.on('error', () => {})
  child.stderr!.resume()
  child.stdout!.setEncoding('utf8')
  const transport: ReadTransport = {
    write(line) {
      if (ended || stopping) throw new CodexError('offline')
      child.stdin!.write(line)
    },
    onLine(fn) {
      onLine = fn
    },
    onClose(fn) {
      onClose = fn
      if (ended) fn()
    },
    close() {
      if (exited || stopping) return
      stopping = true
      child.stdin!.end()
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL')
      }, 1000)
      killTimer.unref()
    },
  }
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
      transport.close()
      finish()
      return
    }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) onLine(line)
    }
  })
  return transport
}

/** Schema presence is a candidate capability, not account access. */
export function methodsFromSchema(schema: unknown): Set<string> {
  const found = new Set<string>()
  if (!schema || typeof schema !== 'object') return found
  const root = schema as Record<string, unknown>
  const variants = Array.isArray(root.oneOf) ? root.oneOf : [root]
  for (const variant of variants) {
    const v = variant as { properties?: { method?: { enum?: unknown[] } } }
    for (const m of v?.properties?.method?.enum ?? []) if (typeof m === 'string') found.add(m)
  }
  return found
}
export type SchemaRunner = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<void>
const runSchema: SchemaRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { ...options, cwd: homedir(), timeout: 15000, maxBuffer: 1024 * 1024, shell: false },
      (error) => (error ? reject(new CodexError('unsupported')) : resolve()),
    )
  })
export async function discoverMethods(
  options: { binary?: string; env?: NodeJS.ProcessEnv; run?: SchemaRunner } = {},
): Promise<Set<string>> {
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-codex-schema-'))
  try {
    await (options.run ?? runSchema)(
      options.binary ?? 'codex',
      [
        'app-server',
        'generate-json-schema',
        '--experimental',
        '--out',
        dir,
        '-c',
        'features.hooks=false',
        '-c',
        'features.codex_hooks=false',
      ],
      { env: safeChildEnv(options.env ?? process.env) },
    )
    const methods = methodsFromSchema(JSON.parse(await readFile(join(dir, 'ClientRequest.json'), 'utf8')))
    if (!methods.has('initialize')) throw new CodexError('unsupported')
    return methods
  } catch {
    throw new CodexError('unsupported')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
const methodsCache = new Map<string, { until: number; methods: Promise<Set<string>> }>()
export async function createLocalCodexClient(
  options: StdioOptions & { run?: SchemaRunner; platform?: NodeJS.Platform } = {},
): Promise<CodexClient> {
  // Installed CLI capabilities rarely change while Fremkit runs. Recheck periodically, and
  // never cache injected schema runners used by tests or host integrations.
  const env = safeChildEnv(options.env ?? process.env, options.platform)
  const binary = options.binary ?? resolveCodexBinary(options.env ?? process.env, options.platform)
  // Never through a shell: on Windows a script wrapper cannot be spawned without one, whoever named it.
  if (!binary || (targetPlatform(options.platform) === 'win32' && /\.(cmd|bat|ps1)$/i.test(binary))) throw new CodexError('unsupported')
  options = { ...options, binary }
  const key = JSON.stringify([binary, env.PATH ?? '', env.CODEX_HOME ?? ''])
  let cached = !options.run && !options.spawn ? methodsCache.get(key) : undefined
  if (!cached || cached.until < Date.now()) {
    cached = { until: Date.now() + 10 * 60_000, methods: discoverMethods(options) }
    if (!options.run && !options.spawn) methodsCache.set(key, cached)
  }
  let methods: Set<string>
  try {
    methods = await cached.methods
  } catch {
    methodsCache.delete(key)
    throw new CodexError('unsupported')
  }
  return new CodexReadClient({ methods, connect: async () => createStdioTransport(options) })
}
