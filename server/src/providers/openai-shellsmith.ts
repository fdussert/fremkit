import { z } from 'zod'
import type { ConnectionProviderContext } from '../connections/types.js'
import { pbPasteboard, type Pasteboard } from './clipboard.js'
import type { CommandContext, Provider } from './types.js'
import { USER_AGENT } from '../version.js'
import { readJsonCapped } from '../net/json.js'

export const OPENAI_API = 'https://api.openai.com/v1'
export const GROQ_API = 'https://api.groq.com/openai/v1'
export const OPENAI_TIMEOUT_MS = 25_000
export const SHELLSMITH_MAX_REQUEST_CHARS = 1000
export const SHELLSMITH_MAX_COMMAND_CHARS = 2000

const ModelSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:/-]+$/)
// The dashboard stamps every widget command with the sending widget instance id.
const INSTANCE = { instanceId: z.string().min(1).max(200).optional() }
const RequestPayload = z.strictObject({ ...INSTANCE, request: z.string().trim().min(1).max(SHELLSMITH_MAX_REQUEST_CHARS) })
const CopyPayload = z.strictObject({ ...INSTANCE, command: z.string().trim().min(1).max(SHELLSMITH_MAX_COMMAND_CHARS) })

interface ResponsesBody {
  output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>
}
interface ChatBody {
  choices?: Array<{ message?: { content?: unknown } }>
}
type CompletionResult =
  | { ok: true; content: string }
  | { ok: false; error: 'unauthorized' | 'rate-limited' | 'unavailable' | 'invalid-response' }

export interface OpenAIShellsmithDeps {
  fetchFn?: typeof fetch
  pasteboard?: Pasteboard
}

type ApiProvider = 'openai' | 'groq'
const providerFor = (fields: Record<string, string>): ApiProvider | null => fields.provider === undefined || fields.provider === '' || fields.provider === 'openai'
  ? 'openai' : fields.provider === 'groq' ? 'groq' : null
const apiFor = (provider: ApiProvider): string => provider === 'groq' ? GROQ_API : OPENAI_API
async function chatCompletion(
  fetchFn: typeof fetch,
  api: string,
  token: string,
  model: string,
  prompt: string,
): Promise<CompletionResult> {
  const reasoningModel = model.startsWith('openai/gpt-oss-')
  let response: Response
  try {
    response = await fetchFn(`${api}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: reasoningModel ? 1200 : 800,
        temperature: 0.2,
        ...(reasoningModel ? { reasoning_effort: 'low', reasoning_format: 'hidden' } : {}),
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    })
  } catch { return { ok: false, error: 'unavailable' } }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return { ok: false, error: response.status === 401 || response.status === 403 ? 'unauthorized'
      : response.status === 429 ? 'rate-limited' : 'unavailable' }
  }
  const body = await readJsonCapped(response, 256 * 1024).catch(() => undefined) as ChatBody | undefined
  const content = body?.choices?.[0]?.message?.content
  return typeof content === 'string' && content.trim()
    ? { ok: true, content: content.trim() }
    : { ok: false, error: 'invalid-response' }
}

/** Makes a bounded suggestion request. The result is text only: this provider has no execution path. */
export function createOpenAIShellsmithProvider(ctx: ConnectionProviderContext, deps: OpenAIShellsmithDeps = {}): Provider {
  const fetchFn = deps.fetchFn ?? fetch
  const pasteboard = deps.pasteboard ?? pbPasteboard
  const token = ctx.secrets.token?.trim() ?? ''
  const modelResult = ModelSchema.safeParse(ctx.fields.model)
  const provider = providerFor(ctx.fields)
  const api = apiFor(provider ?? 'openai')

  return {
    channel: ctx.channel,
    commands: {
      suggestCommand: async (payload, commandContext?: CommandContext) => {
        if (!commandContext?.loopback) return { ok: false, error: 'local-only' }
        const parsed = RequestPayload.safeParse(payload)
        if (!parsed.success || !modelResult.success || !provider) return { ok: false, error: 'invalid-request' }
        if (!token) return { ok: false, error: 'unconfigured' }

        if (provider === 'groq') {
          const completion = await chatCompletion(fetchFn, api, token, modelResult.data,
            `Suggest one shell command for this request. Do not execute it, call tools, or include secrets. Return only command text, without markdown or explanation. Avoid destructive commands unless explicitly requested.\n\nRequest: ${parsed.data.request}`)
          if (!completion.ok) return completion
          if (completion.content.length > SHELLSMITH_MAX_COMMAND_CHARS) return { ok: false, error: 'invalid-response' }
          return { ok: true, command: completion.content }
        }

        let response: Response
        try {
          response = await fetchFn(`${api}/responses`, {
            method: 'POST',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
            },
            body: JSON.stringify({
              model: modelResult.data,
              instructions: 'Suggest one shell command for the user request. Do not execute commands, call tools, or include secrets. Return only the command text, with no markdown or explanation. Avoid destructive commands unless the user explicitly requests them.',
              input: parsed.data.request,
              max_output_tokens: 400,
              store: false,
            }),
            signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
          })
        } catch { return { ok: false, error: 'unavailable' } }

        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          return { ok: false, error: response.status === 401 || response.status === 403 ? 'unauthorized'
            : response.status === 429 ? 'rate-limited' : 'unavailable' }
        }
        const body = await readJsonCapped(response, 256 * 1024).catch(() => undefined) as ResponsesBody | undefined
        const command = body?.output?.flatMap((item) => item.content ?? [])
          .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
          .map((part) => (part.text as string).trim())
          .filter(Boolean)
          .join('\n')
        if (!command || command.length > SHELLSMITH_MAX_COMMAND_CHARS) return { ok: false, error: 'invalid-response' }
        return { ok: true, command }
      },
      copyCommand: async (payload, commandContext?: CommandContext) => {
        if (!commandContext?.loopback) return { ok: false, error: 'local-only' }
        const parsed = CopyPayload.safeParse(payload)
        if (!parsed.success) return { ok: false, error: 'invalid-command' }
        try {
          await pasteboard.write(parsed.data.command)
          return { ok: true }
        } catch { return { ok: false, error: 'copy-failed' } }
      },
    },
  }
}
