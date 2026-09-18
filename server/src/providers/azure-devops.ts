import { execFile } from 'node:child_process'
import type { ConnectionProviderContext } from '../connections/types.js'
import type { CommandContext, Provider } from './types.js'
import { USER_AGENT } from '../version.js'
import { tr } from '../i18n.js'
import { readJsonCapped } from '../net/json.js'

export const ADO_API_VERSION = '7.1'
/** Timeouts and cadences, from the spec: builds every 30 s, timelines every 10 s. */
export const ADO_TIMEOUT_MS = 10_000
const BUILDS_EVERY_MS = 30_000
const TIMELINE_EVERY_MS = 10_000
/**
 * How many builds one page asks for, and how many completed ones the snapshot keeps.
 *
 * The provider is shared by every widget bound to the connection, and the history length is a
 * per-widget setting, so it fetches one fixed page and lets each widget slice it down.
 */
const BUILDS_PAGE = 40

export type AdoResult = 'succeeded' | 'failed' | 'canceled' | 'partial'
export interface AdoStage { name: string; state: 'pending' | 'running' | 'done'; result?: AdoResult | 'skipped' }
export interface AdoRun {
  id: number; number: string; pipeline: string; branch: string; requestedFor: string; reason: string
  status: 'queued' | 'running' | 'completed'; result?: AdoResult
  queuedAt: number; startedAt?: number; finishedAt?: number; url: string
  stages: AdoStage[]
}
/**
 * What the `azure-devops:<id>` channel publishes.
 *
 * No timestamp: the provider is polled every ten seconds and a fresh `updatedAt` in every payload
 * would defeat the registry's dedup, waking every subscriber for a snapshot that did not change.
 * The widget times its own "x min ago" labels off the run timestamps and its own clock.
 */
export interface AdoSnapshot { running: AdoRun[]; history: AdoRun[]; error?: string }

