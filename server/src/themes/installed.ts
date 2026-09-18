import { join } from 'node:path'

/**
 * Where the themes the user installed from the marketplace live.
 *
 * Beside `<dataDir>/widgets` and for the same reasons: `data/` is git-ignored so an installed
 * theme never lands in a commit, `FREMKIT_DATA_DIR` moves it with the rest of the install, and a
 * checkout updated with `git pull` cannot have a downloaded theme quietly survive an update.
 */
export function installedThemesDir(dataDir: string): string {
  return join(dataDir, 'themes')
}
