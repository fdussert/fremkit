import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { createTranscriptScanner, type TodayTokens, type TranscriptScanner } from './transcripts.js'
import { configDirOf, MAX_CONFIG_DIRS } from './configDirs.js'

export interface UsageWindow { pct: number; resetsAt: number }
export interface UsageSnapshot {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  spendLimit: UsageWindow | null
  updatedAt: number | null
  stale: boolean
  today: TodayTokens & { costUsd: number }
}
/** One configuration folder's windows, as its sessions' status lines last reported them. */
export interface FolderWindows { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; updatedAt: number }
interface Persisted { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; spendLimit: UsageWindow | null; updatedAt: number | null; costs: Record<string, number>; costsDay: number; byFolder: Record<string, FolderWindows> }
type RateLimits = Record<string, { used_percentage?: number; resets_at?: number } | undefined>

const STALE_MS = 10 * 60_000
const PERSIST_MS = 10_000

const windowSchema = z.object({ pct: z.number(), resetsAt: z.number() }).nullable()
const persistedSchema = z.object({
  fiveHour: windowSchema.default(null),
  sevenDay: windowSchema.default(null),
  spendLimit: windowSchema.default(null),
  updatedAt: z.number().nullable().default(null),
  costs: z.record(z.string(), z.number()).default({}),
  costsDay: z.number().default(0),
  byFolder: z.record(z.string(), z.object({ fiveHour: windowSchema, sevenDay: windowSchema, updatedAt: z.number() })).default({}),
})

export interface ClaudeUsageOptions {
  filePath: string
  transcriptsDir: string
  /**
   * More transcript trees, asked on every refresh: the `projects` folder of each configuration
   * folder Claude Code sessions were seen running from (`configDirs.ts`).
   */
  moreTranscriptsDirs?: () => string[]
  now?: () => number
  staleMs?: number
  /** Debounce window between two persists; 0 writes on every event. */
  persistMs?: number
  /**
   * Whether to keep each configuration folder's windows apart (`windowsFor`): true while the
   * account usage is off, when the status line is the only source the Claude limits widget has
   * for each account. Asked on every status line; while it is false no folder's state is kept.
   */
  attributeByFolder?: () => boolean
  /** Injectable for tests: counts the actual writes behind the debounce. */
  writeFn?: (path: string, data: string) => Promise<void>
}

