import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import si from 'systeminformation'
import { z } from 'zod'
import type { Provider } from './types.js'

export const localEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const safe: NodeJS.ProcessEnv = {}
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME']) {
    if (env[key] !== undefined) safe[key] = env[key]
  }
  return safe
}

interface Part<T> {
  data: T | null
  stale: boolean
  error: string | null
  updatedAt: number | null
}
const empty = <T>(): Part<T> => ({ data: null, stale: false, error: null, updatedAt: null })
const fresh = <T>(data: T): Part<T> => ({ data, stale: false, error: null, updatedAt: Date.now() })
const failed = <T>(part: Part<T>, error: string): Part<T> => ({ ...part, stale: part.data !== null, error })

function mlxBackend(command: string, params: string): 'oMLX' | 'MLX' | null {
  const executable = basename(command)
  if (executable === 'omlx') return 'oMLX'
  if (executable === 'mlx-server' || executable === 'mlx_lm.server') return 'MLX'
  const launch = params.match(/^(?:-u\s+|-B\s+)*(?:-m\s+)?(?:\S*\/)?(omlx|mlx-server|mlx_lm\.server)(?:\s|$)/)
  return launch?.[1] === 'omlx' ? 'oMLX' : launch ? 'MLX' : null
}
const text = z.string().max(2048)
const identifier = z.string().regex(/^[a-f0-9]{4,64}$/i)
const Container = z.object({ ID: identifier, Names: text, Image: text, State: text, Status: text })
const Stats = z.object({ ID: identifier, CPUPerc: text, MemUsage: text, MemPerc: text, PIDs: text, NetIO: text, BlockIO: text })

type DockerContainer = {
  id: string
  name: string
  image: string
  state: string
  status: string
  stats: { cpu: string; memory: string; memoryPercent: string; pids: string; netIO: string; blockIO: string } | null
}

function jsonLines(raw: string): unknown[] {
  if (Buffer.byteLength(raw) > 1048576) throw new Error('invalid')
  const lines = raw.trim() ? raw.trim().split(/\r?\n/) : []
  return lines.slice(0, 200).map((line) => JSON.parse(line))
}

/** Resolve a local executable from a closed path list, without PATH lookup. */
export async function resolveDockerBinary(canExecute: (path: string) => Promise<void> = (path) => access(path, constants.X_OK)): Promise<string> {
  for (const path of ['/opt/homebrew/bin/docker', '/usr/local/bin/docker', join(homedir(), '.docker/bin/docker')]) {
    try { await canExecute(path); return path } catch { /* Try the next known install. */ }
  }
  throw new Error('unavailable')
}

const dockerRun = async (args: string[]): Promise<string> => {
  const binary = await resolveDockerBinary()
  return new Promise((resolve, reject) => execFile(binary, args, {
    env: localEnv(process.env), timeout: 10000, maxBuffer: 1048576, shell: false,
  }, (error, stdout) => error ? reject(new Error('offline')) : resolve(stdout)))
}

