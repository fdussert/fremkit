import { describe, it, expect, vi } from 'vitest'
import { normalizeAccountUsage, createClaudeAccountProvider, parseKeychainJson } from '../src/claude/account.js'
import { USER_AGENT } from '../src/version.js'

const sample = {
  five_hour: { utilization: 12, resets_at: '2026-09-16T17:30:00.684779+00:00' },
  seven_day: { utilization: 24, resets_at: '2026-09-18T02:00:00.684799+00:00' },
  seven_day_opus: null,
  limits: [
    { kind: 'session', group: 'session', percent: 12, resets_at: '2026-09-16T17:30:00.684779+00:00', is_active: false, scope: null, severity: 'normal' },
    { kind: 'weekly_all', group: 'weekly', percent: 24, resets_at: '2026-09-18T02:00:00.684799+00:00', is_active: false, scope: null, severity: 'normal' },
    { kind: 'weekly_scoped', group: 'weekly', percent: 61, resets_at: '2026-09-18T02:00:00.684799+00:00', is_active: true, scope: { model: { display_name: 'Fable' } }, severity: 'warning' },
  ],
  seven_day_breakdown: { rows: [{ display_name: 'Claude Code', key: 'claude_code', percent: 94 }, { display_name: 'Chats', key: 'chat', percent: 6 }] },
}

describe('normalizeAccountUsage', () => {
  it('maps windows, limits and breakdown; ISO resets_at → epoch seconds', () => {
    const r = normalizeAccountUsage(sample)
    expect(r.fiveHour).toEqual({ pct: 12, resetsAt: Math.floor(Date.parse('2026-09-16T17:30:00.684779+00:00') / 1000) })
    expect(r.sevenDay?.pct).toBe(24)
    expect(r.limits.map((l) => [l.kind, l.name, l.percent, l.active])).toEqual([
      ['session', '5 h', 12, false], ['weekly_all', '7 jours', 24, false], ['weekly_scoped', 'Fable', 61, true],
    ])
    expect(r.breakdown).toEqual([{ name: 'Claude Code', percent: 94 }, { name: 'Chats', percent: 6 }])
  })
  it('tolerates missing fields', () => {
    const r = normalizeAccountUsage({})
    expect(r).toEqual({ fiveHour: null, sevenDay: null, limits: [], breakdown: [] })
  })
})

describe('parseKeychainJson', () => {
  it('extracts the access token', () => {
    expect(parseKeychainJson(JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 1 } }))).toBe('tok')
    expect(parseKeychainJson('nope')).toBeNull()
    expect(parseKeychainJson(JSON.stringify({ other: 1 }))).toBeNull()
  })
})