export class ClaudeUsage {
  private state: Persisted = { fiveHour: null, sevenDay: null, spendLimit: null, updatedAt: null, costs: {}, costsDay: 0, byFolder: {} }
  private today: TodayTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, sessions: 0, hourly: new Array(24).fill(0) }
  private readonly now: () => number
  private readonly staleMs: number
  /** One long-lived scanner per tree: its per-file cache is what makes the 60 s refresh cheap. */
  private readonly scanners = new Map<string, TranscriptScanner>()
  private readonly persistMs: number
  private readonly writeFn: (path: string, data: string) => Promise<void>
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Serialises persists: every write chains onto the previous one. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly opts: ClaudeUsageOptions) {
    this.now = opts.now ?? Date.now
    this.staleMs = opts.staleMs ?? STALE_MS
    this.persistMs = opts.persistMs ?? PERSIST_MS
    this.writeFn = opts.writeFn ?? ((path, data) => writeFile(path, data, { encoding: 'utf8', mode: 0o600 }))
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.opts.filePath), { recursive: true }).catch(() => { /* created later, or read-only */ })
    try {
      const parsed = persistedSchema.safeParse(JSON.parse(await readFile(this.opts.filePath, 'utf8')))
      if (parsed.success) this.state = parsed.data
    } catch { /* first run or unreadable: keep defaults */ }
  }

  async applyStatusLine(event: { session_id?: string; transcript_path?: unknown; rate_limits?: unknown; cost?: { total_cost_usd?: number } }): Promise<void> {
    const t = this.now()
    const day = dayKey(t)
    if (this.state.costsDay !== day) { this.state.costs = {}; this.state.costsDay = day }
    const rl = event.rate_limits as RateLimits | undefined
    if (rl && typeof rl === 'object') {
      this.state.fiveHour = window(rl.five_hour)
      this.state.sevenDay = window(rl.seven_day)
      this.state.spendLimit = window(rl.spend_limit)
      this.state.updatedAt = t
      this.attribute(event.transcript_path, t)
    }
    if (event.session_id && typeof event.cost?.total_cost_usd === 'number') this.state.costs[event.session_id] = event.cost.total_cost_usd
    this.schedulePersist()
  }

  /**
   * Files the windows just reported under the session's configuration folder. Attributed by
   * folder, which is wrong for a session billed to another account than its folder's (a local
   * auth proxy does that); the account usage, which reads each account's own numbers, is the
   * path that stays right, and while it is on nothing is kept here.
   */
  private attribute(transcriptPath: unknown, t: number): void {
    if (!this.opts.attributeByFolder?.()) {
      this.state.byFolder = {}
      return
    }
    const dir = configDirOf(transcriptPath)
    if (!dir) return
    const { [dir]: _old, ...others } = this.state.byFolder
    // Most recent first, capped like the folders themselves: the hook endpoint takes anything.
    const kept = Object.entries(others).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, MAX_CONFIG_DIRS - 1)
    this.state.byFolder = { [dir]: { fiveHour: this.state.fiveHour, sevenDay: this.state.sevenDay, updatedAt: t }, ...Object.fromEntries(kept) }
  }

  /** The latest windows the status lines of these folders reported, or null when none did. */
  windowsFor(dirs: string[]): FolderWindows | null {
    if (!this.opts.attributeByFolder?.()) return null
    let best: FolderWindows | null = null
    for (const dir of dirs) {
      const w = Object.prototype.hasOwnProperty.call(this.state.byFolder, dir) ? this.state.byFolder[dir] : undefined
      if (w && (!best || w.updatedAt > best.updatedAt)) best = w
    }
    return best
  }

  /** Writes any pending state now. Called on server shutdown. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.persist()
  }

  async refreshToday(): Promise<void> {
    const roots = new Set([this.opts.transcriptsDir, ...(this.opts.moreTranscriptsDirs?.() ?? [])])
    for (const root of this.scanners.keys()) if (!roots.has(root)) this.scanners.delete(root)
    const now = new Date(this.now())
    const total: TodayTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, sessions: 0, hourly: new Array(24).fill(0) }
    for (const root of roots) {
      let scanner = this.scanners.get(root)
      if (!scanner) { scanner = createTranscriptScanner(root); this.scanners.set(root, scanner) }
      const t = await scanner.scanToday(now)
      total.input += t.input; total.output += t.output; total.cacheRead += t.cacheRead; total.cacheWrite += t.cacheWrite
      total.messages += t.messages; total.sessions += t.sessions
      t.hourly.forEach((n, h) => { total.hourly[h] += n })
    }
    this.today = total
  }

  snapshot(): UsageSnapshot {
    const t = this.now()
    const costUsd = this.state.costsDay === dayKey(t) ? Object.values(this.state.costs).reduce((a, b) => a + b, 0) : 0
    return {
      fiveHour: this.state.fiveHour, sevenDay: this.state.sevenDay, spendLimit: this.state.spendLimit,
      updatedAt: this.state.updatedAt,
      stale: this.state.updatedAt === null || t - this.state.updatedAt > this.staleMs,
      today: { ...this.today, costUsd: Math.round(costUsd * 100) / 100 },
    }
  }

  /**
   * A status line arrives on every prompt and tool call, so persisting on each
   * event hammers the disk for no gain: mark the state dirty and let a single
   * timer collapse a burst into one write.
   */
  private schedulePersist(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.persist() }, this.persistMs)
    this.timer.unref?.()
  }

  private persist(): Promise<void> {
    this.queue = this.queue.then(() => this.write()).catch(() => { /* keep the chain alive */ })
    return this.queue
  }

  private async write(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    // The pid keeps two servers sharing a data dir from clobbering each other's tmp file.
    const tmp = `${this.opts.filePath}.${process.pid}.tmp`
    await this.writeFn(tmp, JSON.stringify(this.state))
    await rename(tmp, this.opts.filePath)
  }
}

function window(w: { used_percentage?: number; resets_at?: number } | undefined): UsageWindow | null {
  if (!w || typeof w.used_percentage !== 'number' || typeof w.resets_at !== 'number') return null
  return { pct: w.used_percentage, resetsAt: w.resets_at }
}
function dayKey(t: number): number { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
