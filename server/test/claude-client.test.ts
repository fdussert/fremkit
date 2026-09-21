import { describe, it, expect } from 'vitest'
import { ClaudeTracker, clientView } from '../src/claude/tracker.js'
import { parseHookEvent } from '../src/claude/hook-schema.js'

/**
 * Knowing where a session lives, and getting back to it.
 *
 * The server has always seen a session id and a working directory, which is not enough to find
 * anything: two sessions in two panes of the same folder are the same pair of strings. The hook
 * runs inside the session and knows the rest, so it now says so — and that answer is a pane key,
 * a tty and an application id, which is of no use on a dashboard and of some use to anything
 * that can read one. Hence the split this file is mostly about: the raw client stays server-side
 * and the snapshot carries a kind and a label. Getting back to the window is `claude-focus`.
 */

const ev = (extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'SessionStart', session_id: 's1', cwd: '/Users/alice/projects/fremkit', ...extra,
})
const ORCA = { bundleId: 'com.stablyai.orca', program: 'Orca', pid: 4242, tty: 'ttys028', orca: { pane: 'p:q', tab: 't', terminal: 'term_abc123' } }

describe('what the hook may say about a client', () => {
  it('accepts the whole object', () => {
    const parsed = parseHookEvent(ev({ client: ORCA }))
    expect(parsed?.client).toEqual(ORCA)
  })

  it('drops a field past its cap and keeps the rest', () => {
    // Same discipline as every other field: these are environment variables, and an environment
    // variable is whatever somebody exported.
    const parsed = parseHookEvent(ev({ client: { bundleId: 'x'.repeat(500), program: 'Orca' } }))
    expect(parsed?.client?.bundleId).toBeUndefined()
    expect(parsed?.client?.program).toBe('Orca')
  })

  it('drops a pid that is not one', () => {
    expect(parseHookEvent(ev({ client: { pid: -3, program: 'Orca' } }))?.client?.pid).toBeUndefined()
    expect(parseHookEvent(ev({ client: { pid: 'abc', program: 'Orca' } }))?.client?.pid).toBeUndefined()
  })

  it('drops a client that is not an object rather than the event', () => {
    const parsed = parseHookEvent(ev({ client: 'Orca' }))
    expect(parsed?.client).toBeUndefined()
    expect(parsed?.session_id).toBe('s1')
  })
})

describe('what the tracker keeps', () => {
  it('takes the first event’s client and lets a later one fill the gaps', () => {
    const tracker = new ClaudeTracker()
    tracker.handle(ev({ client: { bundleId: 'com.apple.Terminal', program: 'Apple_Terminal' } }))
    tracker.handle(ev({ hook_event_name: 'StatusLine', client: { bundleId: 'com.stablyai.orca', tty: 'ttys003' } }))
    // A session does not move between panes: the bundle id it started with is the one it has.
    expect(tracker.clientOf('s1')).toEqual({
      bundleId: 'com.apple.Terminal', program: 'Apple_Terminal', pid: undefined, tty: 'ttys003', terminalSession: undefined,
    })
  })

  it('does not take another session’s process just because it shares the checkout', () => {
    // Two claudes in one folder: the person's, and the agent they launched. The scan found both.
    const tracker = new ClaudeTracker()
    tracker.syncProcesses([
      { pid: 1000, cwd: '/Users/alice/projects/fremkit', startedAt: 1 },
      { pid: 2000, cwd: '/Users/alice/projects/fremkit', startedAt: 2 },
    ])
    tracker.handle(ev({ client: { ...ORCA, pid: 2000 } }))
    expect(tracker.pidOf('s1')).toBe(2000)
    // The placeholder for 1000 is still there; only 2000 became s1.
    const ids = tracker.snapshot().sessions.map((x) => x.sessionId).sort()
    expect(ids).toEqual(['proc:1000', 's1'])
  })

  it('never publishes the raw client', () => {
    const tracker = new ClaudeTracker()
    tracker.handle(ev({ client: ORCA }))
    const [session] = tracker.snapshot().sessions
    expect(session.client).toEqual({ kind: 'orca', label: 'Orca' })
    // The pane key and the tty are what `focus` needs and what a card has no business holding.
    expect(JSON.stringify(session)).not.toContain('term_abc123')
    expect(JSON.stringify(session)).not.toContain('ttys028')
  })

  it('carries the client across a restart', async () => {
    const path = `${await import('node:os').then((m) => m.tmpdir())}/claude-client-${process.pid}.json`
    const a = new ClaudeTracker({ filePath: path, persistMs: 0 })
    a.handle(ev({ client: ORCA }))
    await a.flush()
    const b = new ClaudeTracker({ filePath: path })
    await b.load()
    expect(b.clientOf('s1')?.orca?.terminal).toBe('term_abc123')
  })
})

describe('the kind and the label a card sees', () => {
  it('names the clients it knows, from either the bundle id or TERM_PROGRAM', () => {
    expect(clientView({ bundleId: 'com.stablyai.orca' })).toEqual({ kind: 'orca', label: 'Orca' })
    expect(clientView({ program: 'Apple_Terminal' })).toEqual({ kind: 'terminal', label: 'Terminal' })
    expect(clientView({ program: 'iTerm.app' })).toEqual({ kind: 'iterm', label: 'iTerm2' })
    expect(clientView({ program: 'vscode' })).toEqual({ kind: 'vscode', label: 'VS Code' })
  })

  it('falls back to what an unknown one calls itself, cut short', () => {
    expect(clientView({ program: 'ghostty' })).toEqual({ kind: 'other', label: 'ghostty' })
    expect(clientView({ bundleId: 'com.example.Something' })).toEqual({ kind: 'other', label: 'Something' })
    expect(clientView({ program: 'x'.repeat(200) })?.label).toHaveLength(24)
  })

  it('says nothing about a session whose hook never told it anything', () => {
    expect(clientView(undefined)).toBeUndefined()
    expect(clientView({})).toBeUndefined()
  })
})
