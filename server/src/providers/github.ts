import { z } from 'zod'
import type { ConnectionProviderContext } from '../connections/types.js'
import type { Provider } from './types.js'
import { USER_AGENT } from '../version.js'
import { readJsonCapped } from '../net/json.js'
import { tr } from '../i18n.js'

/**
 * GitHub, through the REST API of github.com or of a GitHub Enterprise Server.
 *
 * Endpoint provenance, so the next reader knows what is solid:
 *  - `GET   /user`                                   — the login the `@me` searches resolve to.
 *  - `GET   /notifications?all=false&per_page=50`    — the inbox. The response carries
 *    `X-Poll-Interval`, the minimum number of seconds GitHub wants between two polls, and the
 *    provider honours it.
 *  - `PATCH /notifications/threads/{id}`             — mark one thread read.
 *  - `PUT   /notifications` with `{ last_read_at }`  — mark everything read up to that instant.
 *  - `GET   /search/issues?q=…&advanced_search=true` — review requests and my own pull requests.
 *    Search has its own quota (30 requests per minute, authenticated); two per poll at one poll a
 *    minute is well inside it.
 *  - `GET   /repos/{owner}/{repo}/actions/runs?per_page=10` — workflow runs, one call per repo
 *    named in the connection's `repos` field, capped at ten repos.
 *
 * Every GET goes through a conditional request: the ETag of the previous answer is sent back as
 * `If-None-Match`, and a `304 Not Modified` replays the cached body. GitHub does not charge a 304
 * against the primary rate limit, so a quiet dashboard costs almost no quota.
 *
 * **Notifications need a classic token.** `GET /notifications` answers a fine-grained
 * (`github_pat_…`) token with 403 whatever permissions it was granted: GitHub only supports a
 * personal access token (classic) there. The provider tries once, records
 * `errors.notifications = 'fine-grained-token'` and stops asking for the rest of its life; the
 * other three sources are unaffected.
 *
 * **`checks` is not filled in.** The snapshot's `myPrs[].checks` field exists for a widget to
 * draw, but the search results carry no head SHA, so knowing the CI state of a pull request costs
 * one `GET /repos/…/pulls/{n}` plus one check-runs call *per pull request*, every minute. That is
 * not cheap, so the provider leaves the field out rather than burn the hourly quota on it.
 */

/** One request may take this long. */
export const GITHUB_TIMEOUT_MS = 10_000
/** github.com's API root; a GitHub Enterprise Server uses `https://<host>/api/v3`. */
export const GITHUB_DEFAULT_HOST = 'https://api.github.com'
/** The version header every call sends, as GitHub's docs prescribe. */
export const GITHUB_API_VERSION = '2022-11-28'
/** The nominal cadence. `X-Poll-Interval` may push it out, never pull it in. */
const POLL_EVERY_MS = 60_000
/** How many repositories the Actions half of the snapshot will read, at one call each. */
export const MAX_ACTION_REPOS = 10
/** Workflow runs asked for per repository, and pull requests per search. */
const RUNS_PER_REPO = 10
const SEARCH_PER_PAGE = 25

export type GhNotificationType = 'pr' | 'issue' | 'release' | 'ci' | 'commit' | 'discussion' | 'other'

export interface GhNotification {
  id: string
  reason: string
  title: string
  type: GhNotificationType
  repo: string
  updatedAt: number
  url: string
}

export interface GhPull {
  id: string
  number: number
  title: string
  repo: string
  author: string
  updatedAt: number
  url: string
  draft: boolean
  /** Never set by this provider — see the note at the top of the file. */
  checks?: 'success' | 'failure' | 'pending'
}

export type GhRunStatus = 'queued' | 'running' | 'completed'
export type GhRunConclusion =
  'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | 'stale'

export interface GhRun {
  id: string
  repo: string
  name: string
  branch: string
  status: GhRunStatus
  conclusion?: GhRunConclusion
  event: string
  actor: string
  startedAt?: number
  updatedAt?: number
  url: string
}

