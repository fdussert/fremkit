import type { ConnectionProviderContext } from '../connections/types.js'
import type { Provider } from './types.js'
import { USER_AGENT } from '../version.js'
import { readJsonCapped } from '../net/json.js'

export const VERCEL_API = 'https://api.vercel.com'
export const VERCEL_TIMEOUT_MS = 10_000
export const VERCEL_POLL_MS = 60_000

export interface VercelDeployment {
  id: string
  name: string
  url: string | null
  state: string
  createdAt: number
  target: string | null
}

export interface VercelSnapshot {
  deployments: VercelDeployment[]
  error?: 'unconfigured' | 'unauthorized' | 'rate-limited' | 'offline'
}

export interface VercelDeps { fetchFn?: typeof fetch; now?: () => number }

const stateLabel = (value: unknown): string => {
  const state = typeof value === 'string' ? value.toUpperCase() : ''
  return ['BUILDING', 'ERROR', 'INITIALIZING', 'QUEUED', 'READY', 'CANCELED', 'DEPLOYING'].includes(state)
    ? state
    : 'UNKNOWN'
}

function parseDeployment(value: unknown): VercelDeployment | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const id = typeof item.uid === 'string' ? item.uid : typeof item.id === 'string' ? item.id : ''
  const name = typeof item.name === 'string' ? item.name : ''
  if (!id || !name) return null
  const rawUrl = typeof item.url === 'string' ? item.url : null
  const url = rawUrl && /^[A-Za-z0-9.-]+$/.test(rawUrl) ? rawUrl : null
  const createdAt = Number(item.createdAt ?? item.created)
  return {
    id: id.slice(0, 200),
    name: name.slice(0, 200),
    url,
    state: stateLabel(item.state ?? item.readyState),
    createdAt: Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : 0,
    target: typeof item.target === 'string' ? item.target.slice(0, 40) : null,
  }
}

/** Read-only deployment snapshots for a Vercel personal account or selected team. */
export function createVercelProvider(ctx: ConnectionProviderContext, deps: VercelDeps = {}): Provider<VercelSnapshot> {
  const fetchFn = deps.fetchFn ?? fetch
  const token = ctx.secrets.token?.trim() ?? ''
  const teamId = ctx.fields.teamId?.trim() ?? ''
  let lastGood: VercelDeployment[] = []

  return {
    channel: ctx.channel,
    intervalMs: VERCEL_POLL_MS,
    async poll() {
      if (!token) return { deployments: lastGood, error: 'unconfigured' }
      const query = new URLSearchParams({ limit: '10' })
      if (teamId) query.set('teamId', teamId)
      try {
        const response = await fetchFn(`${VERCEL_API}/v6/deployments?${query}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(VERCEL_TIMEOUT_MS),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          const error = response.status === 401 || response.status === 403 ? 'unauthorized'
            : response.status === 429 ? 'rate-limited' : 'offline'
          return { deployments: lastGood, error }
        }
        const body = await readJsonCapped(response).catch(() => undefined) as { deployments?: unknown } | undefined
        if (!Array.isArray(body?.deployments)) return { deployments: lastGood, error: 'offline' }
        const parsed = body.deployments.slice(0, 10).map(parseDeployment)
        if (parsed.some((row) => row === null)) return { deployments: lastGood, error: 'offline' }
        lastGood = parsed.filter((row): row is VercelDeployment => row !== null)
        return { deployments: lastGood }
      } catch {
        return { deployments: lastGood, error: 'offline' }
      }
    },
  }
}
