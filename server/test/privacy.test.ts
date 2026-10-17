import { describe, it, expect } from 'vite-plus/test'
import { gateAccountEmail, withAccountEmail } from '../src/privacy.js'
import { ConfigSchema, DEFAULT_CONFIG } from '../src/config/schema.js'

describe('withAccountEmail', () => {
  const snapshot = (show: boolean) => ({ plan: 'max', authMode: 'oauth', ...withAccountEmail('someone@example.com', show) })

  it('leaves the address out of the snapshot when the setting is off', () => {
    const s = snapshot(false)
    expect(s).not.toHaveProperty('email')
    // Not an empty or masked value either: the key is absent, so nothing reaches a widget.
    expect(JSON.stringify(s)).not.toContain('example.com')
  })

  it('keeps the plan and the sign-in method whatever the setting', () => {
    expect(snapshot(false)).toEqual({ plan: 'max', authMode: 'oauth' })
    expect(snapshot(true)).toEqual({ plan: 'max', authMode: 'oauth', email: 'someone@example.com' })
  })

  it('publishes nothing when there is no address to publish', () => {
    expect(withAccountEmail(null, true)).toEqual({})
    expect(withAccountEmail(undefined, true)).toEqual({})
    expect(withAccountEmail('', true)).toEqual({})
  })

  it('is off on a fresh install', () => {
    expect(DEFAULT_CONFIG.privacy.showAccountEmail).toBe(false)
    expect(ConfigSchema.shape.privacy.parse(undefined).showAccountEmail).toBe(false)
  })
})

describe('gateAccountEmail', () => {
  const last = { plan: 'max', authMode: 'oauth', email: 'someone@example.com' }

  it('drops an address already in a cached snapshot once the setting is off', () => {
    // The error path: the last good snapshot, fetched while the box was ticked, republished.
    const s = gateAccountEmail({ ...last, error: 'offline' }, false)
    expect(s).toEqual({ plan: 'max', authMode: 'oauth', error: 'offline' })
    expect(s).not.toHaveProperty('email')
  })

  it('gates a nested account on the object that carries the address', () => {
    // The shape of a snapshot that holds the account under a key, republished on failure.
    const stale = { account: { status: 'ok', data: { plan: 'pro', email: 'someone@example.com' } }, history: [] }
    const gated = (show: boolean) => ({
      ...stale,
      error: 'offline',
      account: { ...stale.account, data: gateAccountEmail(stale.account.data, show) },
    })
    expect(gated(false)).toEqual({ account: { status: 'ok', data: { plan: 'pro' } }, history: [], error: 'offline' })
    expect(JSON.stringify(gated(false))).not.toContain('example.com')
    expect(gated(true).account.data.email).toBe('someone@example.com')
    // Applied to the outer snapshot instead it changes nothing, which is why the docs say where.
    expect(JSON.stringify(gateAccountEmail(stale, false))).toContain('example.com')
  })

  it('keeps it while the setting is on, and leaves a snapshot without one alone', () => {
    expect(gateAccountEmail(last, true)).toBe(last)
    const plain = { plan: 'pro' }
    expect(gateAccountEmail(plain, false)).toBe(plain)
  })
})
