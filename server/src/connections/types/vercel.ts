import { tr } from '../../i18n.js'
import type { ConnectionType, TestResult } from '../types.js'
import { VERCEL_API, VERCEL_TIMEOUT_MS, createVercelProvider } from '../../providers/vercel.js'
import type { VercelDeps } from '../../providers/vercel.js'
import { USER_AGENT } from '../../version.js'

export const vercelType: ConnectionType = {
  id: 'vercel',
  name: 'Vercel',
  description: { fr: 'Déploiements récents des comptes Vercel', en: 'Recent deployments from Vercel accounts' },
  icon: 'triangle',
  fields: [
    { key: 'token', label: { fr: 'Jeton d’accès', en: 'Access token' }, secret: true, required: true,
      help: { fr: 'Le jeton reste dans le coffre de secrets de Fremkit et n’est envoyé qu’à api.vercel.com.', en: 'The token stays in Fremkit’s secret store and is sent only to api.vercel.com.' } },
    { key: 'teamId', label: { fr: 'ID d’équipe (facultatif)', en: 'Team ID (optional)' },
      help: { fr: 'Laissez vide pour le compte personnel. Pour les déploiements d’équipe, saisissez son ID.', en: 'Leave blank for the personal account. Enter a team ID to list team deployments.' } },
  ],
  channelPrefix: 'vercel',
  async test(_fields, secrets, deps: VercelDeps = {}): Promise<TestResult> {
    const token = secrets.token?.trim() ?? ''
    if (!token) return { ok: false, error: tr(undefined, 'vercel.missingToken') }
    const fetchFn = deps.fetchFn ?? fetch
    try {
      const response = await fetchFn(`${VERCEL_API}/v2/user`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(VERCEL_TIMEOUT_MS),
      })
      if (response.ok) {
        const body = await response.json().catch(() => ({})) as { user?: { username?: unknown }; username?: unknown }
        const username = body.user?.username ?? body.username
        return { ok: true, detail: tr(undefined, 'vercel.connected', { account: typeof username === 'string' ? username : '?' }) }
      }
      await response.body?.cancel().catch(() => {})
      if (response.status === 401 || response.status === 403) return { ok: false, error: tr(undefined, 'vercel.tokenRefused') }
      if (response.status === 429) return { ok: false, error: tr(undefined, 'vercel.rateLimited') }
      return { ok: false, error: tr(undefined, 'vercel.unexpected', { status: response.status }) }
    } catch {
      return { ok: false, error: tr(undefined, 'vercel.unreachable') }
    }
  },
  createProvider: (ctx) => createVercelProvider(ctx),
}
