import type { Provider } from '../providers/types.js'
import type { Config } from '../config/schema.js'
import type { CodexSnapshot, HistoryThread, SnapshotPart } from '../codex/snapshot.js'
import { emptyPart, emptySnapshot } from '../codex/snapshot.js'
import type { SessionObservation, SessionsSnapshot } from '../codex/observations.js'
import type { HistorySource } from '../codex/sources.js'
import { clamp, wander } from './world.js'

/**
 * The Codex channels, as demo mode answers them: `codex` (account, quotas, usage, the stored
 * threads) and `codex-live` (what each thread is doing now).
 *
 * The same switches as the real provider decide what is published: the account half only with
 * `privacy.codexAccount`, the threads only from the sources `privacy.codexHistorySources` ticks,
 * and the live half only when some source is. The seed ticks them, so a fresh demo shows it all.
 */

const MIN = 60_000

/** The invented threads: placeholder projects, the same ones the other demo widgets name. */
const THREADS: {
  id: string; title: string; source: HistorySource; project: string; branch: string
  state: SessionObservation['state']; minutesAgo: number; model: string; effort: string; agents: number
}[] = [
  { id: '0d5e7a10-4c1b-4f2e-9a01-000000000001', title: 'Add a monthly / yearly toggle to the pricing page', source: 'vscode', project: 'website', branch: 'feature/pricing', state: 'working', minutesAgo: 14, model: 'gpt-5-codex', effort: 'medium', agents: 2 },
  { id: '0d5e7a10-4c1b-4f2e-9a01-000000000002', title: 'Retry uploads on a flaky network', source: 'cli', project: 'mobile-app', branch: 'hotfix/upload-retry', state: 'waiting', minutesAgo: 6, model: 'gpt-5-codex', effort: 'high', agents: 0 },
  { id: '0d5e7a10-4c1b-4f2e-9a01-000000000003', title: 'Rate-limit the public endpoints', source: 'cli', project: 'api', branch: 'feature/rate-limit', state: 'done', minutesAgo: 41, model: 'gpt-5', effort: 'low', agents: 0 },
  { id: '0d5e7a10-4c1b-4f2e-9a01-000000000004', title: 'Write the changelog for 2.4', source: 'appServer', project: 'website', branch: 'main', state: 'done', minutesAgo: 95, model: 'gpt-5', effort: 'medium', agents: 0 },
]

function selected(source: HistorySource, sources: HistorySource[]): boolean {
  return sources.includes(source) || (sources.includes('subAgent') && source.startsWith('subAgent'))
}

function fresh<T>(data: T, t: number): SnapshotPart<T> {
  return { data, updatedAt: t, freshness: 'fresh', error: null }
}

