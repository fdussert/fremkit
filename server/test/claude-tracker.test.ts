import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeTracker } from '../src/claude/tracker.js'
import { summarizeTool } from '../src/claude/tool-summary.js'

function make(start = 1_000_000) {
  let t = start
  const tracker = new ClaudeTracker(() => t)
  const tick = (ms: number) => { t += ms }
  return { tracker, tick }
}
const ev = (name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: 's1', cwd: '/Users/alice/projects/fremkit', ...extra })

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'claude-sessions-')) })

describe('summarizeTool', () => {
  it('summarises common tools and truncates to 80 chars', () => {
    expect(summarizeTool('Bash', { command: 'pnpm test', description: 'Run tests' })).toBe('Run tests')
    expect(summarizeTool('Bash', { command: 'pnpm test' })).toBe('pnpm test')
    expect(summarizeTool('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeTool('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeTool('Grep', { pattern: 'foo' })).toBe('foo')
    expect(summarizeTool('Agent', { description: 'Review code' })).toBe('Review code')
    expect(summarizeTool('Bash', { command: 'x'.repeat(200) })).toHaveLength(80)
    expect(summarizeTool('Weird', { anything: 1 })).toBeUndefined()
    expect(summarizeTool('Bash', null)).toBeUndefined()
  })
})

describe('ClaudeTracker', () => {
  it('creates an idle session on SessionStart with the project name', () => {
    const { tracker } = make()
    tracker.handle(ev('SessionStart'))
    const s = tracker.snapshot().sessions[0]
    expect(s).toMatchObject({ sessionId: 's1', project: 'fremkit', cwd: '/Users/alice/projects/fremkit', state: 'idle', subagents: 0 })
    expect(s.since).toBe(1_000_000)
  })
  it('walks the transition table', () => {
    const { tracker, tick } = make()
    tracker.handle(ev('SessionStart')); tick(10)
    tracker.handle(ev('UserPromptSubmit'))
    expect(tracker.snapshot().sessions[0].state).toBe('working')
    tracker.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }))
    expect(tracker.snapshot().sessions[0]).toMatchObject({ state: 'working', tool: 'Bash', toolDetail: 'ls' })
    tracker.handle(ev('PostToolUse', { tool_name: 'Bash' }))
    expect(tracker.snapshot().sessions[0].tool).toBeUndefined()
    tracker.handle(ev('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/x' } }))
    expect(tracker.snapshot().sessions[0]).toMatchObject({ state: 'permission', tool: 'Edit', toolDetail: '/x' })
    tracker.handle(ev('Notification', { notification_type: 'idle_prompt', message: 'idle' }))
    expect(tracker.snapshot().sessions[0].state).toBe('idle')
    tracker.handle(ev('Notification', { notification_type: 'permission_prompt', message: 'Allow?' }))
    expect(tracker.snapshot().sessions[0]).toMatchObject({ state: 'permission', lastMessage: 'Allow?' })
    tracker.handle(ev('Stop', { last_assistant_message: 'Done. '.repeat(100) }))
    const done = tracker.snapshot().sessions[0]
    expect(done.state).toBe('done'); expect(done.lastMessage).toHaveLength(200); expect(done.tool).toBeUndefined()
    tracker.handle(ev('StopFailure', { error: { type: 'rate_limit' } }))
    expect(tracker.snapshot().sessions[0]).toMatchObject({ state: 'error', error: 'rate_limit' })
    tracker.handle(ev('SessionEnd'))
    expect(tracker.snapshot().sessions).toEqual([])
  })
  it('keeps since while the state does not change, updates lastEventAt', () => {
    const { tracker, tick } = make()
    tracker.handle(ev('UserPromptSubmit')); tick(500)
    tracker.handle(ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' } }))
    const s = tracker.snapshot().sessions[0]
    expect(s.since).toBe(1_000_000); expect(s.lastEventAt).toBe(1_000_500)
  })
  it('counts subagents with a floor of zero', () => {
    const { tracker } = make()
    tracker.handle(ev('SubagentStart')); tracker.handle(ev('SubagentStart')); tracker.handle(ev('SubagentStop')); tracker.handle(ev('SubagentStop')); tracker.handle(ev('SubagentStop'))
    expect(tracker.snapshot().sessions[0].subagents).toBe(0)
  })
  it('tracks subagents by id: repeated or unknown SubagentStop events do not drift the count', () => {
    const { tracker } = make()
    tracker.handle(ev('SubagentStart', { agent_id: 'a1' })); tracker.handle(ev('SubagentStart', { agent_id: 'a2' }))
    // Claude Code stops an internal agent that never started, and stops a1 twice.
    tracker.handle(ev('SubagentStop', { agent_id: 'internal' })); tracker.handle(ev('SubagentStop', { agent_id: 'a1' })); tracker.handle(ev('SubagentStop', { agent_id: 'a1' }))
    expect(tracker.snapshot().sessions[0].subagents).toBe(1)
    expect(tracker.snapshot().sessions[0].agentIds).toEqual(['a2'])
    // A duplicate start of a running agent is not counted twice.
    tracker.handle(ev('SubagentStart', { agent_id: 'a2' }))
    expect(tracker.snapshot().sessions[0].subagents).toBe(1)
    tracker.handle(ev('SubagentStop', { agent_id: 'a2' }))
    expect(tracker.snapshot().sessions[0].subagents).toBe(0)
  })
  it('applies StatusLine fields and creates the session if unknown', () => {
    const { tracker } = make()
    tracker.handle({ hook_event_name: 'StatusLine', session_id: 's9', cwd: '/tmp/proj', model: { id: 'claude-opus-5', display_name: 'Opus' },
      cost: { total_cost_usd: 1.5 }, context_window: { context_window_size: 200000, used_percentage: 12.4, current_usage: { input_tokens: 20000, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 } }, permission_mode: 'auto' })
    const s = tracker.snapshot().sessions[0]
    expect(s).toMatchObject({ sessionId: 's9', project: 'proj', model: 'Opus', costUsd: 1.5, permissionMode: 'auto', state: 'idle' })
    expect(s.context).toEqual({ used: 24800, size: 200000, pct: 12.4 })
  })
  it('sorts permission, working, error, done, idle then most recent first', () => {
    const { tracker, tick } = make()
    const st = (id: string, name: string, extra = {}) => tracker.handle({ hook_event_name: name, session_id: id, cwd: '/p/' + id, ...extra })
    st('a', 'SessionStart'); tick(1); st('b', 'UserPromptSubmit'); tick(1); st('c', 'Stop'); tick(1); st('d', 'PermissionRequest', { tool_name: 'Bash' }); tick(1); st('e', 'UserPromptSubmit')
    expect(tracker.snapshot().sessions.map((s) => s.sessionId)).toEqual(['d', 'e', 'b', 'c', 'a'])
  })
  it('expires sessions silent for 4 hours', () => {
    const { tracker, tick } = make()
    tracker.handle(ev('SessionStart')); tick(3 * 60_000 * 60 + 59 * 60_000)
    expect(tracker.snapshot().sessions).toHaveLength(1)
    tick(2 * 60_000)
    expect(tracker.snapshot().sessions).toHaveLength(0)
  })
  it('dismiss removes finished sessions only', () => {
    const { tracker } = make()
    tracker.handle(ev('UserPromptSubmit'))
    expect(() => tracker.dismiss('s1')).toThrow(/en cours/)
    tracker.handle(ev('Stop'))
    expect(tracker.dismiss('s1')).toBe(true)
    expect(tracker.dismiss('s1')).toBe(false)
  })
  it('ignores events without session_id and unknown events only touch lastEventAt', () => {
    const { tracker, tick } = make()
    tracker.handle({ hook_event_name: 'SessionStart' })
    expect(tracker.snapshot().sessions).toEqual([])
    tracker.handle(ev('UserPromptSubmit')); tick(5)
    tracker.handle(ev('CwdChanged', { cwd: '/elsewhere' }))
    const s = tracker.snapshot().sessions[0]
    expect(s.state).toBe('working'); expect(s.lastEventAt).toBe(1_000_005)
  })
  it('an unknown event never creates a session', () => {
    const { tracker } = make()
    tracker.handle(ev('SomeFutureHook'))
    tracker.handle({ hook_event_name: 'StatusLine2', session_id: 's9', cwd: '/x' })
    expect(tracker.snapshot().sessions).toEqual([])
  })
  it('expires stale sessions on handle(), not only on snapshot()', () => {
    const { tracker, tick } = make()
    tracker.handle(ev('Stop', { last_assistant_message: 'fini' }))
    tick(4 * 60 * 60_000 + 60_000)
    // A fresh event for the same id must land on a brand new session, not resurrect
    // the expired one with its old state and message.
    tracker.handle(ev('StatusLine'))
    const sessions = tracker.snapshot().sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ state: 'idle', since: 1_000_000 + 4 * 60 * 60_000 + 60_000 })
    expect(sessions[0].lastMessage).toBeUndefined()
  })

  describe('persistence', () => {
    it('saves then loads sessions into a fresh tracker', async () => {
      let t = 1_000_000
      const file = join(dir, 'sessions.json')
      const tracker = new ClaudeTracker({ now: () => t, filePath: file })
      await tracker.load()
      tracker.handle(ev('SessionStart'))
      tracker.handle(ev('UserPromptSubmit'))
      await tracker.flush()
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ sessions: [{ sessionId: 's1', state: 'working' }] })

      const reloaded = new ClaudeTracker({ now: () => t, filePath: file })
      await reloaded.load()
      expect(reloaded.snapshot().sessions).toMatchObject([{ sessionId: 's1', project: 'fremkit', state: 'working' }])
    })

    it('drops sessions older than the ttl and tolerates a corrupt file', async () => {
      let t = 1_000_000
      const file = join(dir, 'sessions.json')
      await writeFile(file, JSON.stringify([
        { sessionId: 'fresh', project: 'p', cwd: '/p', state: 'idle', since: t, lastEventAt: t, subagents: 0 },
        { sessionId: 'stale', project: 'p', cwd: '/p', state: 'idle', since: 0, lastEventAt: 0, subagents: 0 },
        { sessionId: 'bad', notASession: true },
      ]), 'utf8')
      const tracker = new ClaudeTracker({ now: () => t, filePath: file, ttlMs: 60_000 })
      await tracker.load()
      expect(tracker.snapshot().sessions.map((s) => s.sessionId)).toEqual(['fresh'])

      const corrupt = join(dir, 'corrupt.json')
      await writeFile(corrupt, '{ not json', 'utf8')
      const tracker2 = new ClaudeTracker({ now: () => t, filePath: corrupt })
      await expect(tracker2.load()).resolves.toBeUndefined()
      expect(tracker2.snapshot().sessions).toEqual([])
    })

    it('debounces persistence: two rapid handle() calls produce a single write', async () => {
      const file = join(dir, 'sessions.json')
      const writeFn = vi.fn(async (path: string, data: string) => { await writeFile(path, data, 'utf8') })
      const tracker = new ClaudeTracker({ filePath: file, writeFn })
      await tracker.load()
      tracker.handle(ev('SessionStart'))
      tracker.handle(ev('UserPromptSubmit'))
      expect(writeFn).not.toHaveBeenCalled()
      await tracker.flush()
      expect(writeFn).toHaveBeenCalledTimes(1)
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ sessions: [{ sessionId: 's1', state: 'working' }] })
      // Nothing dirty left: flushing again writes nothing.
      await tracker.flush()
      expect(writeFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('statusline fields', () => {
    it('stores modelId, title and branch from StatusLine', () => {
      const { tracker } = make()
      tracker.handle({ hook_event_name: 'StatusLine', session_id: 's1', cwd: '/p/a', model: { id: 'claude-opus-5', display_name: 'Opus' }, session_name: 'Revue du dashboard', fremkit_branch: 'feat/x' })
      expect(tracker.snapshot().sessions[0]).toMatchObject({ model: 'Opus', modelId: 'claude-opus-5', title: 'Revue du dashboard', branch: 'feat/x' })
    })
    it('truncates the title to 80 chars and ignores empty values', () => {
      const { tracker } = make()
      tracker.handle({ hook_event_name: 'StatusLine', session_id: 's1', cwd: '/p/a', session_name: 'x'.repeat(100), fremkit_branch: '' })
      const s = tracker.snapshot().sessions[0]
      expect(s.title).toHaveLength(80); expect(s.branch).toBeUndefined()
    })
  })

  describe('today counters', () => {
    const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
    it('counts sessions, done and git commits for the local day', () => {
      const { tracker } = make()
      tracker.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'a', cwd: '/p/a' })
      tracker.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'a', cwd: '/p/a' })
      tracker.handle({ hook_event_name: 'Stop', session_id: 'a', cwd: '/p/a' })
      tracker.handle({ hook_event_name: 'Stop', session_id: 'a', cwd: '/p/a' })
      tracker.handle({ hook_event_name: 'SessionStart', session_id: 'b', cwd: '/p/b' })
      tracker.handle({ hook_event_name: 'PostToolUse', session_id: 'b', cwd: '/p/b', tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } })
      tracker.handle({ hook_event_name: 'PostToolUse', session_id: 'b', cwd: '/p/b', tool_name: 'Bash', tool_input: { command: 'git status' } })
      tracker.handle({ hook_event_name: 'PostToolUse', session_id: 'b', cwd: '/p/b', tool_name: 'Read', tool_input: { file_path: '/git commit' } })
      tracker.syncProcesses([{ pid: 9, cwd: '/p/z', startedAt: 1 }])
      expect(tracker.today()).toEqual({ sessions: 2, done: 1, commits: 1 })
      expect(tracker.snapshot().sessions.find((s) => s.sessionId === 'b')?.toolDetail).toBeUndefined()
    })
    it('resets at the local day change and survives persistence', async () => {
      const { mkdtemp } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
      const dir = await mkdtemp(join(tmpdir(), 'today-'))
      let t = day(Date.now()) + 10 * 3_600_000
      const file = join(dir, 's.json')
      const tracker = new ClaudeTracker({ now: () => t, filePath: file, persistMs: 0 })
      tracker.handle({ hook_event_name: 'Stop', session_id: 'a', cwd: '/p/a' })
      await tracker.flush()
      const again = new ClaudeTracker({ now: () => t, filePath: file })
      await again.load()
      expect(again.today()).toEqual({ sessions: 1, done: 1, commits: 0 })
      t += 24 * 3_600_000
      again.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'c', cwd: '/p/c' })
      expect(again.today()).toEqual({ sessions: 1, done: 0, commits: 0 })
    })
  })

  describe('AskUserQuestion', () => {
    it('stores the question, switches to permission and clears it afterwards', () => {
      const { tracker } = make()
      tracker.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'q', cwd: '/p/q' })
      tracker.handle({ hook_event_name: 'PreToolUse', session_id: 'q', cwd: '/p/q', tool_name: 'AskUserQuestion', tool_input: { questions: [{ header: 'Stack', question: 'Quelle stack ?', options: [{ label: 'Node', description: 'long' }, { label: 'Deno' }] }] } })
      const s = tracker.snapshot().sessions[0]
      expect(s.state).toBe('permission')
      expect(s.question).toEqual({ header: 'Stack', text: 'Quelle stack ?', options: ['Node', 'Deno'] })
      tracker.handle({ hook_event_name: 'PostToolUse', session_id: 'q', cwd: '/p/q', tool_name: 'AskUserQuestion' })
      expect(tracker.snapshot().sessions[0]).toMatchObject({ state: 'working', question: undefined })
    })
    it('truncates and caps options, ignores malformed input', () => {
      const { tracker } = make()
      tracker.handle({ hook_event_name: 'PreToolUse', session_id: 'q', cwd: '/p/q', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'x'.repeat(300), options: [1, 2, 3, 4, 5, 6].map((i) => ({ label: 'o' + i + 'y'.repeat(80) })) }] } })
      const q = tracker.snapshot().sessions[0].question!
      expect(q.text).toHaveLength(200); expect(q.options).toHaveLength(4); expect(q.options[0]).toHaveLength(60)
      tracker.handle({ hook_event_name: 'PreToolUse', session_id: 'z', cwd: '/p/z', tool_name: 'AskUserQuestion', tool_input: { questions: 'nope' } })
      expect(tracker.snapshot().sessions.find((s) => s.sessionId === 'z')?.question).toBeUndefined()
    })
  })

  describe('syncProcesses', () => {
    const procs = (list: [number, string][]) => list.map(([pid, cwd]) => ({ pid, cwd, startedAt: 900_000 }))
    it('creates idle placeholders for unclaimed processes and removes them when gone', () => {
      const { tracker } = make()
      tracker.syncProcesses(procs([[1, '/p/a'], [2, '/p/b']]))
      const s = tracker.snapshot().sessions
      expect(s.map((x) => [x.sessionId, x.state, x.project, x.discovered, x.since])).toEqual([['proc:1', 'idle', 'a', true, 900_000], ['proc:2', 'idle', 'b', true, 900_000]])
      tracker.syncProcesses(procs([[2, '/p/b']]))
      expect(tracker.snapshot().sessions.map((x) => x.sessionId)).toEqual(['proc:2'])
    })
    it('hook sessions claim the process of their cwd and replace the placeholder', () => {
      const { tracker } = make()
      tracker.syncProcesses(procs([[1, '/p/a']]))
      tracker.handle({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/p/a' })
      tracker.syncProcesses(procs([[1, '/p/a']]))
      const s = tracker.snapshot().sessions
      expect(s.map((x) => x.sessionId)).toEqual(['s1']); expect(s[0].pid).toBe(1)
    })
    it('removes a hook session whose cwd has no process left, keeps it when procs are unknown', () => {
      const { tracker } = make()
      tracker.handle({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/p/a' })
      tracker.syncProcesses(null)
      expect(tracker.snapshot().sessions).toHaveLength(1)
      tracker.syncProcesses(procs([[9, '/p/other']]))
      expect(tracker.snapshot().sessions.map((x) => x.sessionId)).toEqual(['proc:9'])
    })
    it('dismiss ignores discovered sessions', () => {
      const { tracker } = make()
      tracker.syncProcesses(procs([[1, '/p/a']]))
      expect(tracker.dismiss('proc:1')).toBe(false)
      expect(tracker.snapshot().sessions).toHaveLength(1)
    })
  })
})
