import { describe, it, expect } from 'vitest'
import { ClaudeTracker } from '../src/claude/tracker.js'
import { SOUNDS, createAttention, playSound } from '../src/claude/attention.js'
import type { InstanceView } from '../src/config/instances.js'

/**
 * Hearing that a session is waiting.
 *
 * The Edge is a strip on a desk and a question can sit on it unseen for twenty minutes. The
 * sound is played by the core rather than the widget — a sandboxed iframe cannot start audio
 * nobody clicked on, and the point is to hear it when the dashboard is *not* in front of you —
 * but which sound is a widget setting, because that is where somebody configuring their
 * dashboard will look for it.
 */

const tile = (settings: Record<string, unknown>): InstanceView => ({ widgetId: 'claude-sessions', settings })
const ev = (extra: Record<string, unknown> = {}) => ({ hook_event_name: 'PermissionRequest', session_id: 's1', cwd: '/p', ...extra })

function harness(instances: InstanceView[], start = 1_000) {
  const played: string[] = []
  let t = start
  const attention = createAttention({
    instances: () => instances,
    now: () => t,
    runner: async (_cmd, args) => { played.push(args[0]) },
  })
  return { attention, played, tick: (ms: number) => { t += ms } }
}

/** A tracker wired to the listener, with a session already alive so the first-event rule is clear. */
function session(attention: (e: { sessionId: string; isQuestion: boolean }) => void) {
  const tracker = new ClaudeTracker({ onAttention: attention })
  tracker.handle(ev({ hook_event_name: 'SessionStart' }))
  return tracker
}

describe('when a sound is played', () => {
  it('plays on the move into waiting', () => {
    const h = harness([tile({ sound: 'Glass' })])
    session(h.attention).handle(ev())
    expect(h.played).toEqual(['/System/Library/Sounds/Glass.aiff'])
  })

  it('does not play again while the session stays there', () => {
    // The transition, not the state: a session sitting in it for ten minutes has been announced.
    const h = harness([tile({ sound: 'Glass' })])
    const tracker = session(h.attention)
    tracker.handle(ev())
    h.tick(60_000)
    tracker.handle(ev())
    expect(h.played).toHaveLength(1)
  })

  it('stays quiet for a session it is hearing from for the first time', () => {
    // SessionStart is not a question, and a card that was dismissed and comes back is new again.
    const h = harness([tile({ sound: 'Glass' })])
    new ClaudeTracker({ onAttention: h.attention }).handle(ev())
    expect(h.played).toEqual([])
  })

  it('collapses a burst into one sound', () => {
    // Five subagents hitting a prompt together is one event as far as the room is concerned.
    const h = harness([tile({ sound: 'Glass' })])
    const tracker = session(h.attention)
    tracker.handle(ev())
    tracker.handle(ev({ hook_event_name: 'UserPromptSubmit' }))
    h.tick(3_000)
    tracker.handle(ev())
    expect(h.played).toHaveLength(1)
    h.tick(5_000)
    tracker.handle(ev({ hook_event_name: 'UserPromptSubmit' }))
    tracker.handle(ev())
    expect(h.played).toHaveLength(2)
  })
})

describe('playSound, the preview', () => {
  it('plays a listed sound and refuses anything else before a path exists', async () => {
    const calls: string[][] = []
    const runner = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]) }
    expect(await playSound('Glass', runner)).toBe(true)
    expect(calls).toEqual([['/usr/bin/afplay', '/System/Library/Sounds/Glass.aiff']])
    for (const bad of ['../../etc/passwd', 'Glass.aiff', 'glass', '', undefined, 42]) {
      expect(await playSound(bad, runner), String(bad)).toBe(false)
    }
    expect(calls).toHaveLength(1)
  })
})

describe('the manifest and the server agree on the sounds', () => {
  it('offers exactly the sounds the server will play, plus none', async () => {
    const { readFile } = await import('node:fs/promises')
    const manifest = JSON.parse(await readFile(new URL('../../widgets/claude-sessions/manifest.json', import.meta.url), 'utf8'))
    const options: string[] = manifest.settingsSchema.sound.options.map((o: { value: string } | string) => typeof o === 'string' ? o : o.value)
    expect(options.filter((o) => o !== 'none').sort()).toEqual([...SOUNDS].sort())
  })
})

describe('what the tiles asked for', () => {
  const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which one?' }] } }

  it('plays nothing when no tile chose a sound', () => {
    const h = harness([tile({}), tile({ sound: 'none' })])
    session(h.attention).handle(ev())
    expect(h.played).toEqual([])
  })

  it('plays nothing at all when the dashboard has no such tile', () => {
    const h = harness([])
    session(h.attention).handle(ev())
    expect(h.played).toEqual([])
  })

  it('lets the first tile with an opinion decide, so two tiles do not play twice', () => {
    const h = harness([tile({ sound: 'none' }), tile({ sound: 'Ping' }), tile({ sound: 'Hero' })])
    session(h.attention).handle(ev())
    expect(h.played).toEqual(['/System/Library/Sounds/Ping.aiff'])
  })

  it('`question` skips a permission prompt and keeps the question', () => {
    const h = harness([tile({ sound: 'Ping', soundOn: 'question' })])
    const tracker = session(h.attention)
    tracker.handle(ev())
    expect(h.played).toEqual([])
    h.tick(10_000)
    tracker.handle(ev({ hook_event_name: 'UserPromptSubmit' }))
    tracker.handle(ev(ask))
    expect(h.played).toEqual(['/System/Library/Sounds/Ping.aiff'])
  })

  it('`attention` takes both', () => {
    const h = harness([tile({ sound: 'Ping', soundOn: 'attention' })])
    session(h.attention).handle(ev())
    expect(h.played).toEqual(['/System/Library/Sounds/Ping.aiff'])
  })
})

describe('the name is a name, not a path', () => {
  it('refuses anything outside the closed list', () => {
    for (const bad of ['../../etc/passwd', 'Glass.aiff', '/System/Library/Sounds/Glass', 'glass', '']) {
      const h = harness([tile({ sound: bad })])
      session(h.attention).handle(ev())
      expect(h.played).toEqual([])
    }
  })

  it('accepts every sound macOS ships, and only those', () => {
    for (const name of SOUNDS) {
      const h = harness([tile({ sound: name })])
      session(h.attention).handle(ev())
      expect(h.played).toEqual([`/System/Library/Sounds/${name}.aiff`])
    }
  })
})
