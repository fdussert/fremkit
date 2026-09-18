import { copyFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The wallpaper a fresh install starts with, as it is named in the background library. */
export const DEFAULT_BACKGROUND = 'fremkit-wallpaper.png'

/** Where it ships: `brand/wallpaper/`, rendered from its SVG by `brand/tools/build-assets.py`. */
const SHIPPED = fileURLToPath(new URL('../../../brand/wallpaper/' + DEFAULT_BACKGROUND, import.meta.url))

/**
 * Puts the shipped wallpaper into the user's background library, once.
 *
 * It is copied in as a *file*, not special-cased anywhere: it then appears in the Screen
 * inspector next to anything the user uploaded, can be picked, and can be deleted. Removing it
 * leaves the dashboard with no background at all, which the config already expresses as an
 * absent `display.background` — so there is no hardcoded fallback to fight.
 *
 * Never overwrites: a user who replaced the file with their own keeps theirs. A delete followed
 * by a restart brings the file back, which is harmless — the config no longer references it, so
 * nothing changes on screen; it is simply offered in the library again.
 *
 * Returns true when it copied, for the tests and for nothing else.
 *
 * When `brand/wallpaper/` is not there at all — a release tarball that left it out — nothing is
 * copied and `DEFAULT_CONFIG` still names the image: a fresh install paints no background until
 * the user picks one. Not a reason to refuse to start, but a reason for a release to ship the
 * folder.
 */
export async function seedDefaultBackground(dataDir: string): Promise<boolean> {
  const dir = join(dataDir, 'backgrounds')
  const target = join(dir, DEFAULT_BACKGROUND)
  if (await access(target).then(() => true, () => false)) return false
  try {
    await mkdir(dir, { recursive: true })
    await copyFile(SHIPPED, target)
    return true
  } catch {
    // A checkout without the brand folder, or a read-only data dir: a missing wallpaper is not a
    // reason to refuse to start.
    return false
  }
}
