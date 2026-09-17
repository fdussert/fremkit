import { execFile } from 'node:child_process'
import { readFile, writeFile, rename } from 'node:fs/promises'
import type { Provider } from '../providers/types.js'
import type { UsageWindow } from './usage.js'
import { tr, type MessageKey } from '../i18n.js'
import { USER_AGENT } from '../version.js'

export interface AccountLimit { kind: string; name: string; percent: number; resetsAt: number | null; active: boolean }
export interface AccountUsage { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; limits: AccountLimit[]; breakdown: { name: string; percent: number }[] }
export interface AccountSnapshot extends AccountUsage { available: boolean; stale: boolean; error?: string; updatedAt: number | null }

/**
 * Where the account's usage comes from.
 *
 * This endpoint is what Claude Code itself reads for its `/usage` view. It is undocumented: it
 * can change or disappear without notice, and the provider's job when it does is to report an
 * error and keep showing its last good snapshot.
 *
 * The request identifies itself as Fremkit. An earlier version claimed to be `claude-code/<v>`,
 * which was a lie told to a server that had not asked for one; the honest header works (tested by
 * hand, HTTP 200), and if it ever stops working the answer is to stop asking, not to spoof.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
/**
 * Names for the windows Claude reports without one of its own. Resolved on each poll rather than
 * once, so the language the user picked reaches the widget on the next refresh.
 */
const KIND_KEYS: Record<string, MessageKey> = { session: 'claude.limit.session', weekly_all: 'claude.limit.weeklyAll' }
const kindName = (kind: unknown): string | undefined => {
  const key = KIND_KEYS[String(kind)]
  return key ? tr(undefined, key) : undefined
}
/** Consecutive empty token reads after which the keychain is only probed hourly. */
const NO_TOKEN_STREAK = 3
const NO_TOKEN_BACKOFF_MS = 60 * 60_000
/** Normal cadence; the endpoint is shared with every Claude Code session, so keep it slow. */
const BASE_INTERVAL_MS = 300_000
/** Cadence after a 429: the Retry-After the server asks for, bounded so a slot is caught soon. */
const RATE_LIMITED_MIN_MS = 30_000
const RATE_LIMITED_MAX_MS = 120_000

interface Persisted { last: AccountUsage; updatedAt: number }

/** Loads the last good snapshot written by `persistUsage`; null when absent or unreadable. */
async function loadUsage(filePath: string): Promise<Persisted | null> {
  try {
    const j = JSON.parse(await readFile(filePath, 'utf8')) as Partial<Persisted>
    if (!j.last || typeof j.last !== 'object' || typeof j.updatedAt !== 'number') return null
    const l = j.last
    return {
      last: { fiveHour: l.fiveHour ?? null, sevenDay: l.sevenDay ?? null, limits: Array.isArray(l.limits) ? l.limits : [], breakdown: Array.isArray(l.breakdown) ? l.breakdown : [] },
      updatedAt: j.updatedAt,
    }
  } catch { return null }
}

async function persistUsage(filePath: string, data: Persisted): Promise<void> {
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  await rename(tmp, filePath)
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))))
}

/** Extracts the Claude Code OAuth access token from the keychain item's JSON payload. */
export function parseKeychainJson(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }
    const t = j?.claudeAiOauth?.accessToken
    return typeof t === 'string' && t ? t : null
  } catch { return null }
}

/** Reads the token from the macOS keychain. Never logs or stores it. */
export async function readClaudeOAuthToken(): Promise<string | null> {
  try { return parseKeychainJson(await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])) } catch { return null }
}

function epoch(iso: unknown): number | null {
  if (typeof iso !== 'string') return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}
function window(w: unknown): UsageWindow | null {
  const o = w as { utilization?: unknown; resets_at?: unknown } | null
  if (!o || typeof o.utilization !== 'number') return null
  const resetsAt = epoch(o.resets_at)
  return resetsAt === null ? null : { pct: o.utilization, resetsAt }
}

