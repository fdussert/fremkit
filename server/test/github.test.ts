import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createGithubProvider,
  githubBaseUrl,
  githubHeaders,
  normalizeNotifications,
  normalizePulls,
  normalizeRuns,
  notificationUrl,
  parseRepos,
  type GhSnapshot,
} from '../src/providers/github.js'
import { githubType } from '../src/connections/types/github.js'
import { OptionsError } from '../src/connections/types.js'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'))

const NOTIFICATIONS = fixture('github-notifications')
const REVIEWS = fixture('github-search-reviews')
const MINE = fixture('github-search-mine')
const RUNS = fixture('github-runs')

const TOKEN = 'ghp_placeholder_token'
/** A fine-grained token: the prefix is what tells the two kinds apart. */
const FINE_GRAINED = 'github_pat_placeholder_token'

describe('githubBaseUrl', () => {
  it('defaults to github.com and trims an Enterprise root', () => {
    expect(githubBaseUrl(undefined)).toBe('https://api.github.com')
    expect(githubBaseUrl('  ')).toBe('https://api.github.com')
    expect(githubBaseUrl('https://github.example.com/api/v3/')).toBe('https://github.example.com/api/v3')
  })

  it('refuses anything that is not an https URL', () => {
    expect(githubBaseUrl('http://github.example.com')).toBeNull()
    expect(githubBaseUrl('github.example.com')).toBeNull()
    expect(githubBaseUrl('javascript:alert(1)')).toBeNull()
  })
})

describe('parseRepos', () => {
  it('splits, trims and deduplicates owner/name pairs', () => {
    expect(parseRepos(' example-org/example-repo ,example-user/second-repo, example-org/example-repo '))
      .toEqual(['example-org/example-repo', 'example-user/second-repo'])
  })

  it('drops anything that is not one owner and one name', () => {
    expect(parseRepos('nope, a/b/c, /x, https://github.com/o/n')).toEqual([])
    expect(parseRepos(undefined)).toEqual([])
  })
})

