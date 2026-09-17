import { describe, expect, it } from 'vitest'
import { CONNECTION_COLORS, nextConnectionColor } from '../src/shared/types'

describe('nextConnectionColor', () => {
  it('walks the palette and wraps round', () => {
    expect(nextConnectionColor(0)).toBe(CONNECTION_COLORS[0])
    expect(nextConnectionColor(1)).toBe(CONNECTION_COLORS[1])
    expect(nextConnectionColor(CONNECTION_COLORS.length)).toBe(CONNECTION_COLORS[0])
    expect(nextConnectionColor(CONNECTION_COLORS.length + 2)).toBe(CONNECTION_COLORS[2])
  })

  it('is every colour of the palette a six-digit hex', () => {
    expect(CONNECTION_COLORS.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
  })
})
