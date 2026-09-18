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
/** Offsets, a blur and a colour — the only functions allowed are the colour ones. */
const SHADOW = /^(?:inset\s+)?[-\d\s.,()%#a-zA-Z]{1,160}$/

const value = (re: RegExp) => z.string().regex(re)

export const TOKENS = {
  bg: COLOR,
  surface: COLOR,
  'surface-2': COLOR,
  'surface-3': COLOR,
  border: COLOR,
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

export const ThemeSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: LocalizedTextSchema,
  version: z.string().min(1),
  description: LocalizedTextSchema.optional(),
  /** Only the tokens this theme changes; the rest keep the values of the built-in one. */
  tokens: TokensSchema.default({}),
})
export type Theme = z.infer<typeof ThemeSchema>

/** The id a config falls back to, and the theme every other one is layered on. */
export const BUILTIN_THEME = 'fremkit'

/**
 * The custom properties to set on `<html>`, `--` included, for a theme layered on the built-in
 * one. Both arguments are already-validated themes, so every value here is safe to write into a
 * style attribute.
 */
export function cssVariables(theme: Theme | undefined, builtin: Theme | undefined): Record<string, string> {
  const merged = { ...(builtin?.tokens ?? {}), ...(theme?.tokens ?? {}) }
  return Object.fromEntries(Object.entries(merged).map(([name, v]) => [`--${name}`, String(v)]))
}
