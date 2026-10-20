import { homedir } from 'node:os'
import { z } from 'zod'
import type { InstanceView } from '../../config/instances.js'
import { execCommand, type Exec } from '../exec.js'
import type { CommandContext, Provider } from '../types.js'
import { APP_IDS, installedApps, openWith, type AppId } from './apps.js'
import { canonicalProject, projectName, shortParent } from './paths.js'
import { createClaudeSource } from './sources/claude.js'
import { createCliSources, resolveBinary as defaultResolveBinary, type ResolveBinary } from './sources/cli.js'
import { createCodexSource } from './sources/codex.js'
import { gitSource } from './sources/git.js'
import { createJetbrainsSource } from './sources/jetbrains.js'
import { createVscodeSource } from './sources/vscode.js'
import { SOURCE_IDS, type RecentProject, type Source, type SourceEntry, type SourceId, type SourceStatus } from './types.js'
import { withTimeout } from './util.js'

export { SOURCE_IDS, APP_IDS }
export type { RecentProject, SourceId, AppId }

export const RECENT_PROJECTS_CHANNEL = 'recent-projects'
export const RECENT_PROJECTS_WIDGET = 'recent-projects'
/** Projects published, whatever a tile shows: a tile picks its own top rows from these. */
export const MAX_PROJECTS = 50
/** The longest one source may take before its last good answer is used instead. */
const SOURCE_TIMEOUT_MS = 10_000
/** How often the list of installed applications is looked at again. */
const APPS_TTL_MS = 10 * 60_000
/** Folders a live source (a terminal pane) is remembered for, per source. */
const LIVE_MEMORY = 50

/** The sources a tile reads when its settings never said: git alone, every other one opt-in. */
export const DEFAULT_SOURCES: readonly SourceId[] = ['git']

/** The settings key of one source's checkbox. */
export function sourceKey(id: SourceId): string {
  return 'source_' + id
}

/** What one tile asked for: the sources it ticked and the git roots it typed. */
export function tileWants(settings: Record<string, unknown>): { sources: Set<SourceId>; gitRoots: string[] } {
  const sources = new Set<SourceId>()
  for (const id of SOURCE_IDS) {
    const v = settings[sourceKey(id)]
    if (v === true || (v === undefined && DEFAULT_SOURCES.includes(id))) sources.add(id)
  }
  const gitRoots: string[] = []
  if (Array.isArray(settings.gitRoots)) {
    for (const item of settings.gitRoots) {
      const p = typeof item === 'string' ? item : (item as { path?: unknown })?.path
      if (typeof p === 'string' && p.trim() && p.length <= 1024) gitRoots.push(p.trim())
    }
  }
  return { sources, gitRoots }
}

/** Every shown tile's wishes merged: a source is read when one tile wants it, never otherwise. */
export function mergedWants(instances: InstanceView[]): { sources: Set<SourceId>; gitRoots: string[] } {
  const sources = new Set<SourceId>()
  const roots = new Set<string>()
  for (const i of instances) {
    const w = tileWants(i.settings)
    w.sources.forEach((s) => sources.add(s))
    w.gitRoots.forEach((r) => roots.add(r))
  }
  return { sources, gitRoots: [...roots].slice(0, 20) }
}

interface Tagged extends SourceEntry {
  source: SourceId
}

/**
 * The entries of every source as one list: each path made canonical (and dropped when it does
 * not exist or sits outside the home folder and the volumes), one row per folder with the newest
 * date any source gave it and every source that named it, newest first, at most `MAX_PROJECTS`.
 * A source with no date sorts after every dated row, in its own order.
 */
export async function mergeEntries(entries: Tagged[], home: string): Promise<RecentProject[]> {
  const canonical = new Map<string, Promise<string | null>>()
  const byPath = new Map<string, RecentProject>()
  for (const e of entries) {
    if (!canonical.has(e.path)) canonical.set(e.path, canonicalProject(e.path, home))
    const path = await canonical.get(e.path)!
    if (!path) continue
    let row = byPath.get(path)
    if (!row) {
      row = { path, name: projectName(path), parent: shortParent(path, home), seenAt: null, sources: [] }
      byPath.set(path, row)
    }
    if (e.seenAt !== null && (row.seenAt === null || e.seenAt > row.seenAt)) row.seenAt = e.seenAt
    if (!row.sources.includes(e.source)) row.sources.push(e.source)
    if (e.gitRoot) {
      row.gitRoots ??= []
      if (!row.gitRoots.includes(e.gitRoot)) row.gitRoots.push(e.gitRoot)
    }
  }
  const rows = [...byPath.values()]
  rows.forEach((r) => r.sources.sort((a, b) => SOURCE_IDS.indexOf(a) - SOURCE_IDS.indexOf(b)))
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.seenAt ?? -Infinity) - (a.r.seenAt ?? -Infinity) || a.i - b.i)
    .map(({ r }) => r)
    .slice(0, MAX_PROJECTS)
}

export interface RecentProjectsSnapshot {
  projects: RecentProject[]
  sources: SourceStatus[]
  /** The applications a project can be opened with on this Mac. */
  apps: AppId[]
  updatedAt: number
}