export function codexSnapshot(t: number, privacy: Config['privacy']): CodexSnapshot {
  const sources = privacy.codexHistorySources
  if (!privacy.codexAccount && !sources.length) return emptySnapshot('unconfigured')
  const day = (offset: number): string => {
    const d = new Date(t)
    d.setDate(d.getDate() - offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const threads: HistoryThread[] = THREADS
    .filter((th) => selected(th.source, sources))
    .map((th) => ({
      id: th.id,
      title: th.title,
      sourceKind: th.source,
      createdAt: Math.floor((t - (th.minutesAgo + 30) * MIN) / 1000),
      updatedAt: Math.floor((t - (th.state === 'working' ? 0 : th.minutesAgo) * MIN) / 1000),
      liveActivity: null,
      navigation: 'localChat' as const,
    }))
  const seconds = (hours: number): number => Math.floor(t / 1000) + Math.round(hours * 3600)
  const fiveHour = Math.round(clamp(wander(t, 34, 8, 900_000), 0, 100))
  return {
    sourceKind: 'localAppServer',
    authMode: privacy.codexAccount ? 'chatgpt' : null,
    account: privacy.codexAccount ? fresh({ type: 'chatgpt' as const, planType: 'pro' }, t) : emptyPart('unconfigured'),
    quotas: privacy.codexAccount
      ? fresh({
          buckets: [{
            id: 'codex', name: null,
            primary: { usedPercent: fiveHour, remainingPercent: 100 - fiveHour, windowDurationMins: 300, resetsAt: seconds(2.6) },
            secondary: { usedPercent: 47, remainingPercent: 53, windowDurationMins: 10_080, resetsAt: seconds(83) },
          }],
        }, t)
      : emptyPart('unconfigured'),
    usage: privacy.codexAccount
      ? fresh({
          summary: { lifetimeTokens: 184_300_000, peakDailyTokens: 6_420_000, currentStreakDays: 9, longestStreakDays: 23, longestRunningTurnSec: 2_710 },
          dailyUsageBuckets: Array.from({ length: 14 }, (_, i) => ({ startDate: day(13 - i), tokens: 1_200_000 + ((i * 7919) % 9) * 410_000 })),
        }, t)
      : emptyPart('unconfigured'),
    history: sources.length ? fresh({ threads, nextCursor: null, truncated: false }, t) : emptyPart('unconfigured'),
    checkedAt: t,
    error: null,
  }
}

function observation(th: typeof THREADS[number], t: number): SessionObservation {
  // A turn that runs for up to six minutes, then starts over: the elapsed time moves.
  const turnMs = th.state === 'working' ? 20_000 + (t % (6 * MIN)) : th.state === 'waiting' ? 3 * MIN : 7 * MIN + 12_000
  const startedAt = th.state === 'working' ? t - turnMs : t - th.minutesAgo * MIN - turnMs
  const finishedAt = th.state === 'done' ? startedAt + turnMs : null
  const turn = {
    turnId: `turn-${th.id.slice(-4)}`,
    startedAt,
    finishedAt,
    lastEventAt: th.state === 'working' ? t - 3_000 : (finishedAt ?? t - th.minutesAgo * MIN),
    model: th.model,
    effort: th.effort,
    durationMs: finishedAt === null ? null : turnMs,
  }
  const subagents: SessionObservation[] = Array.from({ length: th.agents }, (_, i) => ({
    ...turn,
    id: th.id.slice(0, -2) + String(10 + i),
    parentId: th.id,
    state: i === 0 ? 'working' : 'done',
    finishedAt: i === 0 ? null : startedAt + 90_000,
    durationMs: i === 0 ? null : 90_000,
    project: th.project, branch: th.branch, modelSource: 'turn',
    nickname: i === 0 ? 'tests' : 'review', role: i === 0 ? 'worker' : 'reviewer',
    agentName: i === 0 ? 'Test writer' : 'Reviewer',
    subagents: [], subagentCount: 0, agentsTruncated: false,
  }))
  return {
    ...turn,
    state: th.state,
    id: th.id, parentId: null,
    project: th.project, branch: th.branch, modelSource: 'turn',
    nickname: null, role: null, agentName: null,
    subagents, subagentCount: subagents.length, agentsTruncated: false,
  }
}

export function codexLiveSnapshot(t: number, privacy: Config['privacy']): SessionsSnapshot {
  const sources = privacy.codexHistorySources
  if (!sources.length) return { sessions: [], updatedAt: null, error: 'unconfigured', truncated: false }
  return {
    sessions: THREADS.filter((th) => selected(th.source, sources)).map((th) => observation(th, t)),
    updatedAt: t,
    error: null,
    truncated: false,
  }
}

/** Opening a thread would focus the Codex app on the Mac: answered, and nothing done. */
export function codexProviders(now: () => number, config: () => Config): Provider[] {
  return [
    {
      channel: 'codex', intervalMs: 60_000,
      poll: async () => codexSnapshot(now(), config().privacy),
      commands: { open: async () => ({ ok: true }) },
    },
    { channel: 'codex-live', intervalMs: 5_000, poll: async () => codexLiveSnapshot(now(), config().privacy) },
  ]
}
