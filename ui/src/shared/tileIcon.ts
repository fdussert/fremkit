import { TILE_ICONS } from './icons'

/** Where the server serves an imported tile icon. Names are already safe; encoding is belt and braces. */
export function tileIconUrl(name: string): string {
  return '/api/tile-icons/' + encodeURIComponent(name)
}

/** A pictogram the picker offers and the frame draws. An array lookup, so `constructor` is never one. */
export function isChoosablePictogram(name: string | undefined): name is string {
  return name !== undefined && TILE_ICONS.includes(name)
}
