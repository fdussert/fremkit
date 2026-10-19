/**
 * Pairing codes and device tokens are compared with `crypto.timingSafeEqual`, never `===`: the
 * spec asks for it, and a refactor that swapped it out would change no other test's outcome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spy = vi.hoisted(() => ({ calls: 0 }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      spy.calls++
      return actual.timingSafeEqual(a, b)
    },
  }
})

const { PairingCodes } = await import('../src/devices/codes.js')
const { DeviceStore } = await import('../src/devices/store.js')

afterEach(() => {
  spy.calls = 0
})

describe('constant-time comparisons', () => {
  it('compares a pairing code with timingSafeEqual', () => {
    const codes = new PairingCodes()
    const { code } = codes.issue()
    spy.calls = 0
    expect(codes.consume(code)).toBe('ok')
    expect(spy.calls).toBeGreaterThan(0)
  })

  it('compares a pairing secret with timingSafeEqual', () => {
    const codes = new PairingCodes()
    const { secret } = codes.issue()
    spy.calls = 0
    expect(codes.consumeSecret(secret)).toBe('ok')
    expect(spy.calls).toBeGreaterThan(0)
  })

  it('compares a device token with timingSafeEqual, against every device', async () => {
    const store = new DeviceStore(join(await mkdtemp(join(tmpdir(), 'fremkit-timing-')), 'devices.json'))
    await store.load()
    const { token } = await store.create('A', { width: 1, height: 1 }, null)
    await store.create('B', { width: 1, height: 1 }, null)
    spy.calls = 0
    expect(store.findByToken(token, 'ipad')).not.toBeNull()
    expect(spy.calls).toBe(2)
    spy.calls = 0
    expect(store.findByToken('not-a-token', 'ipad')).toBeNull()
    expect(spy.calls).toBe(2)
  })
})