/** Publish local Docker state only, with nullable per-container stats. */
export function createDockerProvider(opts: { run?: (args: string[]) => Promise<string> } = {}): Provider<Part<{ containers: DockerContainer[] }>> {
  const run = opts.run ?? dockerRun
  let last = empty<{ containers: DockerContainer[] }>()
  let generation = 0
  return {
    channel: 'docker-local', intervalMs: 10000,
    stop() { generation++ },
    async poll() {
      const epoch = generation
      try {
        const host = (await run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).trim()
        if (host.length > 4096 || !/^unix:\/\/\/[^\0]+$/.test(host)) {
          if (epoch === generation) last = failed(empty(), 'remote-context')
          return last
        }
        const rows = jsonLines(await run(['--host', host, 'ps', '-a', '--last', '200', '--no-trunc', '--format', '{{json .}}']))
        const containers = rows.map((row) => Container.parse(row))
        const running = containers.filter((row) => row.State === 'running')
        let stats: z.infer<typeof Stats>[] = []
        if (running.length) {
          try {
            stats = jsonLines(await run(['--host', host, 'stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...running.map((row) => row.ID)]))
              .map((row) => Stats.parse(row))
          } catch { /* A container can stop between list and stats. Keep its state. */ }
        }
        const byId = new Map(stats.map((stat) => [stat.ID, stat]))
        const data = { containers: containers.map((row): DockerContainer => {
          const stat = row.State === 'running' ? byId.get(row.ID) : undefined
          return {
            id: row.ID, name: row.Names, image: row.Image, state: row.State, status: row.Status,
            stats: stat ? { cpu: stat.CPUPerc, memory: stat.MemUsage, memoryPercent: stat.MemPerc, pids: stat.PIDs, netIO: stat.NetIO, blockIO: stat.BlockIO } : null,
          }
        }) }
        if (epoch === generation) last = fresh(data)
      } catch (error) {
        const reason = error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid'
          : error instanceof Error && error.message === 'unavailable' ? 'unavailable' : 'offline'
        if (epoch === generation) last = failed(last, reason)
      }
      return last
    },
  }
}

const Model = z.object({
  name: z.string().max(512), size: z.number().nonnegative(),
  size_vram: z.number().nonnegative().nullish().transform((value) => value ?? null),
  context_length: z.number().int().nonnegative().nullish().transform((value) => value ?? null),
  expires_at: z.string().max(100).nullish().transform((value) => value ?? null),
})
interface ModelProcess { pid: number; name: string; command: string; params: string; cpu: number; mem: number; memRss: number }
interface MlxProcess { pid: number; backend: 'MLX' | 'oMLX'; model: string | null; port: number | null; cpu: number; memoryBytes: number }
interface LocalModelsSnapshot {
  installed: Part<z.infer<typeof Model>[]>
  loaded: Part<z.infer<typeof Model>[]>
  mlx: Part<MlxProcess[]>
}

function safeModelLabel(value: string | undefined): string | null {
  if (!value) return null
  const candidate = isAbsolute(value) ? basename(value) : value
  return /^[\w.-]+(?:\/[\w.-]+)?$/.test(candidate) ? candidate : null
}

/** Publish bounded Ollama and local MLX process observations, never prompts or paths. */
export function createLocalModelsProvider(opts: { fetchFn?: typeof fetch; processes?: () => Promise<ModelProcess[]> } = {}): Provider<LocalModelsSnapshot> {
  const fetchFn = opts.fetchFn ?? fetch
  const processes = opts.processes ?? (async () => (await si.processes()).list)
  let installed = empty<z.infer<typeof Model>[]>()
  let loaded = empty<z.infer<typeof Model>[]>()
  let mlx = empty<MlxProcess[]>()
  let generation = 0

  async function models(path: string, previous: Part<z.infer<typeof Model>[]>): Promise<Part<z.infer<typeof Model>[]>> {
    try {
      const response = await fetchFn('http://127.0.0.1:11434/api/' + path, { signal: AbortSignal.timeout(3000), redirect: 'error' })
      if (!response.ok) { await response.body?.cancel(); return failed(previous, 'offline') }
      const reader = response.body?.getReader()
      if (!reader) return failed(previous, 'invalid')
      let raw = '', bytes = 0
      const decoder = new TextDecoder()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 1048576) throw new Error('invalid')
          raw += decoder.decode(chunk.value, { stream: true })
        }
        raw += decoder.decode()
      } finally { await reader.cancel().catch(() => {}) }
      return fresh(z.object({ models: z.array(Model).max(200) }).parse(JSON.parse(raw)).models)
    } catch (error) {
      return failed(previous, error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid' : 'offline')
    }
  }

  return {
    channel: 'local-models', intervalMs: 15000,
    stop() { generation++ },
    async poll() {
      const epoch = generation
      const [nextInstalled, nextLoaded, nextMlx] = await Promise.all([
        models('tags', installed), models('ps', loaded),
        (async (): Promise<Part<MlxProcess[]>> => {
          try {
            const all = await processes()
            return fresh(all.filter((process) => mlxBackend(process.command, process.params) !== null).slice(0, 20).map((process) => {
              const model = process.params.match(/(?:^|\s)--model(?:=|\s+)([^\s]{1,512})/)
              const port = process.params.match(/(?:^|\s)--port(?:=|\s+)(\d{1,5})/)
              const number = port ? Number(port[1]) : null
              return {
                pid: process.pid, backend: mlxBackend(process.command, process.params)!,
                model: safeModelLabel(model?.[1]), port: number && number < 65536 ? number : null,
                cpu: process.cpu, memoryBytes: process.memRss * 1024,
              }
            }))
          } catch { return failed(mlx, 'offline') }
        })(),
      ])
      if (epoch === generation) { installed = nextInstalled; loaded = nextLoaded; mlx = nextMlx }
      return { installed, loaded, mlx }
    },
  }
}
