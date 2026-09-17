import { describe, expect, it } from 'vitest'
import { parseHookEvent } from '../src/claude/hook-schema.js'

describe('parseHookEvent', () => {
  it('keeps the fields the tracker and the usage read', () => {
    const event = parseHookEvent({
      hook_event_name: 'StatusLine', session_id: 'abc', cwd: '/Users/x/p',
      model: { id: 'claude-opus-5', display_name: 'Opus 5' },
      session_name: 'fremkit', fremkit_branch: 'main',
      cost: { total_cost_usd: 1.25 },
      rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } },
      context_window: { used_percentage: 17, current_usage: { input_tokens: 10 } },
    })
    expect(event).toMatchObject({
      hook_event_name: 'StatusLine', session_id: 'abc', cwd: '/Users/x/p',
      session_name: 'fremkit', fremkit_branch: 'main',
      cost: { total_cost_usd: 1.25 },
      rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } },
    })
  })

  it('drops a string past its cap rather than refusing the whole event', () => {
    const event = parseHookEvent({ hook_event_name: 'Stop', session_id: 'a', message: 'x'.repeat(100_000) })
    // The event still counts; only the oversized field is gone.
    expect(event).toMatchObject({ hook_event_name: 'Stop', session_id: 'a' })
    expect(event?.message).toBeUndefined()
  })

  it('drops a field of the wrong type rather than refusing the event', () => {
    const event = parseHookEvent({ hook_event_name: 'Stop', session_id: 'a', cwd: 42, cost: 'free' })
    expect(event).toMatchObject({ hook_event_name: 'Stop', session_id: 'a' })
    expect(event?.cwd).toBeUndefined()
    expect(event?.cost).toBeUndefined()
  })

  it('drops fields it does not know, so the tracker only ever sees what it reads', () => {
    const event = parseHookEvent({ session_id: 'a', something_new: 'x'.repeat(100_000) })
    expect(Object.hasOwn(event as object, 'something_new')).toBe(false)
  })

  it('answers null for a body that is not an object', () => {
    for (const body of [null, undefined, 'a string', 42, [], [{ session_id: 'a' }]]) {
      expect(parseHookEvent(body), JSON.stringify(body)).toBeNull()
    }
  })

  it('accepts a model given as a plain string, as some versions send it', () => {
    expect(parseHookEvent({ session_id: 'a', model: 'claude-opus-5' })?.model).toBe('claude-opus-5')
  })
})
