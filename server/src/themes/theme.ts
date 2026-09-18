import { z } from 'zod'

/**
 * Same shape as a manifest text — one string, or a `{ fr, en }` pair — declared here rather than
 * imported: the config schema reads this module, and the manifest module reads the config schema.
 */
const LocalizedTextSchema = z.union([z.string(), z.record(z.string(), z.string())])

/**
 * A theme is a set of values for the design tokens the dashboard, the admin and the widgets
 * already read as CSS custom properties. Its keys are the property names without the leading
 * dashes, so `"surface-2"` is `--surface-2`: nothing to map, and a token added to
 * `ui/src/shared/tokens.css` only needs a line here to become themeable.
 *
 * Values are checked against the shape their property accepts. They end up in a `style`
 * attribute on `<html>`, in the dashboard and inside every widget frame, so a value that could
 * close a declaration and start another one is refused rather than escaped.
 */
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const LENGTH = /^\d+(?:\.\d+)?(?:px|rem|em)$/
/** Family stacks: names, quotes, commas. No parentheses, so no `url()` and no `var()`. */
const FONT = /^[\w\s,'"-]{1,200}$/
/**
 * Offsets, a blur, a spread and a colour, as many shadows as wanted — and nothing else. Spelled
 * out rather than as a character class, which admitted any `name(arg)` a theme cared to write:
 * `url()` and `image-set()` fetch, `element()` paints another part of the page, and a theme will
 * arrive from a registry rather than from the user's own disk.
 */
const SHADOW_LENGTH = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)?`
const SHADOW_COLOR = String.raw`(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})`
  + String.raw`|(?:rgb|rgba|hsl|hsla)\(\s*[-\d.,%\s]{1,60}\)|transparent|currentColor)`
const ONE_SHADOW = String.raw`(?:inset\s+)?(?:${SHADOW_LENGTH}\s+){2,4}${SHADOW_COLOR}`
const SHADOW = new RegExp(String.raw`^(?:none|${ONE_SHADOW}(?:\s*,\s*${ONE_SHADOW})*)$`)

const value = (re: RegExp) => z.string().regex(re)

export const TOKENS = {
  bg: COLOR,
  surface: COLOR,
  'surface-2': COLOR,
  'surface-3': COLOR,
  border: COLOR,
  /** The tile's own card: a theme that sets both to #00000000 draws no card at all. */
  'tile-surface': COLOR,
  'tile-outline': COLOR,
  /** The navigation bar, which sits on the page rather than on a tile. */
  'nav-surface': COLOR,
  'nav-outline': COLOR,
  'border-strong': COLOR,
  text: COLOR,
  'text-muted': COLOR,
  'text-dim': COLOR,
  accent: COLOR,
  'accent-hover': COLOR,
  'accent-2': COLOR,
  'on-accent': COLOR,
  danger: COLOR,
  ok: COLOR,
  warn: COLOR,
  font: FONT,
  'font-mono': FONT,
  'fs-xs': LENGTH,
  'fs-sm': LENGTH,
  'fs-md': LENGTH,
  'fs-lg': LENGTH,
  'radius-sm': LENGTH,
  'radius-md': LENGTH,
  shadow: SHADOW,
  ring: SHADOW,
} as const

export type TokenName = keyof typeof TOKENS

/**
 * How much bigger a widget draws its own text. Widgets size text from the tile they are given,
 * so a theme cannot hand them a font size; it hands them a multiplier they apply to their own
 * arithmetic, which keeps a tile that fits at 1 fitting at 1.3.
 */
export const TEXT_SCALE = 'text-scale'
export const TEXT_SCALE_RANGE = { min: 0.8, max: 2 }

export const TokensSchema = z.strictObject({
  ...Object.fromEntries(Object.entries(TOKENS).map(([name, re]) => [name, value(re).optional()])),
  [TEXT_SCALE]: z.number().min(TEXT_SCALE_RANGE.min).max(TEXT_SCALE_RANGE.max).optional(),
} as { [K in TokenName]: z.ZodOptional<z.ZodString> } & { [TEXT_SCALE]: z.ZodOptional<z.ZodNumber> })

/** Semver, so the registry can tell one version of a theme from the next. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const ThemeSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: LocalizedTextSchema,
  version: z.string().regex(SEMVER),
  description: LocalizedTextSchema.optional(),
  /**
   * Who made it and under what terms. The dashboard paints none of this; it is carried so a
   * theme published in the registry keeps its credit and its licence with it.
   */
  author: z.string().min(1).max(120).optional(),
  homepage: z.url({ protocol: /^https$/ }).max(300).optional(),
  license: z.string().min(1).max(60).optional(),
  /** Only the tokens this theme changes; the rest keep the values of the built-in one. */
  tokens: TokensSchema.default({}),
})
export type Theme = z.infer<typeof ThemeSchema>

/** The id a config falls back to, and the theme every other one is layered on. */
export const BUILTIN_THEME = 'fremkit'

/** WCAG relative luminance of a `#rgb`, `#rrggbb` or `#rrggbbaa`, or null when it is not one. */
function luminance(hex: string): number | null {
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])[0-9a-fA-F]?$/.exec(hex)
  const long = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})(?:[0-9a-fA-F]{2})?$/.exec(hex)
  const parts = long ? long.slice(1, 4) : short ? short.slice(1, 4).map((c) => c + c) : null
  if (!parts) return null
  const [r, g, b] = parts.map((c) => {
    const v = parseInt(c, 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The text colour to pair with an accent. Same 0.45 threshold as `ui/src/shared/color.ts` and
 * the bridge's own copy: three places, one number, and they have to stay in step.
 */
function onAccent(hex: string): string {
  const l = luminance(hex)
  return l !== null && l > 0.45 ? '#0b0d10' : '#ffffff'
}

/**
 * The custom properties to set on `<html>`, `--` included, for a theme layered on the built-in
 * one. Both arguments are already-validated themes, so every value here is safe to write into a
 * style attribute.
 *
 * One token is computed rather than merged: a theme that sets `accent` and leaves `on-accent`
 * alone inherits the built-in theme's, which was chosen for the built-in accent. A pale accent
 * would then be printed on in near-white. Deriving it is what every other accent in the product
 * already does — the per-tile accent in the admin, the bridge inside a widget — so a theme
 * saying "my accent is this" gets the same answer they do, and a theme that names `on-accent`
 * itself is still obeyed.
 */
export function cssVariables(theme: Theme | undefined, builtin: Theme | undefined): Record<string, string> {
  const merged: Record<string, string | number> = { ...(builtin?.tokens ?? {}), ...(theme?.tokens ?? {}) }
  const own = theme?.tokens ?? {}
  if (own.accent && !own['on-accent']) merged['on-accent'] = onAccent(own.accent)
  return Object.fromEntries(Object.entries(merged).map(([name, v]) => [`--${name}`, String(v)]))
}
