import { describe, it, expect, vi } from 'vitest'
import * as codexAdapter from '../src/codex/adapter.js'
import { createCodexProvider } from '../src/providers/codex.js'
import { CodexError } from '../src/codex/adapter.js'
const A = '01900000-0000-7000-8000-000000000001',
  B = '01900000-0000-7000-8000-000000000002',
  C = '01900000-0000-7000-8000-000000000003'
function thread(id: string, source = 'appServer') {
  return {
    id,
    name: 'Same title',
    preview: 'private message',
    source,
    createdAt: 100,
    updatedAt: 200,
    cwd: '/path/to/project',
    sessionId: id,
    cliVersion: '0.159.2',
    ephemeral: false,
    modelProvider: 'openai',
    projectId: null,
    status: { type: 'active', activeFlags: [] },
    turns: [],
  }
}
function harness(
  auth: unknown = {
    account: { type: 'chatgpt', email: 'example@example.com', planType: 'plus' },
    requiresOpenaiAuth: true,
  },
  localIds = [A, B],
) {
  const calls: { method: string; params: unknown }[] = [],
    opens: string[] = []
  const values: Record<string, unknown> = {
    'account/read': auth,
    'account/rateLimits/read': {
      rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1000 }, secondary: null },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null },
          secondary: { usedPercent: 110, windowDurationMins: 10080, resetsAt: 2000 },
        },
      },
    },
    'account/usage/read': {
      summary: { lifetimeTokens: null, peakDailyTokens: 0 },
      dailyUsageBuckets: [{ startDate: '2026-01-01', tokens: 0 }],
    },
    'thread/list': { data: [thread(A), thread(B), thread(C, 'cli')], nextCursor: 'next' },
  }
  let t = 5000,
    closed = 0
  const client = {
    supports: () => true,
    close: () => {
      closed++
    },
    request: async (method: string, params: unknown) => {
      calls.push({ method, params })
      const v = values[method]
      if (v instanceof Error) throw v
      return v
    },
  }
  const provider = createCodexProvider(
    { enabled: true, historySources: ['appServer', 'cli'] },
    {
      client,
      now: () => t,
      isLocalChat: async (id) => localIds.includes(id),
      openUrl: async (url) => {
        opens.push(url)
      },
    },
  )
  return {
    provider,
    calls,
    opens,
    values,
    tick: () => {
      t += 1000
    },
    closed: () => closed,
  }
}
describe('Codex provider snapshots', () => {
  it('is opt-in and does not construct a client while unconfigured', async () => {
    let built = 0
    const p = createCodexProvider(
      {},
      {
        clientFactory: async () => {
          built++
          throw Error('unexpected')
        },
      },
    )
    expect(await p.poll!()).toMatchObject({
      error: 'unconfigured',
      quotas: { data: null },
      history: { data: null },
    })
    expect(p.intervalMs).toBe(60_000)
    expect(built).toBe(0)
  })
  it('reads live preferences on each poll and drops prior account data when disabled', async () => {
    const h = harness()
    let accountEnabled = false
    let historySources: Array<'appServer'> = []
    const p = createCodexProvider(
      {
        enabled: () => accountEnabled || historySources.length > 0,
        accountEnabled: () => accountEnabled,
        historySources: () => historySources,
      },
      {
        client: {
          supports: () => true,
          close() {},
          request: async (method) => h.values[method],
        },
      },
    )
    expect((await p.poll!()).account.data).toBeNull()
    accountEnabled = true
    expect((await p.poll!()).account.data).toEqual({ type: 'chatgpt', planType: 'plus' })
    historySources = ['appServer']
    expect((await p.poll!()).history.data?.threads).toHaveLength(2)
    accountEnabled = false
    expect((await p.poll!()).account.data).toBeNull()
    historySources = []
    expect((await p.poll!()).history.data).toBeNull()
  })
  it('removes revoked history sources even when the next list fails', async () => {
    const h = harness()
    let sources: Array<'appServer' | 'cli'> = ['appServer', 'cli']
    const provider = createCodexProvider(
      { enabled: true, accountEnabled: false, historySources: () => sources },
      {
        client: { supports: () => true, close() {}, request: async (method) => {
          const value = h.values[method]
          if (value instanceof Error) throw value
          return value
        } },
        isLocalChat: async () => true,
      },
    )
    expect((await provider.poll!()).history.data?.threads.map((item) => item.id)).toContain(C)
    sources = ['appServer']
    h.values['thread/list'] = new CodexError('offline')
    const changed = await provider.poll!()
    expect(changed.history.freshness).toBe('stale')
    expect(changed.history.data?.threads.map((item) => item.id)).not.toContain(C)
    expect(await provider.commands!.open({ threadId: C }, { loopback: true, paired: false })).toMatchObject({ ok: false })
  })
  it('clears account sections before a new client fails after account reads are disabled', async () => {
    const h = harness()
    let accountEnabled = true
    let factoryFails = false
    const provider = createCodexProvider(
      { enabled: true, accountEnabled: () => accountEnabled, historySources: ['appServer'] },
      { clientFactory: async () => {
        if (factoryFails) throw new Error('unavailable')
        return { supports: () => true, close() {}, request: async (method) => h.values[method] }
      } },
    )
    expect((await provider.poll!()).account.data).not.toBeNull()
    accountEnabled = false
    factoryFails = true
    const changed = await provider.poll!()
    expect(changed.account.data).toBeNull()
    expect(changed.quotas.data).toBeNull()
    expect(changed.usage.data).toBeNull()
    expect(changed.authMode).toBeNull()
  })
  it('passes the configured absolute binary to its local client factory', async () => {
    const h = harness()
    const local = vi
      .spyOn(codexAdapter, 'createLocalCodexClient')
      .mockResolvedValue({ supports: () => true, close() {}, request: async (method) => h.values[method] })
    try {
      const p = createCodexProvider({ enabled: true, binary: '/path/to/codex' })
      expect((await p.poll!()).usage.data?.summary.peakDailyTokens).toBe(0)
      expect(local).toHaveBeenCalledWith({ binary: '/path/to/codex' })
    } finally {
      local.mockRestore()
    }
  })
  it('retains an injected client factory override with configured binary', async () => {
    const h = harness()
    let builds = 0
    const p = createCodexProvider(
      { enabled: true, binary: '/path/to/codex' },
      {
        clientFactory: async () => {
          builds++
          return { supports: () => true, close() {}, request: async (method) => h.values[method] }
        },
      },
    )
    expect((await p.poll!()).usage.data?.summary.peakDailyTokens).toBe(0)
    expect(builds).toBe(1)
  })
  it('closes each owned app-server client after a poll', async () => {
    const h = harness()
    let built = 0
    let closed = 0
    const p = createCodexProvider(
      { enabled: true, accountEnabled: true },
      {
        clientFactory: async () => {
          built++
          return {
            supports: () => true,
            request: async (method) => h.values[method],
            close: () => {
              closed++
            },
          }
        },
      },
    )
    await p.poll!()
    await p.poll!()
    expect({ built, closed }).toEqual({ built: 2, closed: 2 })
  })
  it('backs off for durable errors instead of retrying every 15 seconds', async () => {
    const h = harness()
    h.values['account/read'] = new CodexError('unsupported')
    const p = createCodexProvider(
      { enabled: true, accountEnabled: true },
      {
        client: {
          supports: () => true,
          request: async (method) => {
            const value = h.values[method]
            if (value instanceof Error) throw value
            return value
          },
          close() {},
        },
      },
    )
    expect((await p.poll!()).error).toBe('unsupported')
    expect(p.intervalMs).toBe(300_000)
  })
  it('preserves null and zero metrics, prefers multiple buckets and exposes only the account display fields', async () => {
    const h = harness(),
      s = await h.provider.poll!()
    expect(s.quotas.data?.buckets).toEqual([
      {
        id: 'codex',
        name: null,
        primary: { usedPercent: 0, remainingPercent: 100, windowDurationMins: null, resetsAt: null },
        secondary: { usedPercent: 110, remainingPercent: 0, windowDurationMins: 10080, resetsAt: 2000 },
      },
    ])
    expect(s.usage.data).toMatchObject({
      summary: { lifetimeTokens: null, peakDailyTokens: 0, currentStreakDays: null },
      dailyUsageBuckets: [{ startDate: '2026-01-01', tokens: 0 }],
    })
    expect(s.account).toMatchObject({
      data: { type: 'chatgpt', planType: 'plus' },
      freshness: 'fresh',
      error: null,
    })
    expect(h.calls).toContainEqual({ method: 'account/read', params: { refreshToken: false } })
    expect(h.calls).toContainEqual({
      method: 'account/rateLimits/read',
      params: { supportsLunaReserve: false, excludeResetCreditDetails: true },
    })
  })
  it('uses explicit DB-only history and retains IDs without claiming live activity', async () => {
    const h = harness(),
      s = await h.provider.poll!()
    expect(h.calls).toContainEqual({
      method: 'thread/list',
      params: {
        sourceKinds: ['appServer', 'cli'],
        useStateDbOnly: true,
        limit: 50,
        sortKey: 'updated_at',
        archived: false,
      },
    })
    expect(s.history.data).toMatchObject({
      nextCursor: 'next',
      truncated: true,
      threads: [
        { id: A, title: 'Same title', sourceKind: 'appServer', navigation: 'localChat', liveActivity: null },
        { id: B, navigation: 'localChat' },
        { id: C, sourceKind: 'cli', navigation: 'unavailable' },
      ],
    })
    expect(JSON.stringify(s)).not.toContain('private message')
    expect(JSON.stringify(s)).not.toContain('/path/to/project')
  })
  it('does not list history unless sources are selected', async () => {
    const h = harness()
    const p = createCodexProvider(
      { enabled: true },
      {
        client: {
          supports: () => true,
          close() {},
          request: async (m: string) => {
            h.calls.push({ method: m, params: {} })
            return h.values[m]
          },
        },
      },
    )
    expect((await p.poll!()).history.error).toBe('unconfigured')
    expect(h.calls.some((c) => c.method === 'thread/list')).toBe(false)
  })
  it('retains last good data with original timestamps and stale state after interruption', async () => {
    const h = harness(),
      first = await h.provider.poll!()
    h.tick()
    h.values['account/usage/read'] = new CodexError('offline')
    const s = await h.provider.poll!()
    expect(s.usage).toEqual({ ...first.usage, freshness: 'stale', error: 'offline' })
    expect(s.quotas.updatedAt).toBe(6000)
    expect(h.provider.intervalMs).toBe(15000)
  })
  it('reports missing auth while still reading selected local history', async () => {
    const h = harness({ account: null, requiresOpenaiAuth: true }),
      s = await h.provider.poll!()
    expect(s.quotas).toMatchObject({ data: null, freshness: 'unavailable', error: 'unauthorized' })
    expect(s.history.data?.threads).toHaveLength(3)
    expect(h.calls.some((c) => c.method === 'account/usage/read')).toBe(false)
  })
  it('clears prior account data when authentication disappears', async () => {
    const h = harness()
    await h.provider.poll!()
    h.values['account/read'] = { account: null, requiresOpenaiAuth: true }
    const s = await h.provider.poll!()
    expect(s.quotas.data).toBeNull()
    expect(s.usage.data).toBeNull()
  })
  it('reports unsupported auth modes rather than zero usage', async () => {
    const h = harness({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
      s = await h.provider.poll!()
    expect(s.authMode).toBe('apiKey')
    expect(s.usage.error).toBe('unsupported')
    expect(s.usage.data).toBeNull()
  })
  it('preserves independent successes when usage is unsupported or malformed', async () => {
    const h = harness()
    h.values['account/usage/read'] = new CodexError('unsupported')
    expect((await h.provider.poll!()).usage.error).toBe('unsupported')
    h.values['account/usage/read'] = { summary: { lifetimeTokens: -3 } }
    expect((await h.provider.poll!()).usage.error).toBe('invalid')
  })
  it('rejects invalid source selection without constructing a client', async () => {
    const p = createCodexProvider(
      { enabled: true, historySources: ['invalid'] as never },
      {
        clientFactory: async () => {
          throw Error('unexpected')
        },
      },
    )
    expect((await p.poll!()).error).toBe('invalid')
  })
  it('opens same-title validated local chats by ID without protocol calls', async () => {
    const h = harness()
    await h.provider.poll!()
    const count = h.calls.length
    expect(await h.provider.commands!.open({ threadId: A }, { loopback: true, paired: false })).toEqual({ ok: true })
    expect(await h.provider.commands!.open({ threadId: B }, { loopback: true, paired: false })).toEqual({ ok: true })
    expect(h.opens).toEqual([`codex://threads/${A}`, `codex://threads/${B}`])
    expect(h.calls).toHaveLength(count)
  })
  it('refuses remote, unknown, stale, title-only and unvalidated CLI navigation', async () => {
    const h = harness()
    await h.provider.poll!()
    for (const [payload, ctx] of [
      [{ threadId: A }, undefined],
      [{ threadId: A }, { loopback: false, paired: false }],
      [{ title: 'Same title' }, { loopback: true, paired: false }],
      [{ threadId: 'new' }, { loopback: true, paired: false }],
      [{ threadId: C }, { loopback: true, paired: false }],
      [{ threadId: A, prompt: 'start' }, { loopback: true, paired: false }],
    ])
      expect(await h.provider.commands!.open(payload, ctx as never)).toMatchObject({ ok: false })
    h.values['thread/list'] = new CodexError('offline')
    await h.provider.poll!()
    expect(await h.provider.commands!.open({ threadId: A }, { loopback: true, paired: false })).toMatchObject({ ok: false })
    expect(h.opens).toEqual([])
  })
  it('allows a CLI-origin record only when the desktop catalog proves the exact existing chat', async () => {
    const h = harness(undefined, [A, B, C])
    const snapshot = await h.provider.poll!()
    expect(snapshot.history.data?.threads.find((t) => t.id === C)).toMatchObject({
      sourceKind: 'cli',
      navigation: 'localChat',
      liveActivity: null,
    })
    expect(
      await h.provider.commands!.open({ threadId: C, instanceId: 'codex-widget-1' }, { loopback: true, paired: false }),
    ).toEqual({ ok: true })
    expect(h.opens).toEqual([`codex://threads/${C}`])
  })
  it('rejects foreign and absent UUIDs and ignores no extra command capabilities', async () => {
    const h = harness()
    h.values['thread/list'] = { data: [thread('01900000-0000-7000-8000-000000000004')], nextCursor: null }
    await h.provider.poll!()
    for (const payload of [
      { threadId: A },
      { threadId: '01900000-0000-7000-8000-000000000004' },
      { threadId: A, instanceId: '' },
      { threadId: A, instanceId: 'x'.repeat(201) },
    ]) {
      expect(await h.provider.commands!.open(payload, { loopback: true, paired: false })).toMatchObject({ ok: false })
    }
    expect(h.opens).toEqual([])
  })
  it('closes only its client and serializes overlapping polls', async () => {
    const h = harness()
    const [a, b] = await Promise.all([h.provider.poll!(), h.provider.poll!()])
    expect(a).toEqual(b)
    expect(h.calls.filter((c) => c.method === 'account/read')).toHaveLength(1)
    h.provider.stop!()
    expect(h.closed()).toBe(1)
  })
  it('clears both account sections when a metric read rejects authentication', async () => {
    const h = harness()
    await h.provider.poll!()
    h.values['account/usage/read'] = new CodexError('unauthorized')
    const s = await h.provider.poll!()
    expect(s.usage.data).toBeNull()
    expect(s.quotas.data).toBeNull()
    expect(s.authMode).toBeNull()
  })
  it('does not retain the previous account data after account identity changes', async () => {
    const h = harness()
    await h.provider.poll!()
    h.values['account/read'] = {
      account: { type: 'chatgpt', email: 'other@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    }
    h.values['account/usage/read'] = new CodexError('offline')
    expect((await h.provider.poll!()).usage.data).toBeNull()
  })
  it('does not restart reads after stop interrupts a pending authentication read', async () => {
    let resolve!: (v: unknown) => void
    const calls: string[] = []
    const p = createCodexProvider(
      { enabled: true, historySources: ['appServer'] },
      {
        client: {
          supports: () => true,
          close() {},
          request: async (method) => {
            calls.push(method)
            return new Promise((r) => {
              resolve = r
            })
          },
        },
      },
    )
    const pending = p.poll!()
    await Promise.resolve()
    p.stop!()
    resolve({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true })
    await pending
    expect(calls).toEqual(['account/read'])
  })
  it('disables navigation without an independent trusted local-chat validator', async () => {
    const h = harness()
    const p = createCodexProvider(
      { enabled: true, historySources: ['appServer'] },
      {
        client: { supports: () => true, close() {}, request: async (method) => h.values[method] },
        openUrl: async () => {
          throw Error('must not open')
        },
      },
    )
    expect((await p.poll!()).history.data?.threads.every((t) => t.navigation === 'unavailable')).toBe(true)
    expect(await p.commands!.open({ threadId: A }, { loopback: true, paired: false })).toEqual({
      ok: false,
      error: 'unavailable',
    })
  })
  it('normalizes subagent source objects and filters precisely selected kinds', async () => {
    const h = harness()
    h.values['thread/list'] = {
      data: [
        { ...thread(A), source: { subAgent: 'review' } },
        { ...thread(B), source: { custom: 'external' } },
      ],
      nextCursor: null,
    }
    const p = createCodexProvider(
      { enabled: true, historySources: ['subAgentReview', 'unknown'] },
      { client: { supports: () => true, close() {}, request: async (method) => h.values[method] } },
    )
    expect((await p.poll!()).history.data?.threads.map((t) => t.sourceKind)).toEqual([
      'subAgentReview',
      'unknown',
    ])
  })
  it('cancels navigation when stop occurs during trusted revalidation', async () => {
    const h = harness()
    let resolve!: (value: boolean) => void
    let defer = false
    const p = createCodexProvider(
      { enabled: true, historySources: ['appServer'] },
      {
        client: { supports: () => true, close() {}, request: async (method) => h.values[method] },
        isLocalChat: async () =>
          defer
            ? new Promise((r) => {
                resolve = r
              })
            : true,
        openUrl: async (url) => {
          h.opens.push(url)
        },
      },
    )
    await p.poll!()
    defer = true
    const opening = p.commands!.open({ threadId: A }, { loopback: true, paired: false })
    await Promise.resolve()
    p.stop!()
    resolve(true)
    expect(await opening).toEqual({ ok: false, error: 'unavailable' })
    expect(h.opens).toEqual([])
  })
  it('refuses navigation when successful history has aged past its freshness bound', async () => {
    const h = harness()
    await h.provider.poll!()
    for (let i = 0; i < 121; i++) h.tick()
    expect(await h.provider.commands!.open({ threadId: A }, { loopback: true, paired: false })).toEqual({
      ok: false,
      error: 'unavailable',
    })
    expect(h.opens).toEqual([])
  })
  it('clears stale metrics when the workspace account changes with the same email and plan', async () => {
    const account = { type: 'chatgpt', email: 'example@example.com', planType: 'plus' }
    const routing = {
      chatgptAccountId: 'workspace-a',
      backendOrigin: 'https://example.com',
      accountRoutingOverride: 'NO_CONSTRAINT',
    }
    const h = harness({ account, requiresOpenaiAuth: true, workspaceRouting: routing })
    h.values['account/rateLimits/read'] = {
      rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1000 } },
    }
    h.values['account/usage/read'] = { summary: { lifetimeTokens: 123 }, dailyUsageBuckets: null }
    const first = await h.provider.poll!()
    expect(first.quotas.data?.buckets[0].primary?.usedPercent).toBe(37)
    expect(first.usage.data?.summary.lifetimeTokens).toBe(123)
    expect(JSON.stringify(first)).not.toContain('workspace-a')
    h.values['account/read'] = {
      account,
      requiresOpenaiAuth: true,
      workspaceRouting: { ...routing, chatgptAccountId: 'workspace-b' },
    }
    h.values['account/rateLimits/read'] = new CodexError('offline')
    h.values['account/usage/read'] = new CodexError('offline')
    const next = await h.provider.poll!()
    expect(next.quotas).toEqual({ data: null, updatedAt: null, freshness: 'unavailable', error: 'offline' })
    expect(next.usage).toEqual({ data: null, updatedAt: null, freshness: 'unavailable', error: 'offline' })
    expect(JSON.stringify(next)).not.toContain('workspace-b')
    expect(JSON.stringify(next)).not.toContain('chatgptAccountId')
  })
})

describe('Codex connected account display', () => {
  it('does not expose credentials or workspace identifiers with account display fields', async () => {
    const h = harness({
      requiresOpenaiAuth: true,
      account: {
        type: 'chatgpt',
        email: 'example@example.com',
        planType: 'pro',
        accessToken: 'PRIVATE_TOKEN',
      },
      workspaceRouting: { chatgptAccountId: 'PRIVATE_WORKSPACE' },
    })
    const s = await h.provider.poll!()
    expect(s.account.data).toEqual({ type: 'chatgpt', planType: 'pro' })
    expect(JSON.stringify(s)).not.toMatch(
      /PRIVATE_TOKEN|PRIVATE_WORKSPACE|accessToken|chatgptAccountId|example@example.com/,
    )
  })
  it('keeps last known account explicitly stale on a failed account read', async () => {
    const h = harness(),
      first = await h.provider.poll!()
    h.tick()
    h.values['account/read'] = new CodexError('offline')
    expect((await h.provider.poll!()).account).toEqual({
      ...first.account,
      freshness: 'stale',
      error: 'offline',
    })
  })
  it.each(['account/read', 'account/usage/read'])(
    'clears the account after unauthorized %s',
    async (method) => {
      const h = harness()
      await h.provider.poll!()
      h.values[method] = new CodexError('unauthorized')
      expect((await h.provider.poll!()).account).toMatchObject({
        data: null,
        freshness: 'unavailable',
        error: 'unauthorized',
      })
    },
  )
  it('replaces the identity and clears old metrics when switching accounts', async () => {
    const h = harness()
    await h.provider.poll!()
    h.values['account/read'] = {
      requiresOpenaiAuth: true,
      account: { type: 'chatgpt', email: 'other@example.com', planType: 'pro' },
    }
    h.values['account/usage/read'] = new CodexError('offline')
    const s = await h.provider.poll!()
    expect(s.account.data).toEqual({ type: 'chatgpt', planType: 'pro' })
    expect(s.usage.data).toBeNull()
  })
  it('does not claim email identity for API key authentication', async () => {
    const h = harness({
      requiresOpenaiAuth: true,
      account: { type: 'apiKey', email: 'ignore@example.com', planType: 'ignore' },
    })
    expect((await h.provider.poll!()).account).toMatchObject({
      data: { type: 'apiKey', planType: null },
      freshness: 'fresh',
    })
  })
  it('clears malformed account data rather than retaining a connected identity', async () => {
    const h = harness()
    await h.provider.poll!()
    h.values['account/read'] = {
      requiresOpenaiAuth: true,
      account: { type: 'chatgpt', email: 'x'.repeat(321) },
    }
    expect((await h.provider.poll!()).account).toMatchObject({ data: null, error: 'invalid' })
  })
})
