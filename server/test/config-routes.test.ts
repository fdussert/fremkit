import { describe, expect, it } from 'vitest'
import { keepUnsentLabs } from '../src/config/routes.js'

// PUT /api/config with the schema's real `labs` (no flag today) is covered in backup.test.ts;
// these give it made-up flags, as the next real one will be.
describe('keepUnsentLabs', () => {
  const current = { a: true, b: false }

  it('keeps every flag a body without labs leaves out', () => {
    expect(keepUnsentLabs({ a: false, b: false }, undefined, current)).toEqual({ a: true, b: false })
    expect(keepUnsentLabs({ a: false, b: false }, null, current)).toEqual({ a: true, b: false })
  })

  it('sets a flag the body states and keeps the one it leaves out', () => {
    expect(keepUnsentLabs({ a: false, b: true }, { b: true }, current)).toEqual({ a: true, b: true })
  })

  it('takes only a boolean as stated', () => {
    expect(keepUnsentLabs({ a: false, b: false }, { a: false, b: 'yes' }, current)).toEqual({ a: false, b: false })
  })

  it('has nothing to keep with no flag', () => {
    expect(keepUnsentLabs({}, null, {})).toEqual({})
  })
})
