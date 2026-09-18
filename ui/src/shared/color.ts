/** Colour helpers for the per-instance accent. Mirrors HEX_COLOR_RE on the server. */
import type { AccentMode } from './types'

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * The theme's own accent and surface, repeated here as literals. `tokens.css` holds them as CSS
 * variables, whose value only the browser knows; picking a readable text colour needs a real
 * colour, so these two have to be kept in step with `--accent` and `--surface` by hand.
 */
export const THEME_ACCENT = '#d9b36a'
export const THEME_SURFACE = '#14171c'

/** White and near-black used as foregrounds on top of an accent; the latter is the app background. */
export const ON_ACCENT_LIGHT = '#ffffff'
export const ON_ACCENT_DARK = '#0b0d10'

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value)
}

/** The three channels of a `#rrggbb` colour, 0-255. */
export function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

/** A `#rrggbb` colour as an `rgba()` string, so an opacity can be mixed into a literal colour. */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white). Used only to pick a readable
 * foreground, so the exact sRGB transfer function matters more than speed here.
 */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The text colour to pair with `hex`. The 0.45 threshold sits a little above the
 * usual 0.179 contrast crossover: on a dashboard read from a metre away, white on a
 * mid-tone accent stays more legible than near-black does.
 */
export function onAccent(hex: string): string {
  if (!isHexColor(hex)) return ON_ACCENT_LIGHT
  return luminance(hex) > 0.45 ? ON_ACCENT_DARK : ON_ACCENT_LIGHT
}

/**
 * The two colours a theme paints where an instance names none. They are what the luminance rules
 * below are judged against, so they have to be the theme in force rather than the built-in
 * palette: on a light theme, black-on-accent and white-on-accent swap sides.
 */
export interface ThemeColors { accent: string; surface: string }
export const BUILTIN_COLORS: ThemeColors = { accent: THEME_ACCENT, surface: THEME_SURFACE }

/** The accent a tile actually paints with: the one it carries, or the theme's. */
export function tileAccent(accentColor?: string, theme: ThemeColors = BUILTIN_COLORS): string {
  return isHexColor(accentColor) ? accentColor : theme.accent
}

/**
 * The colour a tile's body is actually painted with: the accent when it fills the whole tile,
 * otherwise the tile's own background colour, and the theme surface when it has none. Always a
 * literal, because the only thing asked of it is its luminance.
 */
export function tileBody(accentMode: AccentMode | undefined, accentColor?: string, bgColor?: string,
  theme: ThemeColors = BUILTIN_COLORS): string {
  if (accentMode === 'fill') return tileAccent(accentColor, theme)
  return isHexColor(bgColor) ? bgColor : theme.surface
}

/**
 * The text colour that reads on that body. The frame paints it as `--tile-text` and the bridge
 * hands the same value to the widget as `--on-surface`, so the two never disagree.
 */
export function tileText(accentMode: AccentMode | undefined, accentColor?: string, bgColor?: string,
  theme: ThemeColors = BUILTIN_COLORS): string {
  return onAccent(tileBody(accentMode, accentColor, bgColor, theme))
}
