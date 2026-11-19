import { describe, it, expect, vi } from 'vitest'
import { normalizeAccountUsage, createClaudeAccountProvider, parseKeychainJson, accountWindows, accountKey, readAccountToken, ACCOUNT_ALIVE_MS, type AccountsSnapshot, type KeychainToken } from '../src/claude/account.js'
import { defaultConfigDir, keychainServiceFor } from '../src/claude/configDirs.js'
import type { DiscoveredAccount } from '../src/claude/accounts.js'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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


describe('accountWindows', () => {
  it('takes 5 h and 7 days from their own fields, else from the session and weekly_all limits', () => {
    const r = normalizeAccountUsage(sample)
    expect(accountWindows(r)).toEqual({ fiveHour: r.fiveHour, sevenDay: r.sevenDay })
    const fromLimits = accountWindows(normalizeAccountUsage({ ...sample, five_hour: null, seven_day: null }))
    expect(fromLimits.fiveHour?.pct).toBe(12)
    expect(fromLimits.sevenDay?.pct).toBe(24)
    // `five_hour: null` and no session limit: no window running, an empty gauge rather than an error.
    expect(accountWindows(normalizeAccountUsage({ five_hour: null, seven_day: sample.seven_day })).fiveHour).toBeNull()
  })
})

describe('readAccountToken', () => {
  const item = (token: string, expiresAt?: number) => JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt === undefined ? {} : { expiresAt }) } })
  it('reads the items of the account\'s folders only, and takes the one expiring last', async () => {
    const store: Record<string, string> = {
      'Claude Code-credentials': item('default', 5_000),
      [keychainServiceFor('/u/a')]: item('a', 1_000),
      [keychainServiceFor('/u/b')]: item('other-account', 9_000),
    }
    const asked: string[] = []
    const read = async (service: string) => { asked.push(service); if (!(service in store)) throw new Error('none'); return store[service] }
    expect(await readAccountToken(['/u/a', defaultConfigDir()], read)).toEqual({ token: 'default', expiresAt: 5_000 })
    expect(asked).toEqual([keychainServiceFor('/u/a'), 'Claude Code-credentials', keychainServiceFor(defaultConfigDir())])
    expect(await readAccountToken(['/u/none'], read)).toBeNull()
  })
})

// Placeholder accounts and tokens: nothing here is anybody's.
const UUID_A = '00000000-0000-4000-8000-00000000000a'
const UUID_B = '00000000-0000-4000-8000-00000000000b'
const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-09-16T12:00:00Z')
const usageOf = (five: number, seven: number) => ({
  five_hour: { utilization: five, resets_at: '2026-09-16T17:30:00+00:00' },
  seven_day: { utilization: seven, resets_at: '2026-09-18T02:00:00+00:00' },
  limits: sample.limits,
})
const account = (uuid: string, dirs: string[], extra: Partial<DiscoveredAccount> = {}): DiscoveredAccount =>
  ({ uuid, plan: 'Max', org: null, email: 'someone@example.com', dirs, lastSeen: T0, ...extra })

interface Rig {
  t: number
  accounts: DiscoveredAccount[]
  tokens: Record<string, KeychainToken | null>
  /** By token: what the endpoint answers. */
  answers: Record<string, () => Response>
  on: boolean
  show: boolean
  names: Record<string, string>
}
function rig(over: Partial<Rig> = {}, filePath?: string) {
  const r: Rig = {
    t: T0,
    accounts: [account(UUID_A, ['/u/a']), account(UUID_B, ['/u/b'])],
    tokens: { '/u/a': { token: 'tok-a', expiresAt: T0 + DAY }, '/u/b': { token: 'tok-b', expiresAt: T0 + DAY } },
    answers: {
      'tok-a': () => new Response(JSON.stringify(usageOf(11, 21)), { status: 200 }),
      'tok-b': () => new Response(JSON.stringify(usageOf(77, 88)), { status: 200 }),
    },
    on: true, show: false, names: {},
    ...over,
  }
  const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '')
    return r.answers[token]()
  })
  const readToken = vi.fn(async (dirs: string[]) => {
    const items = dirs.map((d) => r.tokens[d] ?? null).filter(Boolean) as KeychainToken[]
    return items.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0] ?? null
  })
  const statusLine = vi.fn((_dirs: string[]) => null as null | { fiveHour: { pct: number; resetsAt: number } | null; sevenDay: null; updatedAt: number })
  const p = createClaudeAccountProvider({
    fetchFn: fetchFn as never, readToken, now: () => r.t, filePath,
    enabled: () => r.on, discover: async () => r.accounts, names: () => r.names, showEmail: () => r.show, statusLine,
  })
  const poll = async () => (await p.poll!()) as AccountsSnapshot
  return { r, p, poll, fetchFn, readToken, statusLine }
}
const byKey = (snap: AccountsSnapshot, uuid: string) => snap.accounts.find((a) => a.key === accountKey(uuid))!

