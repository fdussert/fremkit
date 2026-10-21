import { execFile as nodeExecFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { safePath } from '../system-path.js'
import type { CommandContext, Provider } from './types.js'

const execFile = promisify(nodeExecFile)
const HISTORY_LIMIT = 50
const COMMAND_TIMEOUT_MS = 5_000
const HistorySchema = z.object({
  historyStartsAt: z.number().finite(),
  projects: z.array(z.object({
    path: z.string().min(1),
    name: z.string().min(1),
    lastSeen: z.number().finite(),
  })).max(HISTORY_LIMIT),
})
const OpenSchema = z.object({
  path: z.string().min(1).max(4096),
  target: z.enum(['herdr', 'claude', 'codex', 'custom']),
  customCommand: z.string().max(120).optional(),
})
const SplitPaneSchema = z.object({ result: z.object({ pane: z.object({ pane_id: z.string().min(1) }) }) })

export interface RecentProject {
  path: string
  name: string
  lastSeen: number
}

interface History {
  historyStartsAt: number
  projects: RecentProject[]
}

interface HerdrPane {
  pane_id?: unknown
  cwd?: unknown
  foreground_cwd?: unknown
}

type Run = (file: string, args: string[]) => Promise<{ stdout: string }>
type ListPanes = () => Promise<{ panes: HerdrPane[] }>
type ExecutableName = 'herdr' | 'claude' | 'codex'
type ResolveExecutable = (name: ExecutableName) => Promise<string | undefined>

const EXECUTABLE_CANDIDATES: Record<ExecutableName, (home: string) => string[]> = {
  herdr: (home) => [join(home, '.local/bin/herdr'), join(home, '.cargo/bin/herdr'), '/opt/homebrew/bin/herdr', '/usr/local/bin/herdr'],
  claude: (home) => [join(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  codex: (home) => [join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
}

export interface RecentProjectsOptions {
  filePath: string
  listPanes?: ListPanes
  run?: Run
  resolveExecutable?: ResolveExecutable
  now?: () => number
}

const defaultRun: Run = async (file, args) => {
  const result = await execFile(file, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: safePath(process.env.PATH) },
  })
  return { stdout: result.stdout }
}

async function isExecutableFile(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false
  try {
    const [info] = await Promise.all([stat(path), access(path, constants.X_OK)])
    return info.isFile()
  } catch {
    return false
  }
}

async function resolveKnownExecutable(name: ExecutableName): Promise<string | undefined> {
  for (const candidate of EXECUTABLE_CANDIDATES[name](homedir())) {
    if (await isExecutableFile(candidate)) return candidate
  }
  return undefined
}

function parsePaneList(stdout: string): { panes: HerdrPane[] } {
  const parsed: unknown = JSON.parse(stdout)
  const panes = z.object({ result: z.object({ panes: z.array(z.record(z.string(), z.unknown())) }) })
    .or(z.object({ panes: z.array(z.record(z.string(), z.unknown())) }))
    .parse(parsed)
  return { panes: 'result' in panes ? panes.result.panes : panes.panes }
}

function defaultListPanes(run: Run, herdrPath: string): ListPanes {
  return async () => parsePaneList((await run(herdrPath, ['pane', 'list'])).stdout)
}

async function readHistory(filePath: string, now: () => number): Promise<History> {
  try {
    return HistorySchema.parse(JSON.parse(await readFile(filePath, 'utf8')))
  } catch {
    return { historyStartsAt: now(), projects: [] }
  }
}

async function saveHistory(filePath: string, history: History): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tempPath, JSON.stringify(history, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, filePath)
}

async function canonicalDirectory(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined
  try {
    const canonical = await realpath(value)
    return (await stat(canonical)).isDirectory() ? canonical : undefined
  } catch {
    return undefined
  }
}

async function observedDirectories(listPanes: ListPanes): Promise<string[]> {
  const { panes } = await listPanes()
  const paths = await Promise.all(panes.map(async (pane) =>
    (await canonicalDirectory(pane.foreground_cwd)) ?? canonicalDirectory(pane.cwd),
  ))
  return [...new Set(paths.filter((path): path is string => Boolean(path)))]
}

async function createProjectPane(
  run: Run,
  herdrPath: string,
  projectPath: string,
  target?: { executable: string; searchPath: string },
): Promise<{ ok: boolean; error?: string }> {
  const args = ['pane', 'split', '--cwd', projectPath, '--direction', 'right', '--no-focus']
  if (target) args.push('--env', `PATH=${target.searchPath}`)
  const split = await run(herdrPath, args)
  let splitResult: unknown
  try {
    splitResult = JSON.parse(split.stdout)
  } catch {
    return { ok: false, error: 'new-pane-not-found' }
  }
  const parsedSplit = SplitPaneSchema.safeParse(splitResult)
  if (!parsedSplit.success) return { ok: false, error: 'new-pane-not-found' }
  const paneId = parsedSplit.data.result.pane.pane_id
  if (target) await run(herdrPath, ['pane', 'run', paneId, basename(target.executable)])
  return { ok: true }
}

/**
 * Remembers only working-directory paths reported by Herdr panes. It does not read pane output,
 * shell history, Claude/Codex transcripts, or any other session contents.
 */
export function createRecentProjectsProvider(options: RecentProjectsOptions): Provider {
  const now = options.now ?? Date.now
  const run = options.run ?? defaultRun
  const resolveExecutable = options.resolveExecutable ?? resolveKnownExecutable

  return {
    channel: 'recent-projects',
    intervalMs: 30_000,
    async poll() {
      const history = await readHistory(options.filePath, now)
      const observedAt = now()
      const herdrPath = options.listPanes ? undefined : await resolveExecutable('herdr')
      if (!options.listPanes && !herdrPath) return { ...history, coverage: 'herdr-cwd-since-first-observation', error: 'herdr-unconfigured' }
      let observed: string[]
      try {
        observed = await observedDirectories(options.listPanes ?? defaultListPanes(run, herdrPath!))
      } catch {
        return { ...history, coverage: 'herdr-cwd-since-first-observation', error: 'herdr-unavailable' }
      }
      const byPath = new Map(history.projects.map((project) => [project.path, project]))
      for (const path of observed) byPath.set(path, { path, name: basename(path) || path, lastSeen: observedAt })
      const projects = [...byPath.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, HISTORY_LIMIT)
      const next = { historyStartsAt: history.historyStartsAt, projects }
      await saveHistory(options.filePath, next)
      return { ...next, coverage: 'herdr-cwd-since-first-observation' }
    },
    commands: {
      async open(payload: unknown, context?: CommandContext) {
        if (!context?.loopback) return { ok: false, error: 'loopback-required' }
        const parsed = OpenSchema.safeParse(payload)
        if (!parsed.success) return { ok: false, error: 'invalid-request' }
        const { path, target } = parsed.data
        const history = await readHistory(options.filePath, now)
        const project = history.projects.find((item) => item.path === path)
        const canonical = await canonicalDirectory(path)
        if (!project || canonical !== path) return { ok: false, error: 'project-not-in-history' }
        if (target === 'custom') return { ok: false, error: 'custom-target-unsupported' }
        const herdrPath = await resolveExecutable('herdr')
        if (!herdrPath) return { ok: false, error: 'herdr-unconfigured' }
        const targetExecutable = target === 'herdr' ? undefined : await resolveExecutable(target)
        if (target !== 'herdr' && !targetExecutable) return { ok: false, error: `${target}-unconfigured` }
        try {
          return await createProjectPane(run, herdrPath, path, targetExecutable
            ? { executable: targetExecutable, searchPath: safePath([dirname(targetExecutable), process.env.PATH ?? ''].join(':')) }
            : undefined)
        } catch {
          return { ok: false, error: 'herdr-unavailable' }
        }
      },
    },
  }
}