/**
 * Why one source of the snapshot has no fresh rows.
 *
 *  - `unauthorized`      — the token was refused outright (401).
 *  - `forbidden`         — 403 with no rate-limit header: the token exists but lacks the access.
 *  - `fine-grained-token`— the same 403, on notifications, from a `github_pat_` token. GitHub's
 *    Notifications API only answers a classic token, so the provider stops asking.
 *  - `rate-limited`      — the quota is spent.
 *  - `not-found`         — a 404: the repository does not exist, or the token cannot see it
 *    (GitHub answers 404, not 403, for a private repository a token has no access to).
 *  - `offline`           — the host did not answer, or answered something unusable.
 */
export type GhSectionError = 'unauthorized' | 'forbidden' | 'fine-grained-token' | 'rate-limited' | 'not-found' | 'offline'

/** One entry per source of the snapshot; a missing key means that source is fresh. */
export interface GhSectionErrors {
  notifications?: GhSectionError
  reviews?: GhSectionError
  myPrs?: GhSectionError
  runs?: GhSectionError
}

/**
 * What the `github:<id>` channel publishes.
 *
 * `rateLimit` moves on every poll that actually spends quota, so two identical minutes are not
 * byte-identical the way the Azure DevOps snapshot is. That is deliberate: the number is the one
 * piece of the payload a user needs precisely when the rest has stopped changing.
 *
 * The four sources fail independently: `errors` names the ones that did, each keeping its last
 * good rows, and the top-level `error` is set only when the token itself was refused or when
 * every source attempted this poll failed. A fine-grained token, which cannot read notifications
 * at all, therefore still shows its reviews, its pull requests and its workflow runs.
 */
export interface GhSnapshot {
  notifications: GhNotification[]
  reviewRequests: GhPull[]
  myPrs: GhPull[]
  runs: GhRun[]
  rateLimit?: { remaining: number; reset: number }
  errors?: GhSectionErrors
  error?: 'offline' | 'unauthorized' | 'rate-limited' | 'unconfigured'
}

/** Fine-grained personal access tokens carry this prefix; classic ones are `ghp_`/`gho_`/… */
export const FINE_GRAINED_PREFIX = 'github_pat_'

/** Whether a token is a fine-grained one, which the Notifications API does not accept. */
export const isFineGrainedToken = (token: string | undefined): boolean =>
  (token ?? '').startsWith(FINE_GRAINED_PREFIX)

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/**
 * `https://api.github.com/` → `https://api.github.com`, empty → the github.com root.
 *
 * Only https is accepted: the token travels on every call, and an Enterprise host typed without a
 * scheme would otherwise be reinterpreted rather than refused.
 */