describe('githubHeaders', () => {
  it('sends the bearer token, the media type, the API version and the user agent', () => {
    const h = githubHeaders(TOKEN)
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(h.Accept).toBe('application/vnd.github+json')
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(h['User-Agent']).toMatch(/^fremkit\//)
  })
})

describe('normalizeNotifications', () => {
  const rows = normalizeNotifications(NOTIFICATIONS)

  it('maps every unread thread in the order the API returned them', () => {
    expect(rows.map((n) => n.id)).toEqual(['10101', '10102', '10103', '10104'])
  })

  it('maps the subject type to a glyph family and keeps the reason', () => {
    expect(rows.map((n) => n.type)).toEqual(['pr', 'issue', 'ci', 'release'])
    expect(rows[0]).toMatchObject({
      reason: 'review_requested',
      title: 'Add the widget rescan button',
      repo: 'example-org/example-repo',
      url: 'https://github.com/example-org/example-repo/pull/318',
    })
    expect(rows[0].updatedAt).toBe(Date.parse('2026-09-17T09:12:00Z'))
  })

  it('rebuilds a web URL from the repository, never an API one', () => {
    expect(rows[1].url).toBe('https://github.com/example-org/example-repo/issues/291')
    // An Enterprise repository keeps its own web host rather than github.com.
    expect(rows[2].url).toBe('https://github.example.com/example-user/second-repo')
    expect(rows[3].url).toBe('https://github.com/example-org/example-repo/releases')
    expect(rows.every((n) => !n.url.includes('api.github.com'))).toBe(true)
  })

  it('falls back to the repository page for a subject it does not recognise', () => {
    expect(notificationUrl({ repository: { full_name: 'o/n' }, subject: { url: 'x' } }))
      .toBe('https://github.com/o/n')
    expect(notificationUrl({})).toBe('')
  })

  it('survives a response that is not the expected shape', () => {
    expect(normalizeNotifications(null)).toEqual([])
    expect(normalizeNotifications({ message: 'Bad credentials' })).toEqual([])
    expect(normalizeNotifications([{}])).toEqual([])
  })
})

describe('normalizePulls', () => {
  it('keeps the pull requests and drops the issues the search also returns', () => {
    const pulls = normalizePulls(REVIEWS)
    expect(pulls.map((p) => p.number)).toEqual([318, 44])
    expect(pulls[0]).toMatchObject({
      id: '5001', repo: 'example-org/example-repo', author: 'example-author', draft: false,
      url: 'https://github.com/example-org/example-repo/pull/318',
    })
    expect(pulls[1].draft).toBe(true)
  })

  it('never invents a checks verdict', () => {
    expect(normalizePulls(MINE)[0].checks).toBeUndefined()
  })

  it('survives a response that is not the expected shape', () => {
    expect(normalizePulls(null)).toEqual([])
    expect(normalizePulls({ items: 'nope' })).toEqual([])
  })
})

describe('normalizeRuns', () => {
  const runs = normalizeRuns(RUNS, 'example-org/example-repo')

  it('maps status, conclusion, branch, actor and timestamps', () => {
    expect(runs.map((r) => r.status)).toEqual(['running', 'completed', 'queued'])
    expect(runs[0]).toMatchObject({
      id: '900001', repo: 'example-org/example-repo', name: 'CI', branch: 'feature/rescan',
      event: 'pull_request', actor: 'example-author',
      url: 'https://github.com/example-org/example-repo/actions/runs/900001',
    })
    expect(runs[0].conclusion).toBeUndefined()
    expect(runs[1].conclusion).toBe('failure')
    expect(runs[0].startedAt).toBe(Date.parse('2026-09-17T09:10:00Z'))
  })

  it('falls back to display_title and to triggering_actor', () => {
    expect(runs[2].name).toBe('Nightly')
    expect(runs[2].actor).toBe('example-bot')
    // A queued run has no run_started_at; created_at stands in so the row can be ordered.
    expect(runs[2].startedAt).toBe(Date.parse('2026-09-17T03:00:00Z'))
  })

  it('survives a response that is not the expected shape', () => {
    expect(normalizeRuns(null, 'o/n')).toEqual([])
    expect(normalizeRuns({ workflow_runs: [{}] }, 'o/n')).toEqual([])
  })
})

/** A fetch double that routes on the path and records every call. */
function responder(options: {
  status?: (url: string) => number
  headers?: (url: string) => Record<string, string>
} = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  const bodyFor = (url: string): unknown => {
    if (url.includes('/user/repos')) return []
    if (url.endsWith('/user')) return { login: 'example-user' }
    if (url.includes('/notifications')) return NOTIFICATIONS
    if (url.includes('review-requested')) return REVIEWS
    if (url.includes('/search/issues')) return MINE
    if (url.includes('/actions/runs')) return RUNS
    return {}
  }
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
    })
    const status = options.status?.(String(url)) ?? 200
    const headers = { 'content-type': 'application/json', ...(options.headers?.(String(url)) ?? {}) }
    if (status === 304 || status === 204) return new Response(null, { status, headers })
    return new Response(JSON.stringify(bodyFor(String(url))), { status, headers })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

const context = (fields: Record<string, string> = {}) => ({
  id: 'gh-x1z9',
  channel: 'github:gh-x1z9',
  fields: { repos: 'example-org/example-repo', ...fields },
  secrets: { token: TOKEN },
})

