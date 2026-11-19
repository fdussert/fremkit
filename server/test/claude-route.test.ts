import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { claudeRoutes } from '../src/claude/routes.js'
import { createClaudeSessionsProvider, createClaudeUsageProvider } from '../src/claude/providers.js'
import { ClaudeTracker } from '../src/claude/tracker.js'
import { ClaudeUsage } from '../src/claude/usage.js'
import { buildApp } from '../src/app.js'

let dir: string
let app: FastifyInstance
let tracker: ClaudeTracker
let usage: ClaudeUsage

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-route-'))
  tracker = new ClaudeTracker()
  usage = new ClaudeUsage({ filePath: join(dir, 'usage.json'), transcriptsDir: join(dir, 'none') })
  await usage.load()
  app = Fastify()
  await app.register(claudeRoutes, { tracker, usage })
})
afterEach(() => app.close())

describe('GET /api/claude/accounts', () => {
  it('lists the accounts the limits widget shows, for the settings window to name them', async () => {
    const accounts = [{ uuid: '00000000-0000-4000-8000-00000000000a', plan: 'Max', org: 'Example Corp', lastSeen: 2000 }]
    const local = Fastify()
    await local.register(claudeRoutes, { tracker, usage, accounts: async () => accounts })
    const res = await local.inject({ method: 'GET', url: '/api/claude/accounts' })
    expect(res.json()).toEqual({ accounts })
    await local.close()
  })
  it('lists none when nothing provides them', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/claude/accounts' })).json()).toEqual({ accounts: [] })
  })
})

describe('POST /api/hooks/claude', () => {
  it('feeds the tracker and usage, answers 204', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/hooks/claude', payload: { hook_event_name: 'UserPromptSubmit', session_id: 'a', cwd: '/p/a' } })
    expect(res.statusCode).toBe(204)
    expect(tracker.snapshot().sessions[0]).toMatchObject({ sessionId: 'a', state: 'working' })
    await app.inject({ method: 'POST', url: '/api/hooks/claude', payload: { hook_event_name: 'StatusLine', session_id: 'a', rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } } })
    expect(usage.snapshot().fiveHour).toEqual({ pct: 5, resetsAt: 1 })
  })
  it('answers 204 on invalid JSON and on non-object bodies', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/hooks/claude', headers: { 'content-type': 'application/json' }, payload: '{ nope' })
    expect(bad.statusCode).toBe(204)
    const arr = await app.inject({ method: 'POST', url: '/api/hooks/claude', payload: [1, 2] })
    expect(arr.statusCode).toBe(204)
    expect(tracker.snapshot().sessions).toEqual([])
  })
  it('rejects bodies above 1 MB', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/hooks/claude', payload: { hook_event_name: 'Stop', session_id: 'x', last_assistant_message: 'a'.repeat(1_100_000) } })
    expect(res.statusCode).toBe(413)
  })
})

