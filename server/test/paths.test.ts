import { describe, expect, it } from 'vite-plus/test'
import { access } from 'node:fs/promises'
import { shippedPaths } from '../src/paths.js'

describe('shippedPaths', () => {
  it('finds the checkout from the source tree when FREMKIT_ROOT is unset', async () => {
    const paths = shippedPaths({})
    // Every one of these is a real file or folder of this repository.
    for (const path of [paths.widgetsDir, paths.themesDir, paths.bridgePath, paths.wallpaperDir]) {
      await expect(access(path)).resolves.toBeUndefined()
    }
    expect(paths.bridgePath.endsWith('server/src/bridge/fremkit.js')).toBe(true)
  })

  it('treats an empty FREMKIT_ROOT as unset', () => {
    expect(shippedPaths({ FREMKIT_ROOT: '' })).toEqual(shippedPaths({}))
  })

  it('reads the app layout under FREMKIT_ROOT', () => {
    const root = '/Applications/Fremkit.app/Contents/Resources'
    expect(shippedPaths({ FREMKIT_ROOT: root })).toEqual({
      root,
      widgetsDir: `${root}/widgets`,
      themesDir: `${root}/themes`,
      uiDist: `${root}/ui/dist`,
      bridgePath: `${root}/server/bridge/fremkit.js`,
      wallpaperDir: `${root}/brand/wallpaper`,
    })
  })

  it('refuses a relative FREMKIT_ROOT', () => {
    expect(() => shippedPaths({ FREMKIT_ROOT: 'Resources' })).toThrow(/absolute/)
  })
})
