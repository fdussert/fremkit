import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { z } from 'zod'
import type { Provider } from '../providers/types.js'
import type { FolderWindows, UsageWindow } from './usage.js'
import { tr, type MessageKey } from '../i18n.js'
import { USER_AGENT } from '../version.js'
import { keychainServicesFor } from './configDirs.js'
import type { DiscoveredAccount } from './accounts.js'
import { gateAccountEmail, withAccountEmail } from '../privacy.js'

export interface AccountLimit { kind: string; name: string; percent: number; resetsAt: number | null; active: boolean }
export interface AccountUsage { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; limits: AccountLimit[]; breakdown: { name: string; percent: number }[] }
/** The two windows a row shows. `null`: no window running (nothing used since the last reset). */
export interface AccountWindows { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null }

/** One account as the `claude-account` channel publishes it: one row of the Claude limits widget. */
export interface AccountRow extends AccountWindows {
  /** Stable and opaque: a hash of the account uuid, never the uuid itself. */
  key: string
  /** The user's name for the account, else its plan, else "Claude". Never an e-mail address. */
  name: string
  /** True when `name` is the user's own. */
  named: boolean
  plan: string | null
  /** Some numbers were read once (now or before a restart). */
  available: boolean
  /** The numbers are not from a poll that just succeeded: shown dimmed. */
  stale: boolean
  /** Why the last read failed: `rate-limited`, `unauthorized`, `expired`, `no-token`, … */
  error?: string
  /** When the numbers were read (ms), null when never. */
  updatedAt: number | null
  /** Only with `privacy.showAccountEmail` on (`withAccountEmail`). */
  email?: string
}

export interface AccountsSnapshot {
  /** `account`: each account's own API polls. `status-line`: the sessions' status lines, by folder. */
  source: 'account' | 'status-line'
  accounts: AccountRow[]
  /**
   * For the editor's health (`config:health` reads one code per channel): `disabled` while the
   * account usage is off, the accounts' error when every one of them fails, `partial-<n>` when
   * `n` of them do and the others do not. Never which ones.
   */
  error?: string
}

/** What the settings window shows beside each account's name field. Admin only. */
export interface AccountSummary { uuid: string; plan: string | null; org: string | null; lastSeen: number | null }

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
/** Consecutive empty token reads after which an account's keychain items are only probed hourly. */
const NO_TOKEN_STREAK = 3
const NO_TOKEN_BACKOFF_MS = 60 * 60_000
/**
 * Each account's cadence; the endpoint is shared with every Claude Code session of that account,
 * so keep it slow. Not faster than when there was one account: each account has its own clock.
 */
const BASE_INTERVAL_MS = 300_000
/**
 * The provider's own tick. At most one account is asked per tick, the one due first, so the polls
 * of several accounts are spread out rather than fired together; between two, the tick only
 * re-reads the folders' `.claude.json` (cached by modification time) and answers from memory.
 */
const TICK_MS = 20_000
/**
 * Cadence after a 429: the Retry-After the server asks for, never sooner than 30 s and never
 * later than an hour. It used to be capped at two minutes, which ignored a server asking for fifty:
 * the provider came back thirty times inside each penalty and never got out of it.
 */
const RATE_LIMITED_MIN_MS = 30_000
const RATE_LIMITED_MAX_MS = 60 * 60_000
/**
 * An account stays listed while one of its folders sent an event within this, or its usage was
 * read within this. The keychain of a Mac that tried profiles holds items for folders nobody opens
 * any more; their last event is older than this, their tokens long expired, and they get no row.
 */
export const ACCOUNT_ALIVE_MS = 7 * 24 * 60 * 60_000
/** The status line's numbers are old after this, as in `usage.ts`. */
const STATUS_LINE_STALE_MS = 10 * 60_000
/** At most this many accounts' snapshots are kept on disk. */
const MAX_PERSISTED = 16
/** Errors that are a state, not a failure: an account with no session running. */
const NOT_FAILING = new Set(['expired'])

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))))
}
const readKeychain = (service: string): Promise<string> => run('/usr/bin/security', ['find-generic-password', '-s', service, '-w'])

export interface KeychainToken { token: string; expiresAt: number | null }

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
export function freshestItem(items: (KeychainToken | null)[]): KeychainToken | null {
  let best: KeychainToken | null = null
  for (const item of items) {
    if (!item) continue
    if (!best || (item.expiresAt ?? -Infinity) > (best.expiresAt ?? -Infinity)) best = item
  }
  return best
}

export function freshestToken(items: (KeychainToken | null)[]): string | null {
  return freshestItem(items)?.token ?? null
}

