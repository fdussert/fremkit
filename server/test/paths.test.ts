import { describe, expect, it } from 'vitest'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { shippedPaths } from '../src/paths.js'

describe('shippedPaths', () => {
  it('finds the checkout from the source tree when FREMKIT_ROOT is unset', async () => {
    const paths = shippedPaths({})
    // Every one of these is a real file or folder of this repository.
    for (const path of [paths.widgetsDir, paths.themesDir, paths.bridgePath, paths.wallpaperDir, paths.winHostScript]) {
      await expect(access(path)).resolves.toBeUndefined()
    }
    expect(paths.bridgePath.endsWith(join('server', 'src', 'bridge', 'fremkit.js'))).toBe(true)
    expect(paths.winHostScript.endsWith(join('server', 'src', 'win', 'host.ps1'))).toBe(true)
  })

  it('treats an empty FREMKIT_ROOT as unset', () => {
    expect(shippedPaths({ FREMKIT_ROOT: '' })).toEqual(shippedPaths({}))
  })

  it('reads the app layout under FREMKIT_ROOT', () => {
    const root = '/Applications/Fremkit.app/Contents/Resources'
    expect(shippedPaths({ FREMKIT_ROOT: root })).toEqual({
      root,
      widgetsDir: join(root, 'widgets'),
      themesDir: join(root, 'themes'),
      uiDist: join(root, 'ui', 'dist'),
      bridgePath: join(root, 'server', 'bridge', 'fremkit.js'),
      wallpaperDir: join(root, 'brand', 'wallpaper'),
      winHostScript: join(root, 'server', 'win', 'host.ps1'),
    })
  })

  it('refuses a relative FREMKIT_ROOT', () => {
    expect(() => shippedPaths({ FREMKIT_ROOT: 'Resources' })).toThrow(/absolute/)
  })
})
