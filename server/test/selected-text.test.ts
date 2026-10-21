import { describe, expect, it } from 'vitest'
import { createSelectedTextReader } from '../src/providers/selected-text.js'

describe('selected text reader', () => {
  it('uses a fixed native helper invocation and returns only the focused selection', async () => {
    const calls: { file: string; args: string[] }[] = []
    const reader = createSelectedTextReader(async (file, args) => {
      calls.push({ file, args })
      return JSON.stringify({ ok: true, text: 'focused selection' })
    })

    expect(await reader()).toEqual({ ok: true, text: 'focused selection' })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/usr/bin/swift')
    expect(calls[0].args).toHaveLength(2)
    expect(calls[0].args[0]).toMatch(/selected-text-native\.swift$/)
    expect(calls[0].args[1]).toBe('read')
  })

  it('preserves fail-closed native outcomes and rejects malformed output', async () => {
    const secureReader = createSelectedTextReader(async () => JSON.stringify({ ok: false, error: 'secure-field' }))
    const malformedReader = createSelectedTextReader(async () => 'not json')

    expect(await secureReader()).toEqual({ ok: false, error: 'secure-field' })
    expect(await malformedReader()).toEqual({ ok: false, error: 'unavailable' })
  })
})
