import { join } from 'node:path'

/**
 * Where the widgets the user installed from the marketplace live.
 *
 * Under the data directory rather than beside the built-ins, for three reasons that all say the
 * same thing: `data/` is already git-ignored, so an installed widget never lands in a commit;
 * `FREMKIT_DATA_DIR` moves it with the rest of the install, so a from-scratch run starts with no
 * third-party code at all; and a checkout that is only ever updated with `git pull` cannot have
 * a downloaded widget quietly survive — or conflict with — an update.
 */
export function installedWidgetsDir(dataDir: string): string {
  return join(dataDir, 'widgets')
}
