import { describe, it, expect } from 'vitest'
import { safePath } from '../src/system-path.js'

describe('safePath', () => {
  it('puts the system folders first, whatever came before them', () => {
    expect(safePath('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'darwin'))
      .toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin')
  })
  it('drops relative and empty entries, which mean the current folder', () => {
    expect(safePath('.::bin:/opt/homebrew/bin:node_modules/.bin', 'darwin')).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin')
  })
  it('works from nothing', () => {
    expect(safePath(undefined, 'darwin')).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  })
})

describe('safePath (platform argument)', () => {
  it('is the platform module\'s function, unchanged on the Mac', () => {
    expect(safePath('/opt/homebrew/bin:/usr/bin', 'darwin')).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin')
  })
})
