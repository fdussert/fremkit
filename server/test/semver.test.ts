import { describe, expect, it } from 'vitest'
import { compareSemver, greatest, isNewer, parseSemver } from '../src/marketplace/semver.js'

describe('parseSemver', () => {
  it('reads the three numbers and the pre-release, and ignores the build', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] })
    expect(parseSemver('0.1.0-rc.2')).toEqual({ major: 0, minor: 1, patch: 0, pre: ['rc', '2'] })
    expect(parseSemver('1.0.0+20260918')).toEqual({ major: 1, minor: 0, patch: 0, pre: [] })
  })
  it('refuses what a registry cannot order', () => {
    for (const v of ['1.2', 'v1.2.3', '1.2.3.4', 'latest', '01.2.3', '', '1.2.3-']) {
      expect(parseSemver(v), v).toBeNull()
    }
  })
})

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1)
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })
  it('sorts a pre-release below the release it leads to', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1)
  })
  it('compares pre-release identifiers the way semver.org says', () => {
    // Numeric identifiers numerically, and below alphanumeric ones; a shorter run is lower.
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1)
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareSemver('1.0.0-beta', '1.0.0-alpha')).toBe(1)
  })
  it('treats build metadata as invisible, because two builds are one release', () => {
    expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0)
  })
  it('sorts anything unparseable below everything parseable', () => {
    expect(compareSemver('latest', '0.0.1')).toBe(-1)
    expect(compareSemver('0.0.1', 'latest')).toBe(1)
  })
})

describe('isNewer and greatest', () => {
  it('answers the only two questions the registry asks', () => {
    expect(isNewer('1.1.0', '1.0.9')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(greatest(['1.0.0', '2.1.0', '2.0.9'])).toBe('2.1.0')
    expect(greatest([])).toBeNull()
  })
})
