import { describe, it, expect } from 'vitest'
import { safePath } from '../src/system-path.js'

describe('safePath', () => {
  it('puts the system folders first, whatever came before them', () => {
    expect(safePath('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'))
      .toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin')
  })
  it('drops relative and empty entries, which mean the current folder', () => {
    expect(safePath('.::bin:/opt/homebrew/bin:node_modules/.bin')).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin')
  })
  it('works from nothing', () => {
    expect(safePath(undefined)).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  })
})
