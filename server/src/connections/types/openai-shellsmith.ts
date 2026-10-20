import { tr } from '../../i18n.js'
import type { ConnectionType, TestResult } from '../types.js'
import { GROQ_API, OPENAI_API, OPENAI_TIMEOUT_MS, createOpenAIShellsmithProvider } from '../../providers/openai-shellsmith.js'
import type { OpenAIShellsmithDeps } from '../../providers/openai-shellsmith.js'
import { USER_AGENT } from '../../version.js'
import { readJsonCapped } from '../../net/json.js'

const ModelSchema = /^[A-Za-z0-9._:/-]{1,100}$/
const providerFor = (fields: Record<string, string>): 'openai' | 'groq' | null => fields.provider === undefined || fields.provider === '' || fields.provider === 'openai'
  ? 'openai' : fields.provider === 'groq' ? 'groq' : null

export const openAIShellsmithType: ConnectionType = {
  id: 'openai-shellsmith',
  name: 'OpenAI-compatible AI',
  description: { fr: 'Suggestions de commandes via une API compatible OpenAI', en: 'Command suggestions through an OpenAI-compatible API' },
  icon: 'sparkles',
  secretBindings: ['provider'],
  fields: [
    { key: 'provider', label: { fr: 'Fournisseur API', en: 'API provider' }, options: ['openai', 'groq'],
      help: { fr: 'Le jeton est envoyé uniquement à l’hôte fixe du fournisseur choisi. Sans choix, OpenAI est utilisé.', en: 'The token is sent only to the selected provider’s fixed host. OpenAI is used when no choice is saved.' } },
    { key: 'model', label: { fr: 'ID du modèle', en: 'Model ID' }, required: true,
      placeholder: 'openai/gpt-oss-20b',
      help: { fr: 'Saisissez un modèle activé pour votre compte. Groq accepte notamment openai/gpt-oss-20b.', en: 'Enter a model enabled for your account. Groq supports openai/gpt-oss-20b, among others.' } },
    { key: 'token', label: { fr: 'Clé API', en: 'API key' }, secret: true, required: true,
      help: { fr: 'La clé reste dans le coffre de secrets. Les requêtes ne partent qu’après une action explicite.', en: 'The key stays in Fremkit’s secret store. Requests are sent only after an explicit action.' } },
  ],
  channelPrefix: 'openai-shellsmith',
  async test(fields, secrets, deps: OpenAIShellsmithDeps = {}): Promise<TestResult> {
    const provider = providerFor(fields)
    const model = fields.model?.trim() ?? ''
    const token = secrets.token?.trim() ?? ''
    if (!provider || !ModelSchema.test(model) || !token) return { ok: false, error: tr(undefined, 'shellsmith.unconfigured') }
    try {
      const response = provider === 'groq'
        ? await (deps.fetchFn ?? fetch)(`${GROQ_API}/models`, {
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        })
        : await (deps.fetchFn ?? fetch)(`${OPENAI_API}/models/${encodeURIComponent(model)}`, {
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return { ok: false, error: response.status === 401 || response.status === 403 ? tr(undefined, 'shellsmith.tokenRefused')
          : response.status === 429 ? tr(undefined, 'shellsmith.rateLimited')
            : response.status === 404 ? tr(undefined, 'shellsmith.modelUnavailable')
              : tr(undefined, 'shellsmith.unexpected', { status: response.status }) }
      }
      const body = await readJsonCapped(response).catch(() => undefined) as { id?: unknown; data?: Array<{ id?: unknown }> } | undefined
      const modelAvailable = provider === 'groq'
        ? body?.data?.some((item) => item.id === model) === true
        : body?.id === model
      return modelAvailable ? { ok: true, detail: tr(undefined, 'shellsmith.connected', { model }) }
        : { ok: false, error: tr(undefined, 'shellsmith.unexpected', { status: 200 }) }
    } catch { return { ok: false, error: tr(undefined, 'shellsmith.unreachable') } }
  },
  createProvider: (ctx) => createOpenAIShellsmithProvider(ctx),
}