/** `refs/heads/feature/x` → `feature/x`, `refs/pull/318/merge` → `PR 318`. */
export function shortBranch(ref: string): string {
  const pr = /^refs\/pull\/(\d+)\//.exec(ref)
  if (pr) return `PR ${pr[1]}`
  return ref.replace(/^refs\/(heads|tags)\//, '')
}

const epoch = (iso: unknown): number | undefined => {
  if (typeof iso !== 'string') return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

function mapStatus(status: unknown): AdoRun['status'] {
  switch (status) {
    case 'inProgress': case 'cancelling': return 'running'
    case 'completed': return 'completed'
    default: return 'queued'
  }
}

function mapResult(result: unknown): AdoResult | undefined {
  switch (result) {
    case 'succeeded': return 'succeeded'
    case 'partiallySucceeded': return 'partial'
    case 'failed': return 'failed'
    case 'canceled': return 'canceled'
    default: return undefined
  }
}

function mapStageResult(result: unknown): AdoStage['result'] {
  switch (result) {
    case 'succeededWithIssues': return 'partial'
    case 'abandoned': return 'canceled'
    case 'skipped': return 'skipped'
    default: return mapResult(result)
  }
}

/** `GET …/_apis/build/builds` → runs without stages (the timeline is a separate call). */
export function normalizeBuilds(json: unknown): AdoRun[] {
  const value = (json as { value?: unknown })?.value
  if (!Array.isArray(value)) return []
  const runs: AdoRun[] = []
  for (const raw of value as Record<string, any>[]) {
    if (!raw || typeof raw.id !== 'number') continue
    const queuedAt = epoch(raw.queueTime)
    runs.push({
      id: raw.id,
      number: String(raw.buildNumber ?? raw.id),
      pipeline: String(raw.definition?.name ?? '?'),
      branch: shortBranch(String(raw.sourceBranch ?? '')),
      requestedFor: String(raw.requestedFor?.displayName ?? ''),
      reason: String(raw.reason ?? ''),
      status: mapStatus(raw.status),
      result: mapResult(raw.result),
      queuedAt: queuedAt ?? 0,
      startedAt: epoch(raw.startTime),
      finishedAt: epoch(raw.finishTime),
      url: String(raw._links?.web?.href ?? ''),
      stages: [],
    })
  }
  return runs
}

/**
 * `GET …/builds/{id}/timeline` → the run's stage chain.
 *
 * A YAML pipeline has `Stage` records; a classic one has none, and its top-level `Phase`
 * records (or, failing that, its `Job` records) play the same role.
 */
export function normalizeTimeline(json: unknown): AdoStage[] {
  const records = (json as { records?: unknown })?.records
  if (!Array.isArray(records)) return []
  const all = records as Record<string, any>[]
  const pick = (type: string, topLevelOnly: boolean): Record<string, any>[] =>
    all.filter((r) => r?.type === type && (!topLevelOnly || r.parentId == null))
  const chosen = pick('Stage', false).length ? pick('Stage', false) : pick('Phase', true).length ? pick('Phase', true) : pick('Job', true)
  return chosen
    .slice()
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .map((r) => {
      const stage: AdoStage = {
        name: String(r.name ?? '?'),
        state: r.state === 'completed' ? 'done' : r.state === 'inProgress' ? 'running' : 'pending',
      }
      const result = mapStageResult(r.result)
      if (result) stage.result = result
      return stage
    })
}

/**
 * Splits the runs the API returned into "in progress" and "history".
 *
 * The widget draws a card per running or queued run and a line per history entry. How many lines
 * it draws (spec §4.3: a running run eats two of them, never below two) and which branches it
 * keeps are per-widget-instance settings, and the provider — one per connection, shared by every
 * widget bound to it — knows nothing of widget instances. So it hands over everything it has and
 * each widget filters and slices client-side.
 */
export function splitRuns(runs: AdoRun[]): { running: AdoRun[]; history: AdoRun[] } {
  return {
    running: runs.filter((r) => r.status !== 'completed'),
    history: runs.filter((r) => r.status === 'completed').slice(0, BUILDS_PAGE),
  }
}

const openUrl = (url: string): Promise<void> =>
  new Promise((resolve, reject) => execFile('open', [url], (err) => (err ? reject(err) : resolve())))

export interface AdoProviderDeps {
  fetchFn?: typeof fetch
  now?: () => number
  open?: (url: string) => Promise<void>
}

/**
 * One provider per configured Azure DevOps connection, on the channel `azure-devops:<id>`.
 *
 * The registry only knows one period, so the provider is polled at the timeline cadence (10 s)
 * and refreshes the build list itself only every 30 s. Two consecutive polls that produce the
 * same JSON publish nothing: the registry deduplicates.
 */
export function createAzureDevOpsProvider(ctx: ConnectionProviderContext, deps: AdoProviderDeps = {}): Provider {
  const fetchFn = deps.fetchFn ?? fetch
  const now = deps.now ?? Date.now
  const open = deps.open ?? openUrl

  const org = encodeURIComponent(ctx.fields.organization ?? '')
  const project = encodeURIComponent(ctx.fields.project ?? '')
  const base = `https://dev.azure.com/${org}/${project}/_apis/build`
  const auth = `Basic ${Buffer.from(`:${ctx.secrets.pat ?? ''}`).toString('base64')}`
  const headers = { Authorization: auth, Accept: 'application/json', 'User-Agent': USER_AGENT }

  let builds: AdoRun[] = []
  let stages = new Map<number, AdoStage[]>()
  let lastBuildsAt = -Infinity
  let lastTimelineAt = -Infinity
  let last: AdoSnapshot = { running: [], history: [] }

  /** Fetches JSON, or returns the literal 'unauthorized' for a 401/403. Network errors throw. */
  async function get(url: string): Promise<unknown | 'unauthorized'> {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(ADO_TIMEOUT_MS) })
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => { /* already closed */ })
      return 'unauthorized'
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => { /* already closed */ })
      throw new Error(`HTTP ${res.status}`)
    }
    return readJsonCapped(res)
  }

  return {
    channel: ctx.channel,
    intervalMs: TIMELINE_EVERY_MS,

    async poll(): Promise<AdoSnapshot> {
      const t = now()
      try {
        if (t - lastBuildsAt >= BUILDS_EVERY_MS) {
          const json = await get(`${base}/builds?$top=${BUILDS_PAGE}&queryOrder=queueTimeDescending&api-version=${ADO_API_VERSION}`)
          if (json === 'unauthorized') return { ...last, error: 'unauthorized' }
          lastBuildsAt = t
          builds = normalizeBuilds(json)
          // Forget the timelines of builds that dropped off the list.
          const alive = new Set(builds.map((b) => b.id))
          stages = new Map([...stages].filter(([id]) => alive.has(id)))
        }

        const unfinished = builds.filter((b) => b.status !== 'completed')
        if (unfinished.length && t - lastTimelineAt >= TIMELINE_EVERY_MS) {
          lastTimelineAt = t
          for (const run of unfinished) {
            const json = await get(`${base}/builds/${run.id}/timeline?api-version=${ADO_API_VERSION}`)
            if (json === 'unauthorized') return { ...last, error: 'unauthorized' }
            stages.set(run.id, normalizeTimeline(json))
          }
        }
      } catch {
        // Anything that is not a refused PAT — a dropped network, a 429, a 5xx — is temporary:
        // spec §4.3 wants the last known runs dimmed, not a widget emptied by a hiccup.
        return { ...last, error: 'offline' }
      }

      const withStages = builds.map((b) => ({ ...b, stages: stages.get(b.id) ?? [] }))
      last = splitRuns(withStages)
      return last
    },

    commands: {
      /** Opens a run in the Mac's browser. Restricted to Azure DevOps so a widget cannot open anything. */
      open: async (payload, ctx?: CommandContext) => {
        // Opening a page acts on the user's own Mac, so only a client on that Mac may ask for it.
        // Fail closed, like `dock.activate`: no context means the caller is treated as remote.
        if (!ctx?.loopback) throw new Error(tr(undefined, 'provider.localOnly'))
        const raw = String((payload as { url?: unknown })?.url ?? '')
        let parsed: URL
        try {
          parsed = new URL(raw)
        } catch {
          throw new Error(tr(undefined, 'provider.refusedUrl'))
        }
        // `startsWith` would also accept `https://dev.azure.com.evil.com/…` or
        // `https://dev.azure.com@evil.com/…`; only the parsed origin is trustworthy.
        if (parsed.protocol !== 'https:' || parsed.origin !== 'https://dev.azure.com') throw new Error(tr(undefined, 'provider.refusedUrl'))
        await open(raw)
        return { opened: true }
      },
    },
  }
}