describe('createClaudeAccountProvider', () => {
  const ok = () => vi.fn(async () => new Response(JSON.stringify(sample), { status: 200 }))
  it('publishes available data with the expected headers', async () => {
    const fetchFn = ok()
    const p = createClaudeAccountProvider({ fetchFn: fetchFn as any, readToken: async () => 'tok', now: () => 1_000_000 })
    const r = (await p.poll!()) as any
    expect(p.channel).toBe('claude-account'); expect(p.intervalMs).toBe(300_000)
    expect(r).toMatchObject({ available: true, stale: false, updatedAt: 1_000_000, limits: expect.any(Array) })
    const [url, init] = fetchFn.mock.calls[0] as any
    expect(String(url)).toBe('https://api.anthropic.com/api/oauth/usage')
    // Fremkit says who it is. It used to claim to be claude-code/<version>, which was a lie
    // told to a server that never asked for one; the honest header is accepted.
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok', 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': USER_AGENT })
    expect(USER_AGENT).toMatch(/^fremkit\//)
    expect(JSON.stringify(init.headers)).not.toContain('claude-code')
  })

  it('reads nothing at all until the user has turned it on', async () => {
    const fetchFn = ok()
    const readToken = vi.fn(async () => 'tok')
    const p = createClaudeAccountProvider({ fetchFn: fetchFn as any, readToken, enabled: () => false })
    expect(await p.poll!()).toMatchObject({ available: false, stale: true, error: 'disabled' })
    // Neither the keychain nor the network: the opt-in comes before both.
    expect(readToken).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('starts polling as soon as the setting is turned on, without a restart', async () => {
    const fetchFn = ok()
    let on = false
    const p = createClaudeAccountProvider({ fetchFn: fetchFn as any, readToken: async () => 'tok', enabled: () => on, now: () => 1_000_000 })
    expect((await p.poll!()) as any).toMatchObject({ error: 'disabled' })
    on = true
    expect((await p.poll!()) as any).toMatchObject({ available: true, stale: false })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('reports no token without calling the network', async () => {
    const fetchFn = ok()
    const p = createClaudeAccountProvider({ fetchFn: fetchFn as any, readToken: async () => null })
    expect(await p.poll!()).toMatchObject({ available: false, stale: true, error: 'no-token' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('backs off to one keychain read per hour after three empty reads', async () => {
    let t = 1_000_000
    const readToken = vi.fn(async () => null)
    const p = createClaudeAccountProvider({ fetchFn: ok() as any, readToken, now: () => t })
    for (let i = 0; i < 3; i++) { expect(await p.poll!()).toMatchObject({ error: 'no-token' }); t += 300_000 }
    expect(readToken).toHaveBeenCalledTimes(3)
    // Still inside the hour: answered from the backoff, without touching the keychain.
    expect(await p.poll!()).toMatchObject({ available: false, stale: true, error: 'no-token' })
    expect(readToken).toHaveBeenCalledTimes(3)
    t = 1_600_000 + 60 * 60_000
    await p.poll!()
    expect(readToken).toHaveBeenCalledTimes(4)
  })
  it('resets the backoff once a token is read again', async () => {
    let t = 1_000_000
    let token: string | null = null
    const readToken = vi.fn(async () => token)
    const p = createClaudeAccountProvider({ fetchFn: ok() as any, readToken, now: () => t })
    for (let i = 0; i < 3; i++) await p.poll!()
    token = 'tok'
    t += 60 * 60_000
    expect(await p.poll!()).toMatchObject({ available: true, stale: false })
    t += 1
    expect(await p.poll!()).toMatchObject({ available: true, stale: false })
    expect(readToken).toHaveBeenCalledTimes(5)
  })
  it('keeps the last good value with stale on 401 / 429 / network error', async () => {
    let status = 200
    const fetchFn = vi.fn(async () => { if (status === 0) throw new Error('ECONNRESET'); return new Response(status === 200 ? JSON.stringify(sample) : '{}', { status }) })
    const p = createClaudeAccountProvider({ fetchFn: fetchFn as any, readToken: async () => 'tok' })
    await p.poll!()
    status = 401
    expect(await p.poll!()).toMatchObject({ available: true, stale: true, error: 'unauthorized', limits: expect.any(Array) })
    status = 429
    expect(await p.poll!()).toMatchObject({ available: true, stale: true, error: 'rate-limited' })
    status = 0
    expect(await p.poll!()).toMatchObject({ available: true, stale: true, error: 'ECONNRESET' })
  })
  it('polls again after Retry-After on 429, bounded to 30–120 s, and slows back down on success', async () => {
    let status = 200
    let retryAfter = '30'
    const fetchFn = vi.fn(async () => new Response(status === 200 ? JSON.stringify(sample) : '{}', { status, headers: status === 429 ? { 'retry-after': retryAfter } : {} }))
    const p = createClaudeAccountProvider({ fetchFn: fetchFn as any, readToken: async () => 'tok' })
    status = 429
    await p.poll!(); expect(p.intervalMs).toBe(30_000)
    retryAfter = '5'
    await p.poll!(); expect(p.intervalMs).toBe(30_000)
    retryAfter = '600'
    await p.poll!(); expect(p.intervalMs).toBe(120_000)
    retryAfter = ''
    await p.poll!(); expect(p.intervalMs).toBe(30_000)
    status = 200
    await p.poll!(); expect(p.intervalMs).toBe(300_000)
  })
  it('persists the last good snapshot and reloads it, stale, on the next start', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const filePath = join(await mkdtemp(join(tmpdir(), 'fremkit-account-')), 'claude-account.json')
    const first = createClaudeAccountProvider({ fetchFn: ok() as any, readToken: async () => 'tok', now: () => 1_000_000, filePath })
    expect(await first.poll!()).toMatchObject({ available: true, stale: false, updatedAt: 1_000_000 })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ updatedAt: 1_000_000, last: { limits: expect.any(Array) } })

    const limited = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }))
    const second = createClaudeAccountProvider({ fetchFn: limited as any, readToken: async () => 'tok', now: () => 2_000_000, filePath })
    const r = (await second.poll!()) as any
    expect(r).toMatchObject({ available: true, stale: true, error: 'rate-limited', updatedAt: 1_000_000 })
    expect(r.limits.map((l: any) => l.name)).toEqual(['5 h', '7 jours', 'Fable'])
  })
  it('starts empty when the persisted file is missing or garbage', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-account-'))
    const limited = vi.fn(async () => new Response('{}', { status: 429 }))
    expect(await createClaudeAccountProvider({ fetchFn: limited as any, readToken: async () => 'tok', filePath: join(dir, 'missing.json') }).poll!())
      .toMatchObject({ available: false, stale: true, error: 'rate-limited', limits: [] })
    await writeFile(join(dir, 'bad.json'), '{"last": 3', 'utf8')
    expect(await createClaudeAccountProvider({ fetchFn: limited as any, readToken: async () => 'tok', filePath: join(dir, 'bad.json') }).poll!())
      .toMatchObject({ available: false, stale: true, limits: [] })
  })
})
