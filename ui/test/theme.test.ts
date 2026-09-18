import { describe, it, expect } from 'vitest'
import { BUILTIN_THEME, normalizeHex, themeColor, themeVariables } from '../src/shared/theme'
import type { ThemeInfo } from '../src/shared/types'

const theme = (id: string, variables: Record<string, string>): ThemeInfo =>
  ({ id, name: id, version: '1.0.0', tokens: {}, variables })

const catalog = {
  [BUILTIN_THEME]: theme(BUILTIN_THEME, { '--bg': '#0b0d10', '--accent': '#d9b36a' }),
  edge: theme('edge', { '--bg': '#1b2026', '--accent': '#ffae42' }),
}

describe('themeVariables', () => {
  it('serves the properties of the theme that is named', () => {
    expect(themeVariables(catalog, 'edge')).toEqual(catalog.edge.variables)
  })

  it('falls back to the built-in theme when the name is missing or unknown', () => {
    expect(themeVariables(catalog, undefined)).toEqual(catalog[BUILTIN_THEME].variables)
    expect(themeVariables(catalog, 'deleted-yesterday')).toEqual(catalog[BUILTIN_THEME].variables)
  })

  it('paints nothing at all rather than throwing when the catalog could not be read', () => {
    expect(themeVariables({}, 'edge')).toEqual({})
  })
})

describe('themeColor', () => {
  /**
   * The token schema takes four hex forms and everything downstream — luminance, `rgb`, `fade` —
   * reads six digits. A theme writing `#111` was read as "not a colour" and silently replaced by
   * the built-in fallback, so the tile rules were judged against a surface nobody was painting.
   */
  it('reads every hex form the token schema accepts', () => {
    expect(normalizeHex('#111')).toBe('#111111')
    expect(normalizeHex('#1a2b3c')).toBe('#1a2b3c')
    expect(normalizeHex('#1A2B3C')).toBe('#1a2b3c')
    expect(normalizeHex('#1a2b3cff')).toBe('#1a2b3c')
    expect(normalizeHex('#1234')).toBe('#112233')
  })

  it('keeps a fully transparent colour falling through', () => {
    // A theme that drops the tile card writes #00000000; there is no luminance to read there,
    // and the caller walks on to the next token rather than judging against black.
    expect(normalizeHex('#00000000')).toBeNull()
    expect(normalizeHex('#0000')).toBeNull()
    // A partly transparent one is still a colour: the alpha is dropped, not the value.
    expect(normalizeHex('#1a2b3c80')).toBe('#1a2b3c')
  })

  it('answers null for anything that is not a hex colour', () => {
    for (const bad of ['', 'red', 'var(--accent)', '#12', '#1234567', undefined, 42]) {
      expect(normalizeHex(bad), String(bad)).toBeNull()
    }
  })

  it('gives the fallback when the theme leaves the token out', () => {
    expect(themeColor({ '--surface': '#111' }, '--surface', '#000000')).toBe('#111111')
    expect(themeColor({}, '--surface', '#000000')).toBe('#000000')
    expect(themeColor({ '--surface': '#00000000' }, '--surface', '#123456')).toBe('#123456')
  })
})
