import { isHexColor, rgba } from './color'
import type { Background, BackgroundFit, WidgetBackground } from './types'

/** Where the background routes serve a stored image from. */
export const backgroundUrl = (name: string): string => `/api/backgrounds/${encodeURIComponent(name)}`

/** Mirror MAX_WIDGET_DIM and DEFAULT_WIDGET_DIM on the server. */
export const MAX_WIDGET_DIM = 0.9
export const DEFAULT_WIDGET_DIM = 0.35

/** The four properties that paint a stored image: centred, never repeated, covering by default. */
function imageStyle(image: string, fit: BackgroundFit | undefined): Record<string, string> {
  return {
    'background-image': `url(${backgroundUrl(image)})`,
    'background-size': fit === 'contain' ? 'contain' : 'cover',
    'background-position': 'center',
    'background-repeat': 'no-repeat',
  }
}

/**
 * Inline style for the dashboard background, shared by the real dashboard and the admin's
 * canvas preview so both always show the same thing. Returns an empty object when nothing
 * is configured, leaving the stylesheet's own `background` in place.
 */
export function backgroundStyle(bg: Background | undefined): Record<string, string> {
  const style: Record<string, string> = {}
  if (!bg) return style
  if (isHexColor(bg.color)) style['background-color'] = bg.color
  if (bg.image) Object.assign(style, imageStyle(bg.image, bg.fit))
  return style
}

/**
 * Inline style for one widget instance's image layer, drawn behind its transparent iframe.
 * Empty when the instance carries no image, so the tile keeps its appearance's own surface.
 */
export function widgetBackgroundStyle(bg: WidgetBackground | undefined): Record<string, string> {
  return bg?.image ? imageStyle(bg.image, bg.fit) : {}
}

/**
 * Opacity of the black overlay that keeps a widget's text readable over its image. Anything
 * missing or out of range falls back to the default rather than blanking out the tile.
 */
export function widgetDim(bg: WidgetBackground | undefined): number {
  const dim = bg?.dim
  if (typeof dim !== 'number' || !Number.isFinite(dim)) return DEFAULT_WIDGET_DIM
  return Math.min(MAX_WIDGET_DIM, Math.max(0, dim))
}

/**
 * How opaque a surface is painted. Anything missing or out of range reads as solid, so a
 * config written before the setting existed — or a broken one — still shows a normal screen.
 */
export function surfaceOpacity(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0, value))
}

/**
 * `color` faded to `alpha`. A literal `#rrggbb` becomes an `rgba()`, which is exact; a CSS
 * variable has to go through `color-mix`, since its value is only known to the browser.
 */
export function fade(color: string, alpha: number): string {
  if (alpha >= 1) return color
  return isHexColor(color) ? rgba(color, alpha) : `color-mix(in srgb, ${color} ${alpha * 100}%, transparent)`
}