describe('providers', () => {
  it('reorders the pins as a tile really asks, and refuses what is not a list of ids', async () => {
    const tracker = new ClaudeTracker()
    for (const id of ['x', 'y']) tracker.handle({ hook_event_name: 'SessionStart', session_id: id, cwd: '/p/a' })
    const p = createClaudeSessionsProvider(tracker, { listProcesses: async () => null })
    await p.commands!.pin({ sessionId: 'x', pinned: true })
    await new Promise((r) => setTimeout(r, 3))
    await p.commands!.pin({ sessionId: 'y', pinned: true })
    // With the host's stamp, as every command a tile sends carries it.
    await expect(p.commands!.reorder({ order: ['y', 'x'], instanceId: 'claude-sessions-1' })).resolves.toEqual({ ok: true })
    const polled = (await p.poll!()) as { sessions: { sessionId: string; pinnedAt?: number }[] }
    const at = (id: string) => polled.sessions.find((s) => s.sessionId === id)!.pinnedAt!
    expect(at('y')).toBeLessThan(at('x'))
    for (const bad of [{}, { order: 'y,x' }, { order: [1, 2] }, { order: [''] }, { order: Array.from({ length: 25 }, (_, i) => `s${i}`) }, null]) {
      await expect(p.commands!.reorder(bad), JSON.stringify(bad)).rejects.toThrow(/session/)
    }
  })

  it('pins a session on a card\'s word, and answers a refusal instead of throwing it', async () => {
    const p = createClaudeSessionsProvider(tracker, { listProcesses: async () => null })
    tracker.handle({ hook_event_name: 'Stop', session_id: 'z', cwd: '/p/z' })
    await expect(p.commands!.pin({ sessionId: 'z', pinned: true })).resolves.toEqual({ ok: true })
    const polled = (await p.poll!()) as { sessions: { sessionId: string; pinnedAt?: number }[] }
    expect(polled.sessions[0].pinnedAt).toEqual(expect.any(Number))
    await expect(p.commands!.pin({ sessionId: 'z', pinned: false })).resolves.toEqual({ ok: true })
    await expect(p.commands!.pin({ sessionId: 'nobody', pinned: true })).resolves.toEqual({ ok: false, reason: 'unknownSession' })
    // As a tile really sends it: the host stamps every widget command with the frame's instance
    // id (`stampInstance`), which the command has no use for and must not choke on.
    await expect(p.commands!.pin({ sessionId: 'z', pinned: true, instanceId: 'claude-sessions-1' })).resolves.toEqual({ ok: true })
    // A payload without a session and a yes or no is refused, without echoing it.
    for (const bad of [{ sessionId: 'z' }, { sessionId: 'z', pinned: 'yes' }, { sessionId: '', pinned: true }, null]) {
      await expect(p.commands!.pin(bad), JSON.stringify(bad)).rejects.toThrow(/session/)
    }
  })
  it('sessions provider polls the tracker and exposes dismiss', async () => {
    // No real listProcesses here: this test must stay deterministic regardless of
    // what Claude Code processes happen to be open on the machine running it.
    const p = createClaudeSessionsProvider(tracker, { listProcesses: async () => null })
    tracker.handle({ hook_event_name: 'Stop', session_id: 'z', cwd: '/p/z' })
    expect(p.channel).toBe('claude-sessions')
    expect(((await p.poll!()) as { sessions: unknown[] }).sessions).toHaveLength(1)
    expect((await p.poll!()) as any).toHaveProperty('today.sessions')
    await expect(p.commands!.dismiss({ sessionId: 'z' })).resolves.toEqual({ dismissed: true })
    // Refused through zod now, with a translated message rather than a raw ZodError echoing the
    // payload back.
    await expect(p.commands!.dismiss({})).rejects.toThrow(/session/)
    for (const bad of [{ sessionId: '' }, { sessionId: 42 }, null, 'nope']) {
      await expect(p.commands!.dismiss(bad), JSON.stringify(bad)).rejects.toThrow()
    }
  })
  it('usage provider refreshes today then snapshots', async () => {
    const p = createClaudeUsageProvider(usage)
    expect(p.channel).toBe('claude-usage')
    expect(await p.poll!()).toMatchObject({ stale: true, today: { messages: 0 } })
  })
  it('sessions provider discovers open processes on the first poll', async () => {
    const p = createClaudeSessionsProvider(tracker, { listProcesses: async () => [{ pid: 5, cwd: '/p/x', startedAt: 1 }], discoveryMs: 0 })
    const res = (await p.poll!()) as { sessions: { sessionId: string }[] }
    expect(res.sessions.map((s) => s.sessionId)).toEqual(['proc:5'])
  })
})

describe('buildApp wiring', () => {
  it('registers the route and both channels', async () => {
    await mkdir(join(dir, 'widgets'), { recursive: true })
    const built = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), claudeTranscriptsDir: join(dir, 'none') })
    const res = await built.inject({ method: 'POST', url: '/api/hooks/claude', payload: { hook_event_name: 'SessionStart', session_id: 'w', cwd: '/p/w' } })
    expect(res.statusCode).toBe(204)
    await built.close()
  })
})
