import { z } from 'zod'
import type { ConnectionProviderContext } from '../connections/types.js'
import { pbPasteboard, type Pasteboard } from './clipboard.js'
import { copySelectedText, pasteSelection, readSelectedText, type SelectedTextResult } from './selected-text.js'
import type { CommandContext, Provider } from './types.js'
import { USER_AGENT } from '../version.js'
import { readJsonCapped } from '../net/json.js'

export const OPENAI_API = 'https://api.openai.com/v1'
export const GROQ_API = 'https://api.groq.com/openai/v1'
export const OLLAMA_API = 'https://ollama.com/v1'
export const OPENAI_TIMEOUT_MS = 25_000
export const SHELLSMITH_MAX_REQUEST_CHARS = 1000
export const SHELLSMITH_MAX_COMMAND_CHARS = 2000
export const TRANSLATE_MAX_TEXT_BYTES = 2048

const ModelSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:/-]+$/)
// The dashboard stamps every widget command with the sending widget instance id.
const INSTANCE = { instanceId: z.string().min(1).max(200).optional() }
const RequestPayload = z.strictObject({ ...INSTANCE, request: z.string().trim().min(1).max(SHELLSMITH_MAX_REQUEST_CHARS) })
const CopyPayload = z.strictObject({ ...INSTANCE, command: z.string().trim().min(1).max(SHELLSMITH_MAX_COMMAND_CHARS) })
const FavoritesPayload = z.strictObject({ ...INSTANCE, favorites: z.array(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/)).length(2) })
const TranslationResponse = z.strictObject({ sourceLanguage: z.string().trim().min(2).max(20), text: z.string().trim().min(1).max(20_000) })

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
  selectedText?: () => Promise<SelectedTextResult>
  copiedText?: () => Promise<SelectedTextResult>
  pasteSelection?: () => Promise<void>
}

type ApiProvider = 'openai' | 'groq' | 'ollama'
const providerFor = (fields: Record<string, string>): ApiProvider | null => fields.provider === undefined || fields.provider === '' || fields.provider === 'openai'
  ? 'openai' : fields.provider === 'groq' || fields.provider === 'ollama' ? fields.provider : null
const apiFor = (provider: ApiProvider): string => provider === 'groq' ? GROQ_API : provider === 'ollama' ? OLLAMA_API : OPENAI_API
const languageAliases: Record<string, string> = {
  english: 'en', français: 'fr', french: 'fr', deutsch: 'de', german: 'de', español: 'es', spanish: 'es',
  italiano: 'it', italian: 'it', português: 'pt', portuguese: 'pt', nederlands: 'nl', dutch: 'nl',
  日本語: 'ja', japanese: 'ja', 中文: 'zh', chinese: 'zh',
}
const baseLanguage = (code: string): string => languageAliases[code.trim().toLowerCase()] ?? code.split('-')[0].toLowerCase()

async function chatCompletion(
  fetchFn: typeof fetch,
  api: string,
  token: string,
  model: string,
  prompt: string,
  json: boolean,
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
        ...(json ? { response_format: { type: 'json_object' } } : {}),
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
  const selectedText = deps.selectedText ?? readSelectedText
  const copiedText = deps.copiedText ?? copySelectedText
  const paste = deps.pasteSelection ?? pasteSelection
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

        // OpenAI itself uses /responses; Groq and Ollama Cloud only speak chat completions.
        if (provider !== 'openai') {
          const completion = await chatCompletion(fetchFn, api, token, modelResult.data,
            `Suggest one shell command for this request. Do not execute it, call tools, or include secrets. Return only command text, without markdown or explanation. Avoid destructive commands unless explicitly requested.\n\nRequest: ${parsed.data.request}`,
            false)
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
      translateSelection: async (payload, commandContext?: CommandContext) => {
        if (!commandContext?.loopback) return { ok: false, error: 'local-only' }
        const parsed = FavoritesPayload.safeParse(payload)
        if (!provider) return { ok: false, error: 'invalid-request' }
        if (!parsed.success || !modelResult.success) return { ok: false, error: 'choose-two-languages' }
        const [favoriteA, favoriteB] = parsed.data.favorites
        const aBase = baseLanguage(favoriteA)
        const bBase = baseLanguage(favoriteB)
        if (aBase === bBase) return { ok: false, error: 'choose-two-languages' }
        if (!token) return { ok: false, error: 'unconfigured' }

        let selection: SelectedTextResult
        try { selection = await selectedText() } catch { return { ok: false, error: 'selection-unavailable' } }
        if (!selection.ok && (selection.error === 'no-selection' || selection.error === 'unavailable')) {
          // Editors that never report the selection through Accessibility still answer ⌘C.
          try { selection = await copiedText() } catch { return { ok: false, error: 'selection-unavailable' } }
        }
        if (!selection.ok) {
          const error = selection.error === 'no-selection' ? 'empty-selection'
            : selection.error === 'unavailable' ? 'selection-unavailable' : selection.error
          return { ok: false, error }
        }
        const text = selection.text
        if (!text.trim()) return { ok: false, error: 'empty-selection' }
        if (new TextEncoder().encode(text).byteLength > TRANSLATE_MAX_TEXT_BYTES) return { ok: false, error: 'text-too-long' }

        const prompt = `Translate the text below into whichever of these two favorite languages is different from its source: ${favoriteA} and ${favoriteB}. Identify the source language accurately. Return only a JSON object with string properties sourceLanguage (a short language code such as en or fr) and text (the translation). If the source is neither favorite, still identify its actual language; the app will refuse to show a translation. Preserve the meaning and formatting.\n\nText to translate:\n${text}`
        const completion = await chatCompletion(fetchFn, api, token, modelResult.data, prompt, true)
        if (!completion.ok) return completion
        let translation: z.infer<typeof TranslationResponse>
        try { translation = TranslationResponse.parse(JSON.parse(completion.content)) } catch { return { ok: false, error: 'invalid-response' } }
        const sourceBase = baseLanguage(translation.sourceLanguage)
        // Copy → translate → paste: the translation replaces the still-selected source text in
        // the app it was copied from, and stays on the pasteboard for a second ⌘V. A failed
        // write skips the keystroke, so an old clipboard can never land by accident.
        try {
          await pasteboard.write(translation.text)
          try { await paste() } catch { /* the tile and the pasteboard still carry it */ }
        } catch { /* the tile still shows it */ }
        if (sourceBase === aBase) return { ok: true, sourceLanguage: sourceBase, targetLanguage: favoriteB, text: translation.text }
        if (sourceBase === bBase) return { ok: true, sourceLanguage: sourceBase, targetLanguage: favoriteA, text: translation.text }
        return { ok: false, error: 'language-not-favorite' }
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
