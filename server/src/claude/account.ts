import { execFile } from 'node:child_process'
import { readFile, writeFile, rename } from 'node:fs/promises'
import type { Provider } from '../providers/types.js'
import type { UsageWindow } from './usage.js'
import { tr, type MessageKey } from '../i18n.js'
import { USER_AGENT } from '../version.js'
import { keychainServicesFor } from './configDirs.js'

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
/**
 * Cadence after a 429: the Retry-After the server asks for, never sooner than 30 s and never
 * later than an hour. It used to be capped at two minutes, which ignored a server asking for fifty:
 * the provider came back thirty times inside each penalty and never got out of it.
 */
const RATE_LIMITED_MIN_MS = 30_000
const RATE_LIMITED_MAX_MS = 60 * 60_000

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
  await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, filePath)
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))))
}

interface KeychainToken { token: string; expiresAt: number | null }

/** Reads one keychain item's JSON payload: the access token and when it expires (ms), if it says. */
function parseKeychainItem(raw: string): KeychainToken | null {
  try {
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }
    const t = j?.claudeAiOauth?.accessToken
    if (typeof t !== 'string' || !t) return null
    const e = j.claudeAiOauth?.expiresAt
    return { token: t, expiresAt: typeof e === 'number' && Number.isFinite(e) ? e : null }
  } catch { return null }
}

/** Extracts the Claude Code OAuth access token from the keychain item's JSON payload. */
export function parseKeychainJson(raw: string): string | null {
  return parseKeychainItem(raw)?.token ?? null
}

/**
 * Of several items, the one to use: the latest expiry wins, and an item that does not say when it
 * expires comes after every one that does. The token Claude Code is refreshing is the newest one;
 * an item nobody refreshes any more keeps the expiry it had the day it was abandoned.
 */
export function freshestToken(items: (KeychainToken | null)[]): string | null {
  let best: KeychainToken | null = null
  for (const item of items) {
    if (!item) continue
    if (!best || (item.expiresAt ?? -Infinity) > (best.expiresAt ?? -Infinity)) best = item
  }
  return best?.token ?? null
}

/**
 * Reads the token from the macOS keychain. Never logs or stores it.
 *
 * Tries the default item and the one for each configuration folder sessions were seen running from
 * (see `configDirs.ts`), or only the folder the user picked (`privacy.claudeAccountDir`); the item
 * names are computed here, so an event can only ever point this at another
 * `Claude Code-credentials-<8 hex>` item.
 */
/**
 * When the sign-in of one configuration folder expires (ms), the latest of its items; null when
 * it has no item or none says. An access token past it means nobody signed in with that folder
 * recently: Claude Code refreshes the token only while it runs from it. Never returns the token.
 */
export async function claudeTokenExpiry(
  dir: string,
  read: (service: string) => Promise<string> = (service) => run('/usr/bin/security', ['find-generic-password', '-s', service, '-w']),
): Promise<number | null> {
  let latest: number | null = null
  for (const service of keychainServicesFor([], dir)) {
    try {
      const e = parseKeychainItem(await read(service))?.expiresAt ?? null
      if (e !== null && (latest === null || e > latest)) latest = e
    } catch { /* no such item */ }
  }
  return latest
}

export async function readClaudeOAuthToken(
  configDirs: string[] = [],
  read: (service: string) => Promise<string> = (service) => run('/usr/bin/security', ['find-generic-password', '-s', service, '-w']),
  pinned = 'auto',
): Promise<string | null> {
  const services = keychainServicesFor(configDirs, pinned)
  const items: (KeychainToken | null)[] = []
  for (const service of services) {
    try { items.push(parseKeychainItem(await read(service))) } catch { /* no such item */ }
  }
  return freshestToken(items)
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
  /** The Claude Code configuration folders seen so far, whose keychain items are tried too. */
  configDirs?: () => string[]
  /** `privacy.claudeAccountDir`: `auto`, or the one folder whose account is read. Read on every poll. */
  accountDir?: () => string
} = {}): Provider {
  const fetchFn = opts.fetchFn ?? fetch
  const configDirs = opts.configDirs ?? (() => [])
  const accountDir = opts.accountDir ?? (() => 'auto')
  const readToken = opts.readToken ?? (() => readClaudeOAuthToken(configDirs(), undefined, accountDir()))
  const now = opts.now ?? Date.now
  const filePath = opts.filePath
  const enabled = opts.enabled ?? (() => true)
  let last: AccountUsage = { fiveHour: null, sevenDay: null, limits: [], breakdown: [] }
  let updatedAt: number | null = null
  let noTokenStreak = 0
  let nextTokenAttempt = 0
  // When the last 429 said to come back. A reload or a new subscriber polls at once; this keeps
  // that poll off the network until the penalty is over.
  let rateLimitedUntil = 0
  // The folder the last poll read. Another one is another account: whatever the endpoint or the
  // keychain said about the old one (a penalty, an empty item) says nothing about it.
  let lastDir: string | null = null
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
      const dir = accountDir()
      if (lastDir !== null && dir !== lastDir) {
        noTokenStreak = 0
        nextTokenAttempt = 0
        rateLimitedUntil = 0
        provider.intervalMs = BASE_INTERVAL_MS
      }
      lastDir = dir
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
      if (t < rateLimitedUntil) return fail('rate-limited')
      let res: Response
      try {
        res = await fetchFn(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      } catch (err) { return fail((err as Error).message) }
      if (!res.ok) {
        // Release the socket: nothing reads the error body.
        await res.body?.cancel().catch(() => { /* already closed */ })
        if (res.status === 401) {
          // A 429's long cadence was about a token that worked; this one does not, and the next
          // sign-in should be seen at the normal pace.
          provider.intervalMs = BASE_INTERVAL_MS
          return fail('unauthorized')
        }
        if (res.status === 429) {
          // Other clients share this quota (every Claude Code session polls it), so a 429 can be a
          // busy minute or a long penalty: come back when the server says, and no sooner. Without
          // a usable header, keep the normal cadence rather than guess at a shorter one.
          const header = res.headers.get('retry-after')
          const retryAfter = header ? Number(header) * 1000 : NaN
          provider.intervalMs = Number.isFinite(retryAfter)
            ? Math.min(RATE_LIMITED_MAX_MS, Math.max(RATE_LIMITED_MIN_MS, retryAfter))
            : BASE_INTERVAL_MS
          rateLimitedUntil = t + provider.intervalMs
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
