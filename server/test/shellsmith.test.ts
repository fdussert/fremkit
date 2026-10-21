import { describe, expect, it } from 'vitest'
import { tr } from '../src/i18n.js'
import { defaultConnectionTypes } from '../src/connections/types/index.js'
import { openAIShellsmithType } from '../src/connections/types/openai-shellsmith.js'
import { createOpenAIShellsmithProvider } from '../src/providers/openai-shellsmith.js'

const context = () => ({
  id: 'shellsmith',
  channel: 'openai-shellsmith:shellsmith',
  fields: { model: 'gpt-4.1-mini' },
  secrets: { token: 'private-test-token' },
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('ShellSmith command suggestion provider', () => {
  it('sends a bounded request to the fixed Responses API and returns text without executing it', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'find . -type f' }] }] })
    }) as typeof fetch
    const provider = createOpenAIShellsmithProvider(context(), {
      fetchFn,
      pasteboard: { read: async () => '', write: async () => {}, types: async () => [] },
    })

    const result = await provider.commands!.suggestCommand({ request: 'Find files in this folder' }, { loopback: true })

    expect(result).toEqual({ ok: true, command: 'find . -type f' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses')
    expect(calls[0].init?.redirect).toBe('error')
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer private-test-token')
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body.model).toBe('gpt-4.1-mini')
    expect(body.store).toBe(false)
    expect(body.input).toContain('Find files in this folder')
    expect(body.tools).toBeUndefined()
  })

  it('rejects remote callers and malformed or oversized requests before calling the API', async () => {
    let requests = 0
    const provider = createOpenAIShellsmithProvider(context(), {
      fetchFn: (async () => { requests++; return json({}) }) as typeof fetch,
      pasteboard: { read: async () => '', write: async () => {}, types: async () => [] },
    })

    expect(await provider.commands!.suggestCommand({ request: 'list files' }, { loopback: false })).toEqual({ ok: false, error: 'local-only' })
    expect(await provider.commands!.suggestCommand({ request: 'x'.repeat(2001) }, { loopback: true })).toEqual({ ok: false, error: 'invalid-request' })
    expect(await provider.commands!.suggestCommand({ request: '   ' }, { loopback: true })).toEqual({ ok: false, error: 'invalid-request' })
    expect(requests).toBe(0)
  })

  it('accepts the dashboard-stamped instance id but rejects other unknown payload fields', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return json({ choices: [{ message: { content: 'find . -type f' } }] })
    }) as typeof fetch
    const provider = createOpenAIShellsmithProvider({
      ...context(),
      fields: { provider: 'groq', model: 'openai/gpt-oss-20b' },
    }, {
      fetchFn,
      pasteboard: { read: async () => '', write: async () => {}, types: async () => [] },
    })
    // Mirrors the host's stampInstance() contract: every plain-object command gets this field.
    const payload = { request: 'List files', instanceId: 'shellsmith-command-showcase' }

    expect(await provider.commands!.suggestCommand(payload, { loopback: true })).toEqual({ ok: true, command: 'find . -type f' })
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body.messages[0].content).toContain('List files')
    expect(JSON.stringify(body)).not.toContain('shellsmith-command-showcase')
    expect(await provider.commands!.suggestCommand({ ...(payload as object), unexpected: true }, { loopback: true })).toEqual({ ok: false, error: 'invalid-request' })
    expect(calls).toHaveLength(1)
  })

  it('copies only on an explicit loopback command and never runs the generated text', async () => {
    const writes: string[] = []
    const provider = createOpenAIShellsmithProvider(context(), {
      fetchFn: (async () => json({})) as typeof fetch,
      pasteboard: { read: async () => '', write: async (text) => { writes.push(text) }, types: async () => [] },
    })

    expect(await provider.commands!.copyCommand({ command: 'echo reviewed' }, { loopback: false })).toEqual({ ok: false, error: 'local-only' })
    expect(writes).toEqual([])
    expect(await provider.commands!.copyCommand({ command: 'echo reviewed', instanceId: 'shellsmith-command-showcase' }, { loopback: true })).toEqual({ ok: true })
    expect(writes).toEqual(['echo reviewed'])
  })

  it('uses the fixed Groq host for a bounded suggestion and keeps the result copy-only', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return json({ choices: [{ message: { content: 'find . -type f' } }] })
    }) as typeof fetch
    const provider = createOpenAIShellsmithProvider({
      ...context(),
      fields: { provider: 'groq', model: 'openai/gpt-oss-20b' },
    }, {
      fetchFn,
      pasteboard: { read: async () => '', write: async () => {}, types: async () => [] },
    })

    const result = await provider.commands!.suggestCommand({ request: 'Find files in this folder' }, { loopback: true })

    expect(result).toEqual({ ok: true, command: 'find . -type f' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(calls[0].init?.redirect).toBe('error')
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer private-test-token')
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body.model).toBe('openai/gpt-oss-20b')
    expect(body.reasoning_effort).toBe('low')
    expect(body.reasoning_format).toBe('hidden')
    expect(body.max_completion_tokens).toBeGreaterThan(400)
    expect(body.tools).toBeUndefined()
  })

  it('translates the current selected text and pastes the translation back over it', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    let selectionReads = 0
    let clipboardReads = 0
    let clipboardTypeReads = 0
    let copyReads = 0
    let pastes = 0
    const written: string[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return json({ choices: [{ message: { content: JSON.stringify({ sourceLanguage: 'English', text: 'Bonjour' }) } }] })
    }) as typeof fetch
    const provider = createOpenAIShellsmithProvider({
      ...context(),
      fields: { provider: 'groq', model: 'openai/gpt-oss-20b' },
    }, {
      fetchFn,
      selectedText: async () => { selectionReads++; return { ok: true, text: 'Hello from the focused selection' } },
      copiedText: async () => { copyReads++; return { ok: false, error: 'no-selection' } },
      pasteSelection: async () => { pastes++ },
      pasteboard: { types: async () => { clipboardTypeReads++; return [] }, read: async () => { clipboardReads++; return 'stale clipboard text' }, write: async (text) => { written.push(text) } },
    })

    const result = await provider.commands!.translateSelection({ favorites: ['en', 'fr'], instanceId: 'translate-selection-showcase' }, { loopback: true })

    expect(result).toEqual({ ok: true, sourceLanguage: 'en', targetLanguage: 'fr', text: 'Bonjour' })
    expect(selectionReads).toBe(1)
    expect(copyReads).toBe(0)
    expect(clipboardReads).toBe(0)
    expect(clipboardTypeReads).toBe(0)
    expect(written).toEqual(['Bonjour'])
    expect(pastes).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.reasoning_effort).toBe('low')
    expect(body.reasoning_format).toBe('hidden')
    expect(body.messages.map((message: { content: string }) => message.content).join('\n')).toContain('Hello from the focused selection')
    expect(body.messages.map((message: { content: string }) => message.content).join('\n')).not.toContain('stale clipboard text')
  })

  it('refuses secure focused fields before making a request or falling back to ⌘C', async () => {
    let requests = 0
    let clipboardReads = 0
    let copyReads = 0
    const provider = createOpenAIShellsmithProvider(context(), {
      fetchFn: (async () => { requests++; return json({}) }) as typeof fetch,
      selectedText: async () => ({ ok: false, error: 'secure-field' }),
      copiedText: async () => { copyReads++; return { ok: true, text: 'should never be read' } },
      pasteboard: { types: async () => { clipboardReads++; return [] }, read: async () => { clipboardReads++; return 'clipboard contents' }, write: async () => { clipboardReads++ } },
    })

    expect(await provider.commands!.translateSelection({ favorites: ['en', 'fr'] }, { loopback: true })).toEqual({ ok: false, error: 'secure-field' })
    expect(clipboardReads).toBe(0)
    expect(copyReads).toBe(0)
    expect(requests).toBe(0)
  })

  it('falls back to a ⌘C copy when the focused app never reports a selection', async () => {
    let copied = 0
    let pastes = 0
    const written: string[] = []
    const provider = createOpenAIShellsmithProvider(context(), {
      fetchFn: (async () => json({ choices: [{ message: { content: JSON.stringify({ sourceLanguage: 'en', text: 'Bonjour' }) } }] })) as typeof fetch,
      selectedText: async () => ({ ok: false, error: 'no-selection' }),
      copiedText: async () => { copied++; return { ok: true, text: 'Hello copied by keyboard' } },
      pasteSelection: async () => { pastes++ },
      pasteboard: { types: async () => [], read: async () => '', write: async (text) => { written.push(text) } },
    })

    const result = await provider.commands!.translateSelection({ favorites: ['en', 'fr'], instanceId: 'translate-selection-showcase' }, { loopback: true })
    expect(result).toEqual({ ok: true, sourceLanguage: 'en', targetLanguage: 'fr', text: 'Bonjour' })
    expect(copied).toBe(1)
    expect(written).toEqual(['Bonjour'])
    expect(pastes).toBe(1)
  })

  it.each([
    ['no selection', 'no-selection', 'empty-selection'],
    ['permission denied', 'permission-required', 'permission-required'],
  ])('does not call the model or touch any clipboard format on %s', async (_label, nativeError, expectedError) => {
    let requests = 0
    let clipboardCalls = 0
    const provider = createOpenAIShellsmithProvider(context(), {
      fetchFn: (async () => { requests++; return json({}) }) as typeof fetch,
      selectedText: async () => ({ ok: false, error: nativeError as 'no-selection' | 'permission-required' }),
      copiedText: async () => ({ ok: false, error: nativeError as 'no-selection' | 'permission-required' }),
      pasteboard: {
        types: async () => { clipboardCalls++; return [] },
        read: async () => { clipboardCalls++; return 'clipboard contents' },
        write: async () => { clipboardCalls++ },
      },
    })

    expect(await provider.commands!.translateSelection({ favorites: ['en', 'fr'] }, { loopback: true })).toEqual({ ok: false, error: expectedError })
    expect(requests).toBe(0)
    expect(clipboardCalls).toBe(0)
  })

  it('registers an OpenAI-compatible connection with a secret token', async () => {
    expect(defaultConnectionTypes().some((type) => type.id === 'openai-shellsmith')).toBe(true)
    expect(openAIShellsmithType.fields.find((field) => field.key === 'token')).toMatchObject({ secret: true, required: true })

    let requestedUrl = ''
    let requestedRedirect: RequestInit['redirect']
    const result = await openAIShellsmithType.test({ model: 'gpt-4.1-mini' }, { token: 'private-test-token' }, {
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(url)
        requestedRedirect = init?.redirect
        return json({ id: 'gpt-4.1-mini' })
      }) as typeof fetch,
    })

    expect(requestedUrl).toBe('https://api.openai.com/v1/models/gpt-4.1-mini')
    expect(requestedRedirect).toBe('error')
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-test-token')
  })

  it('checks Groq models through the fixed models endpoint without returning the secret', async () => {
    let requestedUrl = ''
    let requestedRedirect: RequestInit['redirect']
    const result = await openAIShellsmithType.test({ provider: 'groq', model: 'openai/gpt-oss-20b' }, { token: 'private-test-token' }, {
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(url)
        requestedRedirect = init?.redirect
        return json({ data: [{ id: 'openai/gpt-oss-20b' }] })
      }) as typeof fetch,
    })

    expect(requestedUrl).toBe('https://api.groq.com/openai/v1/models')
    expect(requestedRedirect).toBe('error')
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-test-token')
  })

  it('uses the fixed Ollama Cloud host for a bounded suggestion', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return json({ choices: [{ message: { content: 'ls -la' } }] })
    }) as typeof fetch
    const provider = createOpenAIShellsmithProvider({
      ...context(),
      fields: { provider: 'ollama', model: 'gpt-oss:120b' },
    }, {
      fetchFn,
      pasteboard: { read: async () => '', write: async () => {}, types: async () => [] },
    })

    const result = await provider.commands!.suggestCommand({ request: 'List files' }, { loopback: true })

    expect(result).toEqual({ ok: true, command: 'ls -la' })
    expect(calls[0].url).toBe('https://ollama.com/v1/chat/completions')
    expect(calls[0].init?.redirect).toBe('error')
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer private-test-token')
    expect(JSON.parse(String(calls[0].init?.body)).reasoning_format).toBeUndefined()
  })

  it('checks Ollama Cloud models through the fixed models endpoint without returning the secret', async () => {
    let requestedUrl = ''
    const result = await openAIShellsmithType.test({ provider: 'ollama', model: 'gpt-oss:120b' }, { token: 'private-test-token' }, {
      fetchFn: (async (url: string | URL | Request) => {
        requestedUrl = String(url)
        return json({ data: [{ id: 'gpt-oss:120b' }] })
      }) as typeof fetch,
    })

    expect(requestedUrl).toBe('https://ollama.com/v1/models')
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-test-token')
  })

  it('offers a fixed set of favorite languages for Translate Selection', async () => {
    const options = await openAIShellsmithType.options!('languages', {}, {})

    expect(options).toContainEqual({ value: 'en', label: 'English' })
    expect(options).toContainEqual({ value: 'fr', label: 'Français' })
  })

  it('rejects an unknown options source before any fetch', async () => {
    let requests = 0
    await expect(openAIShellsmithType.options!('zones', {}, {}, {
      fetchFn: (async () => { requests++; return json({}) }) as typeof fetch,
    })).rejects.toMatchObject({ status: 400 })
    expect(requests).toBe(0)
  })
})
