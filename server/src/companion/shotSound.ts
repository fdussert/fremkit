/**
 * The capture sound a Fremdev shot may ask for (`dev.shot` with `sound: true`, an option of the
 * extension that is off by default): macOS's own screenshot sound, played by `/usr/bin/afplay`.
 *
 * Both paths are constants: the program by its absolute path (never through `PATH`), the file the
 * system's own, as one argument of a list (`execFile`, never a shell). Nothing the extension sends
 * reaches the command line; the message only says whether to play. A failure is ignored: the shot is
 * on the clipboard already, and a missing sound is no error to show anyone.
 */

import { execFile } from 'node:child_process'
import type { ExecFile } from './shot.js'

export const AFPLAY = '/usr/bin/afplay'
export const SHOT_SOUND_FILE = '/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif'
/** The sound lasts under a second; a stuck player is killed after this. */
export const SHOT_SOUND_TIMEOUT_MS = 5_000

export interface ShotSound {
  play(): void
}

/** Plays nothing: tests, and a server built without a sound. */
export const silentShotSound: ShotSound = { play: () => undefined }

export function afplayShotSound(exec: ExecFile = execFile as unknown as ExecFile): ShotSound {
  return {
    play() {
      try {
        exec(AFPLAY, [SHOT_SOUND_FILE], { timeout: SHOT_SOUND_TIMEOUT_MS }, () => undefined)
      } catch {
        // execFile throws synchronously only on bad arguments, which these constants are not.
      }
    },
  }
}