/**
 * One account's token, from the keychain items of the folders signed in to it, the freshest
 * winning: two folders on one account are refreshed by whichever ran last. Never logs or stores
 * it. The item names are computed here, so an event can only ever point this at another
 * `Claude Code-credentials-<8 hex>` item; it is read with `security … -w`, the token never on a
 * command line. Read only: Fremkit never refreshes a token and never writes to these items, since
 * rotating the refresh token there could sign Claude Code out of that account.
 */
export async function readAccountToken(
  dirs: string[],
  read: (service: string) => Promise<string> = readKeychain,
): Promise<KeychainToken | null> {
  const services = [...new Set(dirs.flatMap((dir) => keychainServicesFor([], dir)))]
  const items: (KeychainToken | null)[] = []
  for (const service of services) {
    try { items.push(parseKeychainItem(await read(service))) } catch { /* no such item */ }
  }
  return freshestItem(items)
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

/**
 * The two windows a row shows: 5 hours from `five_hour`, else the `session` limit; 7 days from
 * `seven_day`, else the `weekly_all` limit. Per-model limits are not drawn any more. A window the
 * endpoint answers `null` for is no window running: an empty gauge, not an error.
 */
export function accountWindows(usage: AccountUsage): AccountWindows {
  const fromLimit = (kind: string): UsageWindow | null => {
    const l = usage.limits.find((x) => x.kind === kind)
    return l && l.resetsAt !== null ? { pct: l.percent, resetsAt: l.resetsAt } : null
  }
  return { fiveHour: usage.fiveHour ?? fromLimit('session'), sevenDay: usage.sevenDay ?? fromLimit('weekly_all') }
}

/**
 * A window whose reset time has passed is reset: 0 % and no reset time, which is known without a
 * new poll. Without it an idle account's row would go on showing its old percentage for days.
 */
export function withoutPassedResets(w: AccountWindows, now: number): AccountWindows {
  const live = (x: UsageWindow | null): UsageWindow | null => (x && x.resetsAt * 1000 > now ? x : null)
  return { fiveHour: live(w.fiveHour), sevenDay: live(w.sevenDay) }
}

/** What widgets know an account by: stable across restarts, and not the uuid. */
export function accountKey(uuid: string): string {
  return createHash('sha256').update(`fremkit:claude-account:${uuid}`).digest('hex').slice(0, 16)
}

/** The widget's error code for a request that never got an answer. */
const OFFLINE = 'offline'

const windowSchema = z.object({ pct: z.number(), resetsAt: z.number() }).nullable()
const persistedSchema = z.object({
  version: z.literal(2),
  accounts: z.record(z.string().regex(/^[0-9a-f-]{8,64}$/), z.object({
    fiveHour: windowSchema.default(null),
    sevenDay: windowSchema.default(null),
    updatedAt: z.number().nullable().default(null),
    firstSeen: z.number(),
  })),
})

interface AccountState {
  last: AccountWindows | null
  updatedAt: number | null
  /** When this server first saw the account: what orders the rows, so they never swap. */
  firstSeen: number
  /** When the account may next be asked. 0: at the next tick. */
  nextPollAt: number
  noTokenStreak: number
  /** The last read's failure; absent after a success. */
  error?: string
  /** The numbers come from a read of this server's, not from the file a restart left. */
  fresh: boolean
}

export interface ClaudeAccountProviderOptions {
  fetchFn?: typeof fetch
  now?: () => number
  /** Where each account's last good snapshot and first-seen time are kept (0600). */
  filePath?: string
  /**
   * Whether the user has turned this on (`config.privacy.claudeAccountUsage`). Read on every
   * poll, not captured, so the admin's toggle takes effect without a restart. Off, no keychain
   * item is read and nothing is sent: the rows come from the status line, by folder.
   */
  enabled?: () => boolean
  /** The accounts of this Mac's Claude Code folders (`ClaudeAccountDiscovery.list`). */
  discover?: () => Promise<DiscoveredAccount[]>
  /** Test seam for `readAccountToken`. */
  readToken?: (dirs: string[]) => Promise<KeychainToken | null>
  /** `privacy.claudeAccountNames`, read on every poll. */
  names?: () => Record<string, string>
  /** `privacy.showAccountEmail`, read on every poll. */
  showEmail?: () => boolean
  /** The status line's latest windows for some folders (`ClaudeUsage.windowsFor`): the rows' numbers while off. */
  statusLine?: (dirs: string[]) => FolderWindows | null
}

export type ClaudeAccountProvider = Provider<AccountsSnapshot> & {
  /** The accounts listed now, for the settings window's name fields. Reads no keychain item. */
  accounts(): Promise<AccountSummary[]>
}

/**
 * The `claude-account` channel: one row per claude.ai account in use on this Mac, each with its
 * own numbers. Several accounts run at once when Claude Code runs from several configuration
 * folders (a terminal with profiles); each account is polled with its own token, on its own
 * clock, with its own back-off and its own last good snapshot, so a row's numbers are never
 * another account's. A row that cannot be sure keeps its last numbers, dimmed, with the reason.
 */
export function createClaudeAccountProvider(opts: ClaudeAccountProviderOptions = {}): ClaudeAccountProvider {
  const fetchFn = opts.fetchFn ?? fetch
  const now = opts.now ?? Date.now
  const filePath = opts.filePath
  const enabled = opts.enabled ?? (() => true)
  const discover = opts.discover ?? (async () => [])
  const readToken = opts.readToken ?? ((dirs: string[]) => readAccountToken(dirs))
  const names = opts.names ?? ((): Record<string, string> => ({}))
  const showEmail = opts.showEmail ?? (() => false)
  const statusLine = opts.statusLine ?? (() => null)
  const states = new Map<string, AccountState>()
  let dirty = false
  let writing: Promise<void> = Promise.resolve()

  // Each account's last good snapshot survives a restart, so a restart into a rate-limited
  // endpoint still shows the gauges, flagged as stale, instead of nothing. A file in the shape
  // of the single-account days is not read: it cannot say whose numbers it holds.
  const loaded: Promise<void> = filePath
    ? readFile(filePath, 'utf8').then((text) => {
      const parsed = persistedSchema.safeParse(JSON.parse(text))
      if (!parsed.success) return
      for (const [uuid, p] of Object.entries(parsed.data.accounts)) {
        if (states.has(uuid)) continue
        const last = p.updatedAt === null ? null : { fiveHour: p.fiveHour, sevenDay: p.sevenDay }
        states.set(uuid, { last, updatedAt: p.updatedAt, firstSeen: p.firstSeen, nextPollAt: 0, noTokenStreak: 0, fresh: false })
      }
    }).catch(() => { /* first run or unreadable */ })
    : Promise.resolve()

  function persist(t: number): Promise<void> {
    if (!filePath || !dirty) return writing
    dirty = false
    const kept = [...states.entries()]
      .filter(([, s]) => s.updatedAt !== null ? t - s.updatedAt < ACCOUNT_ALIVE_MS : t - s.firstSeen < ACCOUNT_ALIVE_MS)
      .sort(([, a], [, b]) => a.firstSeen - b.firstSeen)
      .slice(-MAX_PERSISTED)
    const data = JSON.stringify({
      version: 2,
      accounts: Object.fromEntries(kept.map(([uuid, s]) => [uuid, {
        fiveHour: s.last?.fiveHour ?? null, sevenDay: s.last?.sevenDay ?? null, updatedAt: s.updatedAt, firstSeen: s.firstSeen,
      }])),
    })
    writing = writing.then(async () => {
      const tmp = `${filePath}.${process.pid}.tmp`
      await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, filePath)
    }).catch(() => { /* best effort: the next change writes again */ })
    return writing
  }

  function stateOf(uuid: string, t: number): AccountState {
    let s = states.get(uuid)
    if (!s) {
      s = { last: null, updatedAt: null, firstSeen: t, nextPollAt: 0, noTokenStreak: 0, fresh: false }
      states.set(uuid, s)
      dirty = true
    }
    return s
  }

  /** The accounts that get a row, oldest first: rows never swap places on their own. */
  async function listed(t: number, on: boolean): Promise<{ account: DiscoveredAccount; state: AccountState }[]> {
    const found = await discover()
    return found
      .map((account) => ({ account, state: stateOf(account.uuid, t) }))
      .filter(({ account, state }) =>
        (account.lastSeen !== null && t - account.lastSeen < ACCOUNT_ALIVE_MS)
        || (on && state.updatedAt !== null && t - state.updatedAt < ACCOUNT_ALIVE_MS))
      .sort((a, b) => a.state.firstSeen - b.state.firstSeen || (a.account.uuid < b.account.uuid ? -1 : 1))
  }

  /** Asks the endpoint about one account, with that account's token, and files the outcome. */
  async function read(account: DiscoveredAccount, s: AccountState, t: number): Promise<void> {
    const fail = (error: string, retryIn = BASE_INTERVAL_MS): void => { s.error = error; s.nextPollAt = t + retryIn }
    const item = await readToken(account.dirs)
    if (!item) {
      // Reading the keychain can prompt, or be pointless for a folder signed out since; after a
      // few empty reads, this account's items are probed once an hour.
      s.noTokenStreak += 1
      return fail('no-token', s.noTokenStreak >= NO_TOKEN_STREAK ? NO_TOKEN_BACKOFF_MS : BASE_INTERVAL_MS)
    }
    s.noTokenStreak = 0
    // Claude Code refreshes an account's token only while a session runs on it. An expired one
    // would only earn a 401: the row keeps its last numbers until a session starts again.
    if (item.expiresAt !== null && item.expiresAt <= t) return fail('expired')
    let res: Response
    try {
      res = await fetchFn(USAGE_URL, { headers: { Authorization: `Bearer ${item.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    } catch { return fail(OFFLINE) }
    if (!res.ok) {
      // Release the socket: nothing reads the error body.
      await res.body?.cancel().catch(() => { /* already closed */ })
      if (res.status === 401) return fail('unauthorized')
      if (res.status === 429) {
        // Other clients share this quota (every Claude Code session of the account polls it), so
        // a 429 can be a busy minute or a long penalty: come back when the server says, and no
        // sooner. Without a usable header, keep the normal cadence rather than guess a shorter one.
        const header = res.headers.get('retry-after')
        const retryAfter = header ? Number(header) * 1000 : NaN
        return fail('rate-limited', Number.isFinite(retryAfter)
          ? Math.min(RATE_LIMITED_MAX_MS, Math.max(RATE_LIMITED_MIN_MS, retryAfter))
          : BASE_INTERVAL_MS)
      }
      return fail(`http-${res.status}`)
    }
    let json: unknown
    try { json = await res.json() } catch { return fail('invalid') }
    s.last = accountWindows(normalizeAccountUsage(json))
    s.updatedAt = t
    s.fresh = true
    s.error = undefined
    s.nextPollAt = t + BASE_INTERVAL_MS
    dirty = true
  }

  function rowOf(account: DiscoveredAccount, windows: AccountWindows, rest: Pick<AccountRow, 'available' | 'stale' | 'updatedAt' | 'error'>, show: boolean): AccountRow {
    const own = names()[account.uuid]?.trim()
    const row: AccountRow = {
      key: accountKey(account.uuid),
      name: own || account.plan || 'Claude',
      named: Boolean(own),
      plan: account.plan,
      ...windows,
      available: rest.available,
      stale: rest.stale,
      ...(rest.error ? { error: rest.error } : {}),
      updatedAt: rest.updatedAt,
      ...withAccountEmail(account.email, show),
    }
    return gateAccountEmail(row, show)
  }

  /** The channel's error, for the editor's health: never which accounts, at most how many. */
  function overall(rows: AccountRow[]): string | undefined {
    if (rows.length === 0) return 'no-account'
    const failing = rows.filter((r) => r.error && !NOT_FAILING.has(r.error))
    if (failing.length === 0) return undefined
    return failing.length === rows.length ? failing[0].error : `partial-${failing.length}`
  }

  const provider: ClaudeAccountProvider = {
    channel: 'claude-account',
    intervalMs: TICK_MS,
    publishesAccountEmail: true,
    async poll() {
      await loaded
      const t = now()
      const on = enabled()
      const show = showEmail()
      const list = await listed(t, on)
      if (!on) {
        // Off by default: until the user ticks the box, no keychain item is read and nothing is
        // sent. Each row then shows what its folders' status lines last said.
        const accounts = list.map(({ account }) => {
          const w = statusLine(account.dirs)
          const windows = withoutPassedResets(w ?? { fiveHour: null, sevenDay: null }, t)
          return rowOf(account, windows, {
            available: w !== null, stale: w === null || t - w.updatedAt > STATUS_LINE_STALE_MS, updatedAt: w?.updatedAt ?? null,
          }, show)
        })
        await persist(t)
        return { source: 'status-line', accounts, error: 'disabled' }
      }
      const due = list.filter(({ state }) => state.nextPollAt <= t)
        .sort((a, b) => a.state.nextPollAt - b.state.nextPollAt)[0]
      if (due) await read(due.account, due.state, t)
      const accounts = list.map(({ account, state }) => rowOf(account, withoutPassedResets(state.last ?? { fiveHour: null, sevenDay: null }, t), {
        available: state.updatedAt !== null,
        stale: !state.fresh || state.error !== undefined,
        updatedAt: state.updatedAt,
        error: state.error,
      }, show))
      await persist(t)
      const error = overall(accounts)
      return { source: 'account', accounts, ...(error ? { error } : {}) }
    },
    async accounts() {
      await loaded
      const t = now()
      const list = await listed(t, enabled())
      return list.map(({ account, state }) => ({
        uuid: account.uuid, plan: account.plan, org: account.org,
        lastSeen: Math.max(account.lastSeen ?? 0, state.updatedAt ?? 0) || null,
      }))
    },
  }
  return provider
}
