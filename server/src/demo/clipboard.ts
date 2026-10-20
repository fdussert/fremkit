/**
 * The Mac's clipboard, as a demo has it: nowhere. A demo never acts on the Mac it runs on, and the
 * companion's report command (`pbcopy`) and shot route (`osascript`) would otherwise write the real
 * one. Both are reachable only by an extension paired with the demo, but nothing should be.
 */

import type { ImageClipboard } from '../companion/shot.js'
import type { Pasteboard } from '../providers/clipboard.js'

/** Takes Fremdev's report and drops it; reads as empty. */
export const demoPasteboard: Pasteboard = {
  read: async () => '',
  write: async () => undefined,
  types: async () => [],
}

/** Takes Fremdev's shot and drops it. */
export const demoImageClipboard: ImageClipboard = {
  writeJpeg: async () => undefined,
}