describe('createGithubProvider', () => {
  it('reads the login, the inbox, both searches and one run list per repo', async () => {
    const { calls, fetchFn } = responder()
    const provider = createGithubProvider(context(), { fetchFn, now: () => 1_000_000 })
    const snapshot = (await provider.poll!()) as GhSnapshot

    expect(provider.channel).toBe('github:gh-x1z9')
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/user',
      'https://api.github.com/notifications?all=false&per_page=50',
      'https://api.github.com/search/issues?q=is%3Apr%20is%3Aopen%20archived%3Afalse%20review-requested%3Aexample-user&per_page=25&sort=updated&order=desc&advanced_search=true',
      'https://api.github.com/search/issues?q=is%3Apr%20is%3Aopen%20archived%3Afalse%20author%3Aexample-user&per_page=25&sort=updated&order=desc&advanced_search=true',
      'https://api.github.com/repos/example-org/example-repo/actions/runs?per_page=10',
    ])
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls[0].headers['X-GitHub-Api-Version']).toBe('2022-11-28')

    expect(snapshot.notifications).toHaveLength(4)
    expect(snapshot.reviewRequests.map((p) => p.number)).toEqual([318, 44])
    expect(snapshot.myPrs.map((p) => p.number)).toEqual([319])
    expect(snapshot.runs.map((r) => r.id)).toEqual(['900001', '900000', '899999'])
    expect(snapshot.error).toBeUndefined()
  })

  it('uses the Enterprise root when one is configured', async () => {
    const { calls, fetchFn } = responder()
    await createGithubProvider(context({ host: 'https://github.example.com/api/v3' }), { fetchFn, now: () => 0 }).poll!()
    expect(calls[0].url).toBe('https://github.example.com/api/v3/user')
  })

  it('reads at most ten repositories, whatever the field holds', async () => {
    const many = Array.from({ length: 14 }, (_, i) => `example-org/repo-${i}`).join(',')
    const { calls, fetchFn } = responder()
    await createGithubProvider(context({ repos: many }), { fetchFn, now: () => 0 }).poll!()
    expect(calls.filter((c) => c.url.includes('/actions/runs'))).toHaveLength(10)
  })

  it('says unconfigured rather than calling with no token', async () => {
    const { calls, fetchFn } = responder()
    const ctx = { ...context(), secrets: {} }
    expect(await createGithubProvider(ctx, { fetchFn, now: () => 0 }).poll!())
      .toEqual({ notifications: [], reviewRequests: [], myPrs: [], runs: [], error: 'unconfigured' })
    expect(calls).toHaveLength(0)
  })

  it('sends the previous ETag back and replays the cached body on a 304', async () => {
    const { calls, fetchFn } = responder({
      status: (url) => (url.includes('/notifications') && calls.length > 4 ? 304 : 200),
      headers: (url) => (url.includes('/notifications') ? { etag: 'W/"inbox-1"' } : {} as Record<string, string>),
    })
    const provider = createGithubProvider(context(), { fetchFn, now: () => 0 })
    const first = (await provider.poll!()) as GhSnapshot
    expect(calls[1].headers['If-None-Match']).toBeUndefined()

    const second = (await provider.poll!()) as GhSnapshot
    const conditional = calls.filter((c) => c.url.includes('/notifications'))[1]
    expect(conditional.headers['If-None-Match']).toBe('W/"inbox-1"')
    expect(second.error).toBeUndefined()
    expect(second.notifications.map((n) => n.id)).toEqual(first.notifications.map((n) => n.id))
  })

  it('keeps the last snapshot and reports offline on a network failure', async () => {
    let fail = false
    const inner = responder()
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (fail) throw new Error('getaddrinfo ENOTFOUND api.github.com')
      return (inner.fetchFn as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch
    const provider = createGithubProvider(context(), { fetchFn, now: () => 0 })
    const first = (await provider.poll!()) as GhSnapshot
    fail = true
    const second = (await provider.poll!()) as GhSnapshot
    expect(second.error).toBe('offline')
    expect(second.notifications.map((n) => n.id)).toEqual(first.notifications.map((n) => n.id))
    expect(JSON.stringify(second)).not.toContain(TOKEN)
  })

  it('reports a refused token, and a 403 without rate-limit headers as refused too', async () => {
    for (const status of [401, 403]) {
      const { fetchFn } = responder({ status: () => status })
      const snapshot = (await createGithubProvider(context(), { fetchFn, now: () => 0 }).poll!()) as GhSnapshot
      expect(snapshot.error).toBe('unauthorized')
    }
  })

  it('keeps the other sources when a fine-grained token is refused by /notifications', async () => {
    const { calls, fetchFn } = responder({ status: (url) => (url.includes('/notifications') ? 403 : 200) })
    const ctx = { ...context(), secrets: { token: FINE_GRAINED } }
    const provider = createGithubProvider(ctx, { fetchFn, now: () => 0 })

    const first = (await provider.poll!()) as GhSnapshot
    expect(first.errors).toEqual({ notifications: 'fine-grained-token' })
    expect(first.error).toBeUndefined()
    expect(first.notifications).toEqual([])
    expect(first.reviewRequests.map((p) => p.number)).toEqual([318, 44])
    expect(first.myPrs.map((p) => p.number)).toEqual([319])
    expect(first.runs).toHaveLength(3)

    // The endpoint can never answer this token, so the provider stops spending a request on it.
    const before = calls.filter((c) => c.url.includes('/notifications')).length
    const second = (await provider.poll!()) as GhSnapshot
    expect(calls.filter((c) => c.url.includes('/notifications'))).toHaveLength(before)
    expect(second.errors).toEqual({ notifications: 'fine-grained-token' })
    expect(second.error).toBeUndefined()
    expect(second.reviewRequests.map((p) => p.number)).toEqual([318, 44])
  })

  it('reports a repository the token cannot see as not-found, not offline', async () => {
    // GitHub answers 404 for a private repository a token has no access to.
    const { fetchFn } = responder({ status: (url) => (url.includes('/actions/runs') ? 404 : 200) })
    const provider = createGithubProvider(context(), { fetchFn, now: () => 0 })
    const snapshot = (await provider.poll!()) as GhSnapshot
    expect(snapshot.errors?.runs).toBe('not-found')
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.reviewRequests.length).toBeGreaterThan(0)
  })

  it('calls /notifications again next poll when a classic token gets the same 403', async () => {
    const { calls, fetchFn } = responder({ status: (url) => (url.includes('/notifications') ? 403 : 200) })
    const provider = createGithubProvider(context(), { fetchFn, now: () => 0 })

    const first = (await provider.poll!()) as GhSnapshot
    expect(first.errors).toEqual({ notifications: 'forbidden' })
    expect(first.error).toBeUndefined()
    expect(first.reviewRequests.map((p) => p.number)).toEqual([318, 44])

    await provider.poll!()
    expect(calls.filter((c) => c.url.includes('/notifications')).length).toBe(2)
  })

  it('labels the whole snapshot only when every source failed', async () => {
    let fail = false
    const inner = responder()
    const fetchFn = (async (url: string, init?: RequestInit) => {
      // `/user` keeps answering: the token is fine, the sources are not.
      if (fail && !String(url).endsWith('/user')) throw new Error('socket hang up')
      return (inner.fetchFn as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch
    const provider = createGithubProvider(context(), { fetchFn, now: () => 0 })
    const first = (await provider.poll!()) as GhSnapshot
    expect(first.errors).toBeUndefined()

    fail = true
    const second = (await provider.poll!()) as GhSnapshot
    expect(second.error).toBe('offline')
    expect(second.errors)
      .toEqual({ notifications: 'offline', reviews: 'offline', myPrs: 'offline', runs: 'offline' })
    // Every section keeps the rows it last had.
    expect(second.notifications.map((n) => n.id)).toEqual(first.notifications.map((n) => n.id))
    expect(second.runs).toHaveLength(3)
  })

  it('backs off until x-ratelimit-reset after a 403 that spent the quota', async () => {
    let now = 1_000_000
    let limited = false
    const reset = 1_600 // epoch seconds
    const { calls, fetchFn } = responder({
      status: () => (limited ? 403 : 200),
      headers: () => ({ 'x-ratelimit-remaining': limited ? '0' : '42', 'x-ratelimit-reset': String(reset) }),
    })
    const provider = createGithubProvider(context(), { fetchFn, now: () => now })
    const first = (await provider.poll!()) as GhSnapshot
    expect(first.rateLimit).toEqual({ remaining: 42, reset })

    limited = true
    const second = (await provider.poll!()) as GhSnapshot
    expect(second.error).toBe('rate-limited')
    expect(second.rateLimit).toEqual({ remaining: 0, reset })
    // The last known rows stay on screen rather than the widget emptying.
    expect(second.notifications).toHaveLength(4)
    expect(provider.intervalMs).toBe(reset * 1000 - now)

    const spentBefore = calls.length
    now = reset * 1000 - 1
    expect(((await provider.poll!()) as GhSnapshot).error).toBe('rate-limited')
    expect(calls.length).toBe(spentBefore)

    limited = false
    now = reset * 1000 + 1
    expect(((await provider.poll!()) as GhSnapshot).error).toBeUndefined()
    expect(calls.length).toBeGreaterThan(spentBefore)
  })

  it('honours X-Poll-Interval and never polls faster than a minute', async () => {
    const { fetchFn } = responder({ headers: (url) => (url.includes('/notifications') ? { 'x-poll-interval': '120' } : {} as Record<string, string>) })
    const provider = createGithubProvider(context(), { fetchFn, now: () => 0 })
    expect(provider.intervalMs).toBe(60_000)
    await provider.poll!()
    expect(provider.intervalMs).toBe(120_000)
  })

  it('marks one thread read with a PATCH on its own URL', async () => {
    const { calls, fetchFn } = responder()
    const provider = createGithubProvider(context(), { fetchFn, now: () => 0 })
    await provider.commands!.markRead({ id: '10101' })
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/notifications/threads/10101', method: 'PATCH' })
    expect(calls[0].body).toBeUndefined()
  })

  it('refuses a thread id that is not a plain number', async () => {
    const { calls, fetchFn } = responder()
    const provider = createGithubProvider(context(), { fetchFn, now: () => 0 })
    for (const id of ['../../user', '10101/x', '', 'abc']) {
      await expect(provider.commands!.markRead({ id })).rejects.toThrow()
    }
    await expect(provider.commands!.markRead({})).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('marks everything read with a PUT carrying last_read_at', async () => {
    const { calls, fetchFn } = responder()
    const provider = createGithubProvider(context(), { fetchFn, now: () => Date.parse('2026-09-17T10:00:00Z') })
    await provider.commands!.markAllRead({})
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/notifications', method: 'PUT' })
    // `read` is not sent: GitHub documents it only as "Whether the notification has been read",
    // with no default and nothing about what it means on a mark-as-read call. We were sending
    // `false`, which at best means nothing. Omitted, the endpoint does its documented job.
    expect(JSON.parse(calls[0].body!)).toEqual({ last_read_at: '2026-09-17T10:00:00.000Z' })

    await provider.commands!.markAllRead({ lastReadAt: '2026-09-17T09:00:00Z' })
    expect(JSON.parse(calls[1].body!).last_read_at).toBe('2026-09-17T09:00:00Z')
    await expect(provider.commands!.markAllRead({ lastReadAt: 'yesterday' })).rejects.toThrow()
  })
})

describe('githubType', () => {
  const fields = {}

  it('declares the host, the secret token and the repository list', () => {
    expect(githubType.fields.map((f) => f.key)).toEqual(['host', 'token', 'repos'])
    expect(githubType.fields[1].secret).toBe(true)
    expect(githubType.fields[1].required).toBe(true)
    expect(githubType.fields[0].required).toBeUndefined()
    expect(githubType.channelPrefix).toBe('github')
  })

  it('reports the login on a 200 from /user', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
      return new Response(JSON.stringify({ login: 'example-user' }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(githubType.test(fields, { token: TOKEN }, { fetchFn })).resolves.toEqual({
      ok: true, detail: 'Connecté à GitHub en tant que example-user',
    })
    expect(calls[0].url).toBe('https://api.github.com/user')
    expect(calls[0].headers.Accept).toBe('application/vnd.github+json')
  })

  it('warns that a fine-grained token cannot read the notifications', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ login: 'example-user' }), { status: 200 })) as unknown as typeof fetch
    const result = await githubType.test(fields, { token: FINE_GRAINED }, { fetchFn })
    expect(result.ok).toBe(true)
    const detail = result.ok ? result.detail ?? '' : ''
    expect(detail).toContain('example-user')
    expect(detail).toContain('granularité fine')
    expect(detail).toContain('notifications indisponibles')
    expect(JSON.stringify(result)).not.toContain(FINE_GRAINED)
  })

  it('turns 401, a scopeless 403 and an unexpected status into readable French', async () => {
    const at = (status: number, headers?: Record<string, string>) =>
      (async () => new Response('', { status, headers })) as unknown as typeof fetch
    await expect(githubType.test(fields, { token: 'x' }, { fetchFn: at(401) }))
      .resolves.toEqual({ ok: false, error: 'jeton refusé (portées notifications, repo et Actions attendues)' })
    await expect(githubType.test(fields, { token: 'x' }, { fetchFn: at(403) }))
      .resolves.toEqual({ ok: false, error: 'jeton refusé (portées notifications, repo et Actions attendues)' })
    await expect(githubType.test(fields, { token: 'x' }, { fetchFn: at(500) }))
      .resolves.toEqual({ ok: false, error: 'réponse inattendue (HTTP 500)' })
  })

  it('names the spent quota when GitHub says the limit is what refused the call', async () => {
    const at = (status: number, headers: Record<string, string>) =>
      (async () => new Response('', { status, headers })) as unknown as typeof fetch
    await expect(githubType.test(fields, { token: 'x' }, { fetchFn: at(403, { 'x-ratelimit-remaining': '0' }) }))
      .resolves.toEqual({ ok: false, error: 'quota d’API GitHub épuisé ; réessayez plus tard' })
    await expect(githubType.test(fields, { token: 'x' }, { fetchFn: at(429, { 'retry-after': '60' }) }))
      .resolves.toEqual({ ok: false, error: 'quota d’API GitHub épuisé ; réessayez plus tard' })
  })

  it('reports an unreachable host and an invalid one without leaking the token', async () => {
    const fetchFn = (async () => { throw new Error('getaddrinfo ENOTFOUND github.internal') }) as unknown as typeof fetch
    const result = await githubType.test(fields, { token: TOKEN }, { fetchFn })
    expect(result).toEqual({ ok: false, error: 'GitHub injoignable' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)

    const bad = await githubType.test({ host: 'http://github.example.com' }, { token: TOKEN }, { fetchFn })
    expect(bad.ok).toBe(false)
    expect(JSON.stringify(bad)).not.toContain(TOKEN)
  })

  it('lists the repositories, paginating until a short page', async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        full_name: `example-org/repo-${n}-${i}`,
        owner: { login: 'example-org' },
        private: i === 0,
      }))
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(String(url))
      const n = Number(/[?&]page=(\d+)/.exec(String(url))?.[1] ?? 1)
      return new Response(JSON.stringify(page(n, n === 3 ? 5 : 100)), { status: 200 })
    }) as unknown as typeof fetch

    const options = await githubType.options!('repos', {}, { token: TOKEN }, { fetchFn })
    expect(urls).toEqual([
      'https://api.github.com/user/repos?per_page=100&sort=pushed&page=1',
      'https://api.github.com/user/repos?per_page=100&sort=pushed&page=2',
      'https://api.github.com/user/repos?per_page=100&sort=pushed&page=3',
    ])
    expect(options).toHaveLength(205)
    expect(options[0]).toEqual({ value: 'example-org/repo-1-0', label: 'example-org/repo-1-0', group: 'example-org', hint: 'privé' })
    expect(options[1].hint).toBeUndefined()
  })

  it('stops at the first short page and never asks for a fourth', async () => {
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify([{ full_name: 'example-org/only', owner: { login: 'example-org' } }]), { status: 200 })
    }) as unknown as typeof fetch
    expect(await githubType.options!('repos', {}, { token: TOKEN }, { fetchFn })).toHaveLength(1)
    expect(urls).toHaveLength(1)
  })

  it('refuses an unknown source with a 400 and a refused token with a 502', async () => {
    const ok = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch
    await expect(githubType.options!('branches', {}, { token: TOKEN }, { fetchFn: ok }))
      .rejects.toMatchObject({ status: 400 })
    const refused = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    await expect(githubType.options!('repos', {}, { token: TOKEN }, { fetchFn: refused }))
      .rejects.toBeInstanceOf(OptionsError)
  })
})