export function githubBaseUrl(host: string | undefined): string | null {
  const raw = (host ?? '').trim()
  if (!raw) return GITHUB_DEFAULT_HOST
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** `"owner/a, owner/b"` → `['owner/a', 'owner/b']`, deduplicated, anything malformed dropped. */
export function parseRepos(value: string | undefined): string[] {
  const seen = new Set<string>()
  for (const part of (value ?? '').split(/[,\s]+/)) {
    const name = part.trim().replace(/^\/+|\/+$/g, '')
    if (name && OWNER_REPO_RE.test(name)) seen.add(name)
  }
  return [...seen]
}

/** The four headers every GitHub call carries. The token is never logged or echoed back. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': USER_AGENT,
  }
}

const epoch = (iso: unknown): number | undefined => {
  if (typeof iso !== 'string') return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

function notificationType(subjectType: unknown): GhNotificationType {
  switch (subjectType) {
    case 'PullRequest': return 'pr'
    case 'Issue': return 'issue'
    case 'Release': return 'release'
    case 'CheckSuite': case 'WorkflowRun': return 'ci'
    case 'Commit': return 'commit'
    case 'Discussion': return 'discussion'
    default: return 'other'
  }
}

/**
 * The page a human opens for a notification.
 *
 * `subject.url` is an *API* URL, and on an Enterprise Server its host is not the web host either,
 * so the link is rebuilt from the repository's own `html_url` and the number at the end of the
 * subject URL. Anything unrecognised falls back to the repository page rather than to an API URL
 * the browser would show as JSON.
 */
export function notificationUrl(raw: Record<string, any>): string {
  const full = String(raw?.repository?.full_name ?? '')
  const repoHtml = String(raw?.repository?.html_url ?? (full ? `https://github.com/${full}` : ''))
  if (!repoHtml) return ''
  const subject = String(raw?.subject?.url ?? '')
  const pull = /\/pulls\/(\d+)$/.exec(subject)
  if (pull) return `${repoHtml}/pull/${pull[1]}`
  const issue = /\/issues\/(\d+)$/.exec(subject)
  if (issue) return `${repoHtml}/issues/${issue[1]}`
  if (/\/releases\//.test(subject)) return `${repoHtml}/releases`
  if (/\/commits\//.test(subject)) return `${repoHtml}/commits`
  return repoHtml
}

/** `GET /notifications` → the rows the inbox widget draws. */
export function normalizeNotifications(json: unknown): GhNotification[] {
  if (!Array.isArray(json)) return []
  const out: GhNotification[] = []
  for (const raw of json as Record<string, any>[]) {
    if (!raw || raw.id == null) continue
    out.push({
      id: String(raw.id),
      reason: String(raw.reason ?? ''),
      title: String(raw.subject?.title ?? ''),
      type: notificationType(raw.subject?.type),
      repo: String(raw.repository?.full_name ?? ''),
      updatedAt: epoch(raw.updated_at) ?? 0,
      url: notificationUrl(raw),
    })
  }
  return out
}

/** `https://api.github.com/repos/owner/name` → `owner/name`. */
function repoFromApiUrl(url: unknown): string {
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(String(url ?? ''))
  return m ? m[1] : ''
}

/** `GET /search/issues` → the pull requests the widget draws. Non-PR items are dropped. */
export function normalizePulls(json: unknown): GhPull[] {
  const items = (json as { items?: unknown })?.items
  if (!Array.isArray(items)) return []
  const out: GhPull[] = []
  for (const raw of items as Record<string, any>[]) {
    if (!raw || raw.id == null || !raw.pull_request) continue
    const html = String(raw.html_url ?? '')
    const repo = repoFromApiUrl(raw.repository_url) || /github[^/]*\/([^/]+\/[^/]+)\/pull\//.exec(html)?.[1] || ''
    out.push({
      id: String(raw.id),
      number: Number(raw.number ?? 0),
      title: String(raw.title ?? ''),
      repo,
      author: String(raw.user?.login ?? ''),
      updatedAt: epoch(raw.updated_at) ?? 0,
      url: html,
      draft: raw.draft === true,
    })
  }
  return out
}

function runStatus(status: unknown): GhRunStatus {
  switch (status) {
    case 'completed': return 'completed'
    case 'in_progress': return 'running'
    default: return 'queued'
  }
}

const CONCLUSIONS = new Set<string>(
  ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale'],
)

/** `GET /repos/{owner}/{repo}/actions/runs` → the runs of one repository. */
export function normalizeRuns(json: unknown, repo: string): GhRun[] {
  const runs = (json as { workflow_runs?: unknown })?.workflow_runs
  if (!Array.isArray(runs)) return []
  const out: GhRun[] = []
  for (const raw of runs as Record<string, any>[]) {
    if (!raw || raw.id == null) continue
    const conclusion = String(raw.conclusion ?? '')
    out.push({
      id: String(raw.id),
      repo: String(raw.repository?.full_name ?? repo),
      name: String(raw.name ?? raw.display_title ?? ''),
      branch: String(raw.head_branch ?? ''),
      status: runStatus(raw.status),
      ...(CONCLUSIONS.has(conclusion) ? { conclusion: conclusion as GhRunConclusion } : {}),
      event: String(raw.event ?? ''),
      actor: String(raw.actor?.login ?? raw.triggering_actor?.login ?? ''),
      startedAt: epoch(raw.run_started_at) ?? epoch(raw.created_at),
      updatedAt: epoch(raw.updated_at),
      url: String(raw.html_url ?? ''),
    })
  }
  return out
}

/** Newest first, whichever half of the widget draws them. */
export const byRecency = (a: GhRun, b: GhRun): number => (b.startedAt ?? 0) - (a.startedAt ?? 0)

/**
 * What a failed call throws. `kind` is what the snapshot's `error` becomes; `resetAt` is the epoch
 * the rate-limit window reopens at, so the caller can stop knocking until then.
 */
export class GithubHttpError extends Error {
  constructor(
    public readonly kind: 'unauthorized' | 'forbidden' | 'rate-limited' | 'not-found' | 'offline',
    public readonly status: number,
    public readonly resetAt?: number,
  ) {
    // The status, never the body: a GitHub error body can quote the request.
    super(`github HTTP ${status}`)
    this.name = 'GithubHttpError'
  }
}

/**
 * The whole-snapshot label for a poll where every source failed.
 *
 * Sources that failed for different reasons have no single honest label, and `offline` is the one
 * that tells the user the least wrong thing: something is not answering.
 */
export function overallError(errors: GhSectionErrors): GhSnapshot['error'] {
  const kinds = Object.values(errors).filter(Boolean) as GhSectionError[]
  const first = kinds[0]
  if (!first || !kinds.every((k) => k === first)) return 'offline'
  if (first === 'rate-limited') return 'rate-limited'
  if (first === 'offline') return 'offline'
  return 'unauthorized'
}

/** Thread ids are decimal strings; anything else would be pasted straight into a URL. */
const MarkReadPayload = z.object({ id: z.string().regex(/^\d{1,20}$/) })

const MarkAllReadPayload = z.object({
  lastReadAt: z.string().refine((s) => Number.isFinite(Date.parse(s)), 'not a date').optional(),
})

export interface GithubDeps {
  fetchFn?: typeof fetch
  now?: () => number
}

/**
 * One provider per configured GitHub connection, on the channel `github:<id>`.
 *
 * A failed poll keeps the last snapshot and labels it, the way the calendar and Azure DevOps
 * providers do: a dropped Wi-Fi must dim a dashboard, not empty it.
 */
export function createGithubProvider(ctx: ConnectionProviderContext, deps: GithubDeps = {}): Provider {
  const fetchFn = deps.fetchFn ?? fetch
  const now = deps.now ?? Date.now

  const base = githubBaseUrl(ctx.fields.host)
  const token = ctx.secrets.token ?? ''
  const repos = parseRepos(ctx.fields.repos).slice(0, MAX_ACTION_REPOS)
  const headers = githubHeaders(token)

  /** url → the ETag of the last answer and the body it carried, for conditional requests. */
  const cache = new Map<string, { etag: string; body: unknown }>()
  let login: string | null = null
  /** `X-Poll-Interval`, in ms. GitHub raises it under load and the registry honours it. */
  let serverIntervalMs = 0
  /** While `now()` is below this the provider does not call at all: the quota is spent. */
  let quietUntil = 0
  let rateLimit: GhSnapshot['rateLimit']
  let last: GhSnapshot = { notifications: [], reviewRequests: [], myPrs: [], runs: [] }
  /**
   * Set once a fine-grained token has been refused by `/notifications`. The endpoint only answers
   * a classic token, so asking again every minute would spend a request on a certain 403 forever.
   */
  let notificationsGaveUp = false
  const fineGrained = isFineGrainedToken(token)

  function readRateLimit(res: Response): void {
    const rawRemaining = res.headers.get('x-ratelimit-remaining')
    const rawReset = res.headers.get('x-ratelimit-reset')
    if (rawRemaining === null || rawReset === null) return
    const remaining = Number(rawRemaining)
    const reset = Number(rawReset)
    if (Number.isFinite(remaining) && Number.isFinite(reset)) rateLimit = { remaining, reset }
  }

  /**
   * A conditional GET. Returns the parsed body, replaying the cached one on a 304.
   *
   * A 403 or a 429 is only a rate limit when GitHub says so — `x-ratelimit-remaining: 0` or a
   * `retry-after`. A 403 without either is a token that lacks the scope, which is the same thing
   * to the user as a refused token.
   */
  async function get(url: string): Promise<unknown> {
    const cached = cache.get(url)
    let res: Response
    try {
      res = await fetchFn(url, {
        headers: cached ? { ...headers, 'If-None-Match': cached.etag } : headers,
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      })
    } catch {
      // Never the error message: it quotes the URL, and on an Enterprise host the URL is private.
      throw new GithubHttpError('offline', 0)
    }
    readRateLimit(res)
    // Only the notifications endpoint sends it, but reading it everywhere costs nothing.
    const poll = Number(res.headers.get('x-poll-interval'))
    if (Number.isFinite(poll) && poll > 0) serverIntervalMs = poll * 1000

    if (res.status === 304 && cached) {
      await res.body?.cancel().catch(() => { /* already closed */ })
      return cached.body
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => { /* already closed */ })
      throw new GithubHttpError('unauthorized', 401)
    }
    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel().catch(() => { /* already closed */ })
      // `Number(null)` is 0, so the header's presence is what decides, not the parsed value.
      const rawRetry = res.headers.get('retry-after')
      const retryAfter = rawRetry === null ? NaN : Number(rawRetry)
      const exhausted = res.headers.get('x-ratelimit-remaining') === '0'
      // A 403 GitHub does not blame on the quota is a token without the access. That is a fact
      // about one endpoint, not about the token as a whole, so it is its own kind.
      if (!exhausted && !Number.isFinite(retryAfter)) throw new GithubHttpError('forbidden', res.status)
      const resetAt = Number.isFinite(retryAfter)
        ? now() + retryAfter * 1000
        : (rateLimit ? rateLimit.reset * 1000 : now() + 60_000)
      throw new GithubHttpError('rate-limited', res.status, resetAt)
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => { /* already closed */ })
      throw new GithubHttpError('not-found', 404)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => { /* already closed */ })
      throw new GithubHttpError('offline', res.status)
    }

    const etag = res.headers.get('etag')
    const body = await readJsonCapped(res).catch(() => undefined)
    if (etag) cache.set(url, { etag, body })
    else cache.delete(url)
    return body
  }

  async function send(url: string, method: 'PATCH' | 'PUT', body?: unknown): Promise<void> {
    const res = await fetchFn(url, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
    await res.body?.cancel().catch(() => { /* already closed */ })
    // GitHub's own error text can quote the request, so only the status comes out.
    if (!res.ok) throw new Error(`github HTTP ${res.status}`)
  }

  /** The login the `@me` qualifiers resolve to. Read once and kept: it does not change. */
  async function currentLogin(): Promise<string> {
    if (login) return login
    const user = (await get(`${base}/user`)) as { login?: unknown } | undefined
    login = String(user?.login ?? '')
    return login
  }

  const searchUrl = (q: string): string =>
    `${base}/search/issues?q=${encodeURIComponent(q)}&per_page=${SEARCH_PER_PAGE}&sort=updated&order=desc&advanced_search=true`

  return {
    channel: ctx.channel,
    // Read before every wait, so `X-Poll-Interval` and a spent quota both slow the loop down.
    get intervalMs(): number {
      const quiet = quietUntil - now()
      return Math.max(POLL_EVERY_MS, serverIntervalMs, quiet > 0 ? quiet : 0)
    },

    async poll(): Promise<GhSnapshot> {
      if (!base || !token) return { ...last, error: 'unconfigured' }
      if (now() < quietUntil) return { ...last, rateLimit, error: 'rate-limited' }

      const errors: GhSectionErrors = {}
      let attempted = 0
      let failed = 0

      /** Remembers a spent quota wherever it surfaces, so the whole provider stops knocking. */
      function note(err: unknown, where: string): GhSectionError {
        if (err instanceof GithubHttpError && err.kind === 'rate-limited') {
          quietUntil = err.resetAt ?? now() + 60_000
        }
        // The message is the status, never the body or the URL — see `GithubHttpError`.
        console.warn(`[github:${ctx.id}] ${where} failed (${(err as Error).message})`)
        return err instanceof GithubHttpError ? err.kind : 'offline'
      }

      /** One source. A failure is recorded against its key and the last good rows stay. */
      async function section<T>(key: keyof GhSectionErrors, keep: T, load: () => Promise<T>): Promise<T> {
        attempted++
        try {
          return await load()
        } catch (err) {
          failed++
          errors[key] = note(err, key)
          return keep
        }
      }

      // `/user` is the token itself: if it is refused, no section can succeed either.
      let me: string
      try {
        me = await currentLogin()
      } catch (err) {
        const kind = note(err, 'login')
        return {
          ...last,
          ...(rateLimit ? { rateLimit } : {}),
          error: kind === 'rate-limited' ? 'rate-limited' : kind === 'offline' ? 'offline' : 'unauthorized',
        }
      }

      let notifications = last.notifications
      if (notificationsGaveUp) {
        // Already known impossible for this token: recorded, not requested.
        attempted++
        failed++
        errors.notifications = 'fine-grained-token'
      } else {
        notifications = await section('notifications', last.notifications, async () =>
          normalizeNotifications(await get(`${base}/notifications?all=false&per_page=50`)))
        if (errors.notifications === 'forbidden' && fineGrained) {
          errors.notifications = 'fine-grained-token'
          notificationsGaveUp = true
        }
      }

      const [reviewRequests, myPrs] = await Promise.all([
        section('reviews', last.reviewRequests, async () =>
          normalizePulls(await get(searchUrl(`is:pr is:open archived:false review-requested:${me}`)))),
        section('myPrs', last.myPrs, async () =>
          normalizePulls(await get(searchUrl(`is:pr is:open archived:false author:${me}`)))),
      ])

      let runs = last.runs
      if (repos.length) {
        attempted++
        const fresh: GhRun[] = []
        let repoFailures = 0
        let repoError: GhSectionError | undefined
        for (const repo of repos) {
          const [owner, name] = repo.split('/')
          try {
            const json = await get(
              `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?per_page=${RUNS_PER_REPO}`,
            )
            fresh.push(...normalizeRuns(json, repo))
          } catch (err) {
            repoFailures++
            // One repository the token cannot see must not blank the other nine.
            repoError = repoError ?? note(err, 'runs')
          }
        }
        if (repoError) errors.runs = repoError
        if (repoFailures === repos.length) failed++
        else runs = fresh.sort(byRecency)
      }

      last = {
        notifications,
        reviewRequests,
        myPrs,
        runs,
        ...(rateLimit ? { rateLimit } : {}),
        ...(Object.keys(errors).length ? { errors } : {}),
      }
      // Only a poll where nothing at all came back is a whole-tile failure.
      if (attempted > 0 && failed === attempted) return { ...last, error: overallError(errors) }
      return last
    },

    commands: {
      /** Marks one notification thread read — what a tap on an inbox row asks for. */
      markRead: async (payload) => {
        const parsed = MarkReadPayload.safeParse(payload)
        if (!parsed.success) throw new Error(tr(undefined, 'github.invalidCommand'))
        const { id } = parsed.data
        await send(`${base}/notifications/threads/${id}`, 'PATCH')
        return { ok: true }
      },

      /**
       * Marks everything read up to an instant. `last_read_at` defaults to now, so a notification
       * that arrives between the tap and the request survives instead of being silently swallowed.
       */
      markAllRead: async (payload) => {
        const parsed = MarkAllReadPayload.safeParse(payload ?? {})
        if (!parsed.success) throw new Error(tr(undefined, 'github.invalidCommand'))
        const { lastReadAt } = parsed.data
        // `read` is left out on purpose. Checked against docs.github.com (REST, activity /
        // notifications, api-version 2022-11-28): it is optional, documented only as "Whether
        // the notification has been read", with no stated default and nothing about what it
        // means on a mark-as-read call. We were sending `false`, which at best means nothing and
        // at worst asks for the opposite of the request. Omitted, the endpoint does its
        // documented job: everything up to `last_read_at` is marked read.
        await send(`${base}/notifications`, 'PUT', {
          last_read_at: lastReadAt ?? new Date(now()).toISOString(),
        })
        return { ok: true }
      },
    },
  }
}
