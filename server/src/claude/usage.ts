import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { createTranscriptScanner, type TodayTokens, type TranscriptScanner } from './transcripts.js'

export interface UsageWindow { pct: number; resetsAt: number }
export interface UsageSnapshot {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  spendLimit: UsageWindow | null
  updatedAt: number | null
  stale: boolean
  today: TodayTokens & { costUsd: number }
}
interface Persisted { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; spendLimit: UsageWindow | null; updatedAt: number | null; costs: Record<string, number>; costsDay: number }
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
})

export interface ClaudeUsageOptions {
  filePath: string
  transcriptsDir: string
  now?: () => number
  staleMs?: number
  /** Debounce window between two persists; 0 writes on every event. */
  persistMs?: number
  /** Injectable for tests: counts the actual writes behind the debounce. */
  writeFn?: (path: string, data: string) => Promise<void>
}

export class ClaudeUsage {
  private state: Persisted = { fiveHour: null, sevenDay: null, spendLimit: null, updatedAt: null, costs: {}, costsDay: 0 }
  private today: TodayTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, sessions: 0, hourly: new Array(24).fill(0) }
  private readonly now: () => number
  private readonly staleMs: number
  /** One long-lived scanner: its per-file cache is what makes the 60 s refresh cheap. */
  private readonly scanner: TranscriptScanner
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
    this.writeFn = opts.writeFn ?? ((path, data) => writeFile(path, data, 'utf8'))
    this.scanner = createTranscriptScanner(opts.transcriptsDir)
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.opts.filePath), { recursive: true }).catch(() => { /* created later, or read-only */ })
    try {
      const parsed = persistedSchema.safeParse(JSON.parse(await readFile(this.opts.filePath, 'utf8')))
      if (parsed.success) this.state = parsed.data
    } catch { /* first run or unreadable: keep defaults */ }
  }

  async applyStatusLine(event: { session_id?: string; rate_limits?: unknown; cost?: { total_cost_usd?: number } }): Promise<void> {
    const t = this.now()
    const day = dayKey(t)
    if (this.state.costsDay !== day) { this.state.costs = {}; this.state.costsDay = day }
    const rl = event.rate_limits as RateLimits | undefined
    if (rl && typeof rl === 'object') {
      this.state.fiveHour = window(rl.five_hour)
      this.state.sevenDay = window(rl.seven_day)
      this.state.spendLimit = window(rl.spend_limit)
      this.state.updatedAt = t
    }
    if (event.session_id && typeof event.cost?.total_cost_usd === 'number') this.state.costs[event.session_id] = event.cost.total_cost_usd
    this.schedulePersist()
  }

  /** Writes any pending state now. Called on server shutdown. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.persist()
  }

  async refreshToday(): Promise<void> {
    this.today = await this.scanner.scanToday(new Date(this.now()))
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
