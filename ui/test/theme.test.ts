import { describe, it, expect } from 'vitest'
import { BUILTIN_THEME, themeVariables } from '../src/shared/theme'
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