describe('createClaudeAccountProvider', () => {
  it('asks the endpoint once per account, each with its own token, one account per tick', async () => {
    const { poll, fetchFn, p } = rig()
    expect(p.channel).toBe('claude-account')
    const first = await poll()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(first.accounts).toHaveLength(2)
    expect(byKey(first, UUID_A)).toMatchObject({ fiveHour: { pct: 11 }, sevenDay: { pct: 21 }, stale: false, available: true, updatedAt: T0 })
    // Not asked yet: listed, but with nothing to show.
    expect(byKey(first, UUID_B)).toMatchObject({ fiveHour: null, available: false, stale: true })
    const second = await poll()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(byKey(second, UUID_B)).toMatchObject({ fiveHour: { pct: 77 }, sevenDay: { pct: 88 }, stale: false })
    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit]
    expect(String(url)).toBe('https://api.anthropic.com/api/oauth/usage')
    // Fremkit says who it is. It used to claim to be claude-code/<version>, which was a lie
    // told to a server that never asked for one; the honest header is accepted.
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-b', 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': USER_AGENT })
    expect(USER_AGENT).toMatch(/^fremkit\//)
    // Within the five minutes, neither is asked again, whoever polls.
    await poll(); await poll()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('never puts one account\'s numbers in another\'s row, whichever order the folders come in', async () => {
    const { r, poll } = rig()
    await poll(); await poll()
    r.accounts = [...r.accounts].reverse()
    r.t += 300_000
    const snap = await poll()
    expect(snap.accounts.map((a) => a.key)).toEqual([accountKey(UUID_A), accountKey(UUID_B)])
    expect(byKey(snap, UUID_A).fiveHour?.pct).toBe(11)
    expect(byKey(snap, UUID_B).fiveHour?.pct).toBe(77)
  })

  it('reads nothing at all until the user has turned it on, and shows each folder\'s status line instead', async () => {
    const { r, poll, fetchFn, readToken, statusLine } = rig({ on: false })
    statusLine.mockImplementation((dirs) => dirs.includes('/u/b')
      ? { fiveHour: { pct: 42, resetsAt: T0 / 1000 + 3600 }, sevenDay: null, updatedAt: T0 - 60_000 }
      : null)
    const snap = await poll()
    // Neither the keychain nor the network: the opt-in comes before both.
    expect(readToken).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(snap).toMatchObject({ source: 'status-line', error: 'disabled' })
    expect(byKey(snap, UUID_B)).toMatchObject({ fiveHour: { pct: 42 }, stale: false, available: true })
    expect(byKey(snap, UUID_A)).toMatchObject({ fiveHour: null, stale: true, available: false })
    // The status line goes stale after ten minutes, as in usage.ts.
    r.t += 10 * 60_000
    expect(byKey(await poll(), UUID_B).stale).toBe(true)
    // Turned on: the next poll reads, without a restart.
    r.on = true
    expect((await poll()).source).toBe('account')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('backs off one account\'s keychain to hourly after three empty reads, and leaves the other alone', async () => {
    const { r, poll, readToken, fetchFn } = rig({ accounts: [account(UUID_A, ['/u/a'])], tokens: {} })
    for (let i = 0; i < 3; i++) {
      expect(byKey(await poll(), UUID_A)).toMatchObject({ error: 'no-token', stale: true })
      r.t += 300_000
    }
    expect(readToken).toHaveBeenCalledTimes(3)
    // Still inside the hour: answered from memory, without touching the keychain.
    r.accounts = [account(UUID_A, ['/u/a']), account(UUID_B, ['/u/b'])]
    r.tokens = { '/u/b': { token: 'tok-b', expiresAt: T0 + DAY } }
    const snap = await poll()
    expect(byKey(snap, UUID_A)).toMatchObject({ error: 'no-token' })
    expect(byKey(snap, UUID_B)).toMatchObject({ fiveHour: { pct: 77 }, stale: false })
    expect(readToken).toHaveBeenCalledTimes(4)
    expect(readToken).toHaveBeenLastCalledWith(['/u/b'])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    r.t += HOUR
    r.tokens['/u/a'] = { token: 'tok-a', expiresAt: T0 + DAY }
    // B is due too, and was due first: the polls take turns.
    expect(byKey(await poll(), UUID_A)).toMatchObject({ error: 'no-token' })
    expect(byKey(await poll(), UUID_A)).toMatchObject({ fiveHour: { pct: 11 }, stale: false })
  })

  it('honours one account\'s Retry-After, bounded to 30 s – 1 h, without slowing the other', async () => {
    const { r, poll, fetchFn } = rig()
    r.answers['tok-a'] = () => new Response('{}', { status: 429, headers: { 'retry-after': '600' } })
    expect(byKey(await poll(), UUID_A)).toMatchObject({ error: 'rate-limited', stale: true })
    r.t += 20_000
    expect(byKey(await poll(), UUID_B)).toMatchObject({ stale: false })
    r.t = T0 + 599_999
    await poll()
    expect(fetchFn.mock.calls.filter(([, i]) => JSON.stringify(i.headers).includes('tok-a'))).toHaveLength(1)
    r.t = T0 + 600_000
    r.answers['tok-a'] = () => new Response('{}', { status: 429, headers: { 'retry-after': '86400' } })
    await poll()
    expect(fetchFn.mock.calls.filter(([, i]) => JSON.stringify(i.headers).includes('tok-a'))).toHaveLength(2)
    r.t = T0 + 600_000 + HOUR - 1
    await poll()
    expect(fetchFn.mock.calls.filter(([, i]) => JSON.stringify(i.headers).includes('tok-a'))).toHaveLength(2)
    r.t = T0 + 600_000 + HOUR
    r.answers['tok-a'] = () => new Response('{}', { status: 429, headers: { 'retry-after': '5' } })
    await poll()
    r.t += 29_999
    await poll()
    expect(fetchFn.mock.calls.filter(([, i]) => JSON.stringify(i.headers).includes('tok-a'))).toHaveLength(3)
  })

  it('keeps an account\'s last good numbers, dimmed, with the reason, on 401, 429, offline', async () => {
    let status = 200
    const { r, poll } = rig({ accounts: [account(UUID_A, ['/u/a'])] })
    r.answers['tok-a'] = () => {
      if (status === 0) throw new Error('ECONNRESET')
      return new Response(status === 200 ? JSON.stringify(usageOf(11, 21)) : '{}', { status })
    }
    await poll()
    for (const [s, error] of [[401, 'unauthorized'], [429, 'rate-limited'], [0, 'offline'], [500, 'http-500']] as const) {
      status = s
      r.t += HOUR
      expect(byKey(await poll(), UUID_A)).toMatchObject({ fiveHour: { pct: 11 }, available: true, stale: true, error, updatedAt: T0 })
    }
  })

  it('never refreshes an expired token: the row keeps its numbers, and nothing is sent', async () => {
    const { r, poll, fetchFn } = rig({ accounts: [account(UUID_A, ['/u/a'])] })
    await poll()
    r.tokens['/u/a'] = { token: 'tok-a', expiresAt: T0 + HOUR }
    r.t = T0 + 2 * HOUR
    expect(byKey(await poll(), UUID_A)).toMatchObject({ error: 'expired', stale: true, fiveHour: { pct: 11 }, updatedAt: T0 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // A session starts again on the account: Claude Code refreshes the item, the poll resumes.
    r.tokens['/u/a'] = { token: 'tok-a', expiresAt: r.t + 8 * HOUR }
    r.t += 300_000
    expect(byKey(await poll(), UUID_A)).toMatchObject({ stale: false, fiveHour: { pct: 11 } })
  })

  it('draws a stale row\'s window whose reset time has passed as reset', async () => {
    const { r, poll } = rig({ accounts: [account(UUID_A, ['/u/a'])] })
    await poll()
    r.tokens['/u/a'] = null
    // Past the 5-hour reset (17:30), before the 7-day one.
    r.t = Date.parse('2026-09-16T18:00:00Z')
    const row = byKey(await poll(), UUID_A)
    expect(row).toMatchObject({ stale: true, error: 'no-token', fiveHour: null, sevenDay: { pct: 21 } })
  })

  it('lists an account while a folder of it sent an event or its usage was read within 7 days', async () => {
    const { r, poll } = rig({ accounts: [
      account(UUID_A, ['/u/a'], { lastSeen: T0 - 6 * DAY }),
      // A folder nobody has opened for weeks: its keychain item is still there.
      account(UUID_B, ['/u/b'], { lastSeen: T0 - 30 * DAY }),
    ] })
    const snap = await poll()
    expect(snap.accounts.map((a) => a.key)).toEqual([accountKey(UUID_A)])
    // No more events from A, but its usage was read: still listed six days later, gone after seven.
    r.accounts = [account(UUID_A, ['/u/a'], { lastSeen: null })]
    r.tokens['/u/a'] = null
    r.t = T0 + 6 * DAY
    expect((await poll()).accounts).toHaveLength(1)
    r.t = T0 + ACCOUNT_ALIVE_MS
    expect((await poll()).accounts).toEqual([])
    expect((await poll()).error).toBe('no-account')
  })

  it('names a row with the user\'s name, else the plan; widgets get a key, never the uuid', async () => {
    const { r, poll } = rig({ accounts: [account(UUID_A, ['/u/a']), account(UUID_B, ['/u/b'], { plan: null })] })
    r.names = { [UUID_A]: 'Work' }
    const snap = await poll()
    expect(byKey(snap, UUID_A)).toMatchObject({ name: 'Work', named: true, plan: 'Max' })
    expect(byKey(snap, UUID_B)).toMatchObject({ name: 'Claude', named: false, plan: null })
    r.names = {}
    expect(byKey(await poll(), UUID_A)).toMatchObject({ name: 'Max', named: false })
    expect(JSON.stringify(snap)).not.toContain(UUID_A)
    expect(accountKey(UUID_A)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('publishes no e-mail address unless the user lets it, error paths included', async () => {
    const { r, poll, p } = rig({ accounts: [account(UUID_A, ['/u/a'], { org: null })] })
    expect(p.publishesAccountEmail).toBe(true)
    let snap = await poll()
    expect(JSON.stringify(snap)).not.toContain('@')
    r.answers['tok-a'] = () => new Response('{}', { status: 429 })
    r.t += 300_000
    snap = await poll()
    expect(snap.accounts[0].error).toBe('rate-limited')
    expect(JSON.stringify(snap)).not.toContain('@')
    r.show = true
    expect((await poll()).accounts[0].email).toBe('someone@example.com')
    r.on = false
    r.show = false
    expect(JSON.stringify(await poll())).not.toContain('@')
  })

  it('tells the editor about a failure only when every account fails, and how many otherwise', async () => {
    const { r, poll } = rig()
    await poll(); await poll()
    expect((await poll()).error).toBeUndefined()
    r.answers['tok-a'] = () => new Response('{}', { status: 401 })
    r.t += 300_000
    expect((await poll()).error).toBe('partial-1')
    r.answers['tok-b'] = () => new Response('{}', { status: 401 })
    expect((await poll()).error).toBe('unauthorized')
    // An account with no session running is a state, not a failure.
    r.tokens['/u/a'] = { token: 'tok-a', expiresAt: T0 }
    r.tokens['/u/b'] = { token: 'tok-b', expiresAt: T0 }
    r.t += 300_000
    await poll(); await poll()
    expect((await poll()).error).toBeUndefined()
  })

  it('keeps each account\'s last good numbers and its place across a restart, in a 0600 file', async () => {
    const filePath = join(await mkdtemp(join(tmpdir(), 'fremkit-account-')), 'claude-account.json')
    const first = rig({}, filePath)
    await first.poll(); await first.poll()
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(await readFile(filePath, 'utf8'))
    expect(saved.version).toBe(2)
    expect(Object.keys(saved.accounts).sort()).toEqual([UUID_A, UUID_B])

    const second = rig({ t: T0 + HOUR, accounts: [account(UUID_B, ['/u/b']), account(UUID_A, ['/u/a'])] }, filePath)
    second.r.answers['tok-a'] = () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } })
    second.r.answers['tok-b'] = second.r.answers['tok-a']
    const snap = await second.poll()
    expect(snap.accounts.map((a) => a.key)).toEqual([accountKey(UUID_A), accountKey(UUID_B)])
    expect(byKey(snap, UUID_B)).toMatchObject({ fiveHour: { pct: 77 }, available: true, stale: true, updatedAt: T0 + 0 })
  })

  it('ignores a file from the single-account days: it cannot say whose numbers it holds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-account-'))
    const filePath = join(dir, 'claude-account.json')
    await writeFile(filePath, JSON.stringify({ last: { fiveHour: { pct: 99, resetsAt: 1 } }, updatedAt: 1 }))
    const { r, poll } = rig({ accounts: [account(UUID_A, ['/u/a'])] }, filePath)
    r.tokens = {}
    expect(byKey(await poll(), UUID_A)).toMatchObject({ fiveHour: null, available: false })
    await writeFile(join(dir, 'bad.json'), '{"accounts": 3', 'utf8')
    expect((await rig({ tokens: {} }, join(dir, 'bad.json')).poll()).accounts.every((a) => !a.available)).toBe(true)
  })

  it('lists the accounts for the settings window without reading a keychain item', async () => {
    const { p, readToken } = rig({ accounts: [account(UUID_A, ['/u/a'], { org: 'Example Corp' }), account(UUID_B, ['/u/b'], { lastSeen: T0 - 30 * DAY })] })
    expect(await p.accounts()).toEqual([{ uuid: UUID_A, plan: 'Max', org: 'Example Corp', lastSeen: T0 }])
    expect(readToken).not.toHaveBeenCalled()
  })
})