export interface RecentProjectsOptions {
  /** Every shown tile of the widget, with its saved settings. */
  instances: () => InstanceView[]
  home?: string
  sources?: Source[]
  exec?: Exec
  resolveBinary?: ResolveBinary
  appExists?: (path: string) => Promise<boolean>
  now?: () => number
}

export const OpenSchema = z.object({
  path: z.string().min(1).max(4096),
  app: z.enum(APP_IDS),
})

export function defaultSources(exec: Exec, resolve: ResolveBinary, now: () => number): Source[] {
  return [
    gitSource,
    createClaudeSource(),
    createCodexSource(),
    createVscodeSource('vscode', { fr: 'VS Code', en: 'VS Code' }, 'Code', exec),
    createVscodeSource('cursor', { fr: 'Cursor', en: 'Cursor' }, 'Cursor', exec),
    createJetbrainsSource(),
    ...createCliSources(exec, resolve, now),
  ]
}

/**
 * The `recent-projects` channel: the folders worked in lately, gathered from the sources the
 * shown tiles ticked (git repositories under chosen roots, Claude Code, Codex, VS Code, Cursor,
 * JetBrains IDEs, zoxide, tmux, Herdr), and one command to open one of them.
 *
 * Only paths and dates are read: folder names, modification times, a recent list, the first
 * line of a Codex session — never a transcript, a pane's contents or a file inside a project.
 * A source that fails keeps its last good answer and reports its error beside it, so one broken
 * tool never empties the list.
 */
export function createRecentProjectsProvider(opts: RecentProjectsOptions): Provider & { snapshot(): RecentProjectsSnapshot | null } {
  const home = opts.home ?? homedir()
  const now = opts.now ?? Date.now
  const exec = opts.exec ?? execCommand
  const resolve = opts.resolveBinary ?? defaultResolveBinary
  const sources = opts.sources ?? defaultSources(exec, resolve, now)
  const appDeps = { exec, resolveBinary: resolve, exists: opts.appExists }
  const lastGood = new Map<SourceId, SourceEntry[]>()
  const memory = new Map<SourceId, Map<string, number | null>>()
  let apps: { list: AppId[]; at: number } | null = null
  let last: RecentProjectsSnapshot | null = null

  function remember(id: SourceId, entries: SourceEntry[]): SourceEntry[] {
    const seen = memory.get(id) ?? new Map<string, number | null>()
    memory.set(id, seen)
    for (const e of entries) {
      const before = seen.get(e.path)
      seen.delete(e.path)
      seen.set(e.path, before != null && e.seenAt != null ? Math.max(before, e.seenAt) : e.seenAt ?? before ?? null)
    }
    while (seen.size > LIVE_MEMORY) seen.delete(seen.keys().next().value!)
    return [...seen].map(([path, seenAt]) => ({ path, seenAt }))
  }

  async function poll(): Promise<RecentProjectsSnapshot> {
    const wants = mergedWants(opts.instances())
    const ctx = { home, gitRoots: wants.gitRoots }
    const statuses: SourceStatus[] = []
    const tagged: Tagged[] = []
    await Promise.all(sources.map(async (source) => {
      const enabled = wants.sources.has(source.id)
      const status: SourceStatus = { id: source.id, enabled, available: false, count: 0 }
      statuses.push(status)
      if (!enabled) return
      status.available = await source.available(ctx).catch(() => false)
      if (!status.available) {
        lastGood.delete(source.id)
        return
      }
      let entries: SourceEntry[]
      try {
        entries = await withTimeout(source.list(ctx), SOURCE_TIMEOUT_MS)
        if (source.live) entries = remember(source.id, entries)
        lastGood.set(source.id, entries)
      } catch (err) {
        status.error = (err as Error).message === 'timeout' ? 'timeout' : 'unreadable'
        entries = lastGood.get(source.id) ?? []
      }
      for (const e of entries) tagged.push({ ...e, source: source.id })
    }))
    statuses.sort((a, b) => SOURCE_IDS.indexOf(a.id) - SOURCE_IDS.indexOf(b.id))
    const projects = await mergeEntries(tagged, home)
    for (const s of statuses) s.count = projects.filter((p) => p.sources.includes(s.id)).length
    if (!apps || now() - apps.at > APPS_TTL_MS) apps = { list: await installedApps(appDeps), at: now() }
    last = { projects, sources: statuses, apps: apps.list, updatedAt: now() }
    return last
  }

  return {
    channel: RECENT_PROJECTS_CHANNEL,
    intervalMs: 60_000,
    poll,
    snapshot: () => last,
    commands: {
      /**
       * Opens one listed folder with one application. Local only: it starts a program on this
       * Mac, and the paths are this Mac's — a paired device is refused like any remote caller.
       * The path must be one the last snapshot listed, and still be that folder.
       */
      async open(payload: unknown, ctx?: CommandContext) {
        if (ctx?.loopback !== true || ctx.paired) return { ok: false, error: 'local-only' }
        const parsed = OpenSchema.safeParse(payload)
        if (!parsed.success) return { ok: false, error: 'invalid-request' }
        const { path, app } = parsed.data
        if (!last?.projects.some((p) => p.path === path)) return { ok: false, error: 'unknown-project' }
        if ((await canonicalProject(path, home)) !== path) return { ok: false, error: 'unknown-project' }
        try {
          return await openWith(app, path, appDeps)
        } catch {
          return { ok: false, error: 'failed' }
        }
      },
    },
  }
}
