import {
  createGithubProvider,
  githubBaseUrl,
  githubHeaders,
  GITHUB_DEFAULT_HOST,
  GITHUB_TIMEOUT_MS,
  isFineGrainedToken,
} from '../../providers/github.js'
import { tr } from '../../i18n.js'
import { OptionsError, type ConnectionType, type PickOption, type TestResult } from '../types.js'

export interface GithubTestDeps { fetchFn?: typeof fetch }

/** `options('repos')` reads at most this many pages of a hundred repositories each. */
const REPO_PAGES = 3
const REPOS_PER_PAGE = 100

/**
 * GitHub, or a GitHub Enterprise Server, through a personal access token.
 *
 * The token is a bearer token on every call and is stored as a secret: it is never logged, never
 * echoed back by the API and never quoted in an error — not even the network error's own message,
 * which carries the URL, and on an Enterprise host the URL is itself private.
 */
export const githubType: ConnectionType = {
  id: 'github',
  name: 'GitHub',
  description: {
    fr: 'Notifications, pull requests et GitHub Actions',
    en: 'Notifications, pull requests and GitHub Actions',
  },
  icon: 'github',
  // The stored secret only ever travels to this destination; changing it means re-entering
  // the secret (see ConnectionType.secretBindings).
  secretBindings: ['host'],
  fields: [
    {
      key: 'host',
      label: { fr: 'Hôte de l’API', en: 'API host' },
      placeholder: GITHUB_DEFAULT_HOST,
      help: {
        fr: 'Laissez vide pour github.com. Pour GitHub Enterprise Server : https://github.exemple.com/api/v3',
        en: 'Leave empty for github.com. For GitHub Enterprise Server: https://github.example.com/api/v3',
      },
    },
    {
      key: 'token',
      label: { fr: 'Jeton d’accès personnel', en: 'Personal access token' },
      secret: true,
      required: true,
      help: {
        fr: 'Classique (ghp_…) : portées notifications, repo (dépôts privés) et read:org si besoin — le seul type qui donne accès aux notifications. À granularité fine (github_pat_…) : Pull requests, Actions et Metadata en lecture ; les notifications resteront indisponibles.',
        en: 'Classic (ghp_…): the notifications and repo scopes (repo only for private repositories), and read:org if needed — the only kind that can read notifications. Fine-grained (github_pat_…): Pull requests, Actions and Metadata, read-only; notifications stay unavailable.',
      },
    },
    {
      key: 'repos',
      label: { fr: 'Dépôts', en: 'Repositories' },
      placeholder: 'owner/one, owner/two',
      help: {
        fr: 'Liste owner/nom séparée par des virgules, lue par le widget Actions. Dix dépôts au maximum.',
        en: 'Comma-separated owner/name list, read by the Actions widget. Ten repositories at most.',
      },
    },
  ],

  channelPrefix: 'github',

  async test(fields, secrets, deps: GithubTestDeps = {}): Promise<TestResult> {
    const fetchFn = deps.fetchFn ?? fetch
    const base = githubBaseUrl(fields.host)
    if (!base) return { ok: false, error: tr(undefined, 'github.invalidHost') }

    let res: Response
    try {
      res = await fetchFn(`${base}/user`, {
        headers: githubHeaders(secrets.token ?? ''),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      })
    } catch {
      // Deliberately not the error message: it carries the URL, and the URL can be an internal host.
      return { ok: false, error: tr(undefined, 'github.unreachable') }
    }

    if (res.ok) {
      const user = (await res.json().catch(() => ({}))) as Record<string, unknown>
      const login = typeof user.login === 'string' ? user.login : '?'
      // A fine-grained token passes /user and still cannot read /notifications, whatever it was
      // granted: say so here rather than let the widget be the one to break the news.
      const key = isFineGrainedToken(secrets.token) ? 'github.connectedFineGrained' : 'github.connected'
      return { ok: true, detail: tr(undefined, key, { login }) }
    }
    await res.body?.cancel().catch(() => { /* already closed */ })
    if (res.status === 401) return { ok: false, error: tr(undefined, 'github.tokenRefused') }
    if (res.status === 403 || res.status === 429) {
      // A 403 is a spent quota only when GitHub says so; otherwise it is a token without the scope.
      const exhausted = res.headers.get('x-ratelimit-remaining') === '0'
      const retryAfter = res.headers.get('retry-after') !== null
      return exhausted || retryAfter
        ? { ok: false, error: tr(undefined, 'github.rateLimited') }
        : { ok: false, error: tr(undefined, 'github.tokenRefused') }
    }
    return { ok: false, error: tr(undefined, 'github.unexpected', { status: res.status }) }
  },

  /**
   * What a `pick` setting offers. One source: `repos`, the repositories the token can see, most
   * recently pushed first, grouped by owner. The widget stores `owner/name` rather than the
   * numeric id, because that is what the Actions endpoints are addressed by.
   */
  async options(source, fields, secrets, deps: GithubTestDeps = {}): Promise<PickOption[]> {
    if (source !== 'repos') throw new OptionsError(400, tr(undefined, 'connections.unknownSource', { source }))

    const fetchFn = deps.fetchFn ?? fetch
    const base = githubBaseUrl(fields.host)
    if (!base) throw new OptionsError(502, tr(undefined, 'github.invalidHost'))
    const headers = githubHeaders(secrets.token ?? '')

    const out: PickOption[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= REPO_PAGES; page++) {
      let res: Response
      try {
        res = await fetchFn(`${base}/user/repos?per_page=${REPOS_PER_PAGE}&sort=pushed&page=${page}`, {
          headers,
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        })
      } catch {
        // Never the error message: it quotes the URL.
        throw new OptionsError(502, tr(undefined, 'github.unreachable'))
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => { /* already closed */ })
        if (res.status === 401 || res.status === 403) throw new OptionsError(502, tr(undefined, 'github.tokenRefused'))
        throw new OptionsError(502, tr(undefined, 'github.unexpected', { status: res.status }))
      }
      const json = (await res.json().catch(() => undefined)) as unknown
      if (!Array.isArray(json)) break
      for (const raw of json as Record<string, any>[]) {
        const full = String(raw?.full_name ?? '')
        const owner = String(raw?.owner?.login ?? full.split('/')[0] ?? '')
        if (!full.includes('/') || seen.has(full)) continue
        seen.add(full)
        out.push({
          value: full,
          label: full,
          ...(owner ? { group: owner } : {}),
          ...(raw?.private === true ? { hint: tr(undefined, 'github.privateRepo') } : {}),
        })
      }
      // A short page is the last one: asking for the next would spend quota on nothing.
      if (json.length < REPOS_PER_PAGE) break
    }
    return out
  },

  createProvider: (ctx) => createGithubProvider(ctx),
}