export function normalizeAccountUsage(json: unknown): AccountUsage {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, any>
  const limits: AccountLimit[] = Array.isArray(j.limits) ? j.limits.filter((l: any) => l && typeof l.percent === 'number').map((l: any) => ({
    kind: String(l.kind ?? 'unknown'),
    name: l.scope?.model?.display_name ?? kindName(l.kind) ?? String(l.kind ?? '?'),
    percent: l.percent,
    resetsAt: epoch(l.resets_at),
    active: Boolean(l.is_active),
  })) : []
  const rows = j.seven_day_breakdown?.rows
  const breakdown = Array.isArray(rows) ? rows.filter((r: any) => r && typeof r.percent === 'number').map((r: any) => ({ name: String(r.display_name ?? r.key ?? '?'), percent: r.percent })) : []
  return { fiveHour: window(j.five_hour), sevenDay: window(j.seven_day), limits, breakdown }
}

export function createClaudeAccountProvider(opts: {
  fetchFn?: typeof fetch
  readToken?: () => Promise<string | null>
  now?: () => number
  filePath?: string
  /**
   * Whether the user has turned this on (`config.privacy.claudeAccountUsage`). Read on every
   * poll, not captured, so the admin's toggle takes effect without a restart. Left out only by
   * the provider's own tests, which are about what it does once it is allowed to run.
   */
  enabled?: () => boolean
} = {}): Provider {
  const fetchFn = opts.fetchFn ?? fetch
  const readToken = opts.readToken ?? readClaudeOAuthToken
  const now = opts.now ?? Date.now
  const filePath = opts.filePath
  const enabled = opts.enabled ?? (() => true)
  let last: AccountUsage = { fiveHour: null, sevenDay: null, limits: [], breakdown: [] }
  let updatedAt: number | null = null
  let noTokenStreak = 0
  let nextTokenAttempt = 0
  // The last good snapshot survives a server restart, so a restart into a rate-limited
  // endpoint still shows the per-model gauges, flagged as stale, instead of nothing.
  const loaded: Promise<void> = filePath
    ? loadUsage(filePath).then((p) => { if (p && updatedAt === null) { last = p.last; updatedAt = p.updatedAt } })
    : Promise.resolve()
  const fail = (error: string): AccountSnapshot => ({ ...last, available: updatedAt !== null, stale: true, error, updatedAt })
  const provider: Provider = {
    channel: 'claude-account',
    intervalMs: BASE_INTERVAL_MS,
    async poll() {
      await loaded
      // Off by default: until the user ticks the box in the admin, the keychain is not read and
      // nothing is sent. The widget shows its last snapshot, if it ever had one, and says why.
      if (!enabled()) return fail('disabled')
      const t = now()
      // Reading the keychain can prompt or simply be pointless when Claude Code
      // is not installed; after a few empty reads, back off to one probe an hour.
      if (noTokenStreak >= NO_TOKEN_STREAK && t < nextTokenAttempt) return fail('no-token')
      const token = await readToken()
      if (!token) {
        noTokenStreak += 1
        if (noTokenStreak >= NO_TOKEN_STREAK) nextTokenAttempt = t + NO_TOKEN_BACKOFF_MS
        return fail('no-token')
      }
      noTokenStreak = 0
      let res: Response
      try {
        res = await fetchFn(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      } catch (err) { return fail((err as Error).message) }
      if (!res.ok) {
        // Release the socket: nothing reads the error body.
        await res.body?.cancel().catch(() => { /* already closed */ })
        if (res.status === 401) return fail('unauthorized')
        if (res.status === 429) {
          // Other clients share this quota (every Claude Code session polls it), so a 429 is
          // usually a busy minute: come back soon, as the server asks, instead of in five minutes.
          const retryAfter = Number(res.headers.get('retry-after')) * 1000
          provider.intervalMs = Math.min(RATE_LIMITED_MAX_MS, Math.max(RATE_LIMITED_MIN_MS, Number.isFinite(retryAfter) ? retryAfter : 0))
          return fail('rate-limited')
        }
        return fail(`http-${res.status}`)
      }
      let json: unknown
      try { json = await res.json() } catch { return fail('invalid-json') }
      last = normalizeAccountUsage(json)
      updatedAt = now()
      provider.intervalMs = BASE_INTERVAL_MS
      if (filePath) await persistUsage(filePath, { last, updatedAt }).catch(() => { /* best effort: the next success retries */ })
      return { ...last, available: true, stale: false, updatedAt } as AccountSnapshot
    },
  }
  return provider
}
