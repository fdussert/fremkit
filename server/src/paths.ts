import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The files Fremkit ships beside its server, as opposed to the user's data. */
export interface ShippedPaths {
  root: string
  widgetsDir: string
  themesDir: string
  uiDist: string
  /** The widget SDK served as `/fremkit.js`. */
  bridgePath: string
  /** The wallpaper a fresh install starts with. */
  wallpaperDir: string
}

/**
 * Where the shipped files are, in one of two layouts.
 *
 * **A checkout** (the default): everything is found from this source file, two levels below the
 * repository root, exactly as the server has always done under tsx.
 *
 * **An installed app**: `FREMKIT_ROOT` names `Fremkit.app/Contents/Resources`, set by the helper.
 * The server there is one bundled file, and `import.meta.url` inside a bundle says where the
 * bundle is, not where this module was — so the layout is spelled out rather than guessed:
 *
 *     <root>/server/bridge/fremkit.js
 *     <root>/widgets/  <root>/themes/  <root>/ui/dist/  <root>/brand/wallpaper/
 *
 * `scripts/build-app.sh` builds that layout; the two must change together. The checkout branch
 * is evaluated only when `FREMKIT_ROOT` is unset, because a CommonJS bundle has no
 * `import.meta.url` at all.
 */
export function shippedPaths(env: NodeJS.ProcessEnv = process.env): ShippedPaths {
  const installed = env.FREMKIT_ROOT
  if (installed !== undefined && installed !== '') {
    if (!isAbsolute(installed)) throw new Error(`FREMKIT_ROOT must be an absolute path, got ${installed}`)
    return {
      root: installed,
      widgetsDir: join(installed, 'widgets'),
      themesDir: join(installed, 'themes'),
      uiDist: join(installed, 'ui', 'dist'),
      bridgePath: join(installed, 'server', 'bridge', 'fremkit.js'),
      wallpaperDir: join(installed, 'brand', 'wallpaper'),
    }
  }
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return {
    root,
    widgetsDir: join(root, 'widgets'),
    themesDir: join(root, 'themes'),
    uiDist: join(root, 'ui', 'dist'),
    bridgePath: join(root, 'server', 'src', 'bridge', 'fremkit.js'),
    wallpaperDir: join(root, 'brand', 'wallpaper'),
  }
}
