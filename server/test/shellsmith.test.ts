import { describe, expect, it } from 'vitest'
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
  it('exposes only commands used by ShellSmith', () => {
    const provider = createOpenAIShellsmithProvider(context())

    expect(Object.keys(provider.commands ?? {}).sort()).toEqual(['copyCommand', 'suggestCommand'])
  })

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

  it('registers an OpenAI-compatible connection with a secret token and a fixed provider choice', async () => {
    expect(defaultConnectionTypes().some((type) => type.id === 'openai-shellsmith')).toBe(true)
    expect(openAIShellsmithType.fields.find((field) => field.key === 'token')).toMatchObject({ secret: true, required: true })
    expect(openAIShellsmithType.fields.find((field) => field.key === 'model')).toMatchObject({ required: true })
    expect(openAIShellsmithType.fields.find((field) => field.key === 'provider')?.options).toEqual(['openai', 'groq'])
    expect(openAIShellsmithType.fields.some((field) => field.key === 'baseUrl')).toBe(false)

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

})
