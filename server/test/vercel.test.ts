import { describe, expect, it } from 'vitest'
import { defaultConnectionTypes } from '../src/connections/types/index.js'
import { vercelType } from '../src/connections/types/vercel.js'
import { createVercelProvider } from '../src/providers/vercel.js'

const deployment = {
  uid: 'dpl_123',
  name: 'example-site',
  url: 'example-site-abc.vercel.app',
  state: 'READY',
  createdAt: 1_800_000_000_000,
  target: 'production',
}
const context = () => ({ id: 'primary', channel: 'vercel:primary', fields: { teamId: 'team_123' }, secrets: { token: 'private-test-token' } })
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

describe('Vercel connection and deployment provider', () => {
  it('registers a secret-backed connection type', () => {
    expect(defaultConnectionTypes().some((type) => type.id === 'vercel')).toBe(true)
    expect(vercelType.fields.find((field) => field.key === 'token')).toMatchObject({ secret: true, required: true })
  })

  it('fetches a bounded recent deployment list from the fixed API host and maps safe fields', async () => {
    const requests: { url: string; authorization: string | null }[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') })
      return json({ deployments: [deployment] })
    }) as typeof fetch
    const provider = createVercelProvider(context(), { fetchFn })

    expect(await provider.poll!()).toEqual({ deployments: [{ id: 'dpl_123', name: 'example-site', url: 'example-site-abc.vercel.app', state: 'READY', createdAt: 1_800_000_000_000, target: 'production' }] })
    expect(requests).toEqual([{ url: 'https://api.vercel.com/v6/deployments?limit=10&teamId=team_123', authorization: 'Bearer private-test-token' }])
  })

  it('returns an offline-safe snapshot for an unauthorized token without echoing it', async () => {
    const provider = createVercelProvider(context(), { fetchFn: (async () => json({ error: { code: 'forbidden' } }, 403)) as typeof fetch })
    const snapshot = await provider.poll!() as { deployments: unknown[]; error?: string }
    expect(snapshot).toEqual({ deployments: [], error: 'unauthorized' })
    expect(JSON.stringify(snapshot)).not.toContain('private-test-token')
  })

  it('retains the last valid deployments when a later fetch fails or returns malformed JSON', async () => {
    const failures: Array<{ label: string; response?: Response; error: 'unauthorized' | 'rate-limited' | 'offline' }> = [
      { label: 'unauthorized', response: json({ error: { code: 'forbidden' } }, 401), error: 'unauthorized' },
      { label: 'rate limited', response: json({ error: { code: 'rate_limited' } }, 429), error: 'rate-limited' },
      { label: 'malformed response', response: json({ deployments: 'not-an-array' }), error: 'offline' },
      { label: 'malformed deployment entry', response: json({ deployments: [{}] }), error: 'offline' },
      { label: 'offline', error: 'offline' },
    ]
    const expected = [{ id: 'dpl_123', name: 'example-site', url: 'example-site-abc.vercel.app', state: 'READY', createdAt: 1_800_000_000_000, target: 'production' }]

    for (const failure of failures) {
      let calls = 0
      const fetchFn = (async () => {
        calls++
        if (calls === 1) return json({ deployments: [deployment] })
        if (failure.response) return failure.response
        throw new Error('network unavailable')
      }) as typeof fetch
      const provider = createVercelProvider(context(), { fetchFn })

      await provider.poll!()
      expect(await provider.poll!(), failure.label).toEqual({ deployments: expected, error: failure.error })
    }
  })

  it('clears retained deployments after a valid empty response', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      return calls === 1 ? json({ deployments: [deployment] }) : json({ deployments: [] })
    }) as typeof fetch
    const provider = createVercelProvider(context(), { fetchFn })

    expect(await provider.poll!()).toMatchObject({ deployments: [{ id: 'dpl_123' }] })
    expect(await provider.poll!()).toEqual({ deployments: [] })
  })

  it('tests credentials against Vercel and keeps the token out of connection feedback', async () => {
    const requests: { url: string; authorization: string | null }[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
      return json({ user: { username: 'livio' } })
    }) as typeof fetch
    const result = await vercelType.test({}, { token: 'private-test-token' }, { fetchFn })

    expect(result).toEqual({ ok: true, detail: expect.stringContaining('livio') })
    expect(JSON.stringify(result)).not.toContain('private-test-token')
    expect(requests).toEqual([{ url: 'https://api.vercel.com/v2/user', authorization: 'Bearer private-test-token' }])
  })
})
