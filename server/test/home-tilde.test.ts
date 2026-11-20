import { describe, expect, it } from 'vitest'
import { homeToTilde } from '../src/home-tilde.js'

describe('homeToTilde', () => {
  it('writes the home folder as ~ before a slash, punctuation, a quote or the end', () => {
    const h = '/Users/tester'
    expect(homeToTilde(`${h}/code`, h)).toBe('~/code')
    expect(homeToTilde(`X=${h}:/bin`, h)).toBe('X=~:/bin')
    expect(homeToTilde(`a ${h}, b "${h}" (${h})`, h)).toBe('a ~, b "~" (~)')
    expect(homeToTilde(h, `${h}/`)).toBe('~')
  })
  it('leaves a longer name alone, and does nothing without a home', () => {
    expect(homeToTilde('/Users/testerx/code', '/Users/tester')).toBe('/Users/testerx/code')
    expect(homeToTilde('/Users/tester', '')).toBe('/Users/tester')
    expect(homeToTilde('/x', '/')).toBe('/x')
    expect(homeToTilde('/x', undefined)).toBe('/x')
  })
})
