import { z } from 'zod'
import { BUILTIN_THEME } from '../themes/theme.js'
import {
  WIDGET_ID_RE, HEX_COLOR_RE, AccentModeSchema,
  WidgetBackgroundSchema, OpacitySchema, BackgroundSchema, NavHeightSchema, NavStyleSchema, MAX_NAV_WIDGETS, NavSlotSchema,
  AdminGestureSchema, ConnectionSchema, SecretsSchema, LocaleSchema, defaultLocale, PrivacySchema, MarketplaceSchema,
} from './schema.js'

/**
 * The v3 config shape, as it was before a file could describe more than one screen.
 *
 * Kept only so `migrate.ts` can read a v3 file — and run the v3 normalisations on it — before it
 * converts it to v4. Nothing else should import from here: the live shape is in `schema.ts`.
 */

/**
 * The three-way `appearance` a tile used to carry, with its `accentStyle` companion. Kept only so
 * a v3 file written against them still parses: `normalizeV3` turns both into the background and
 * accent keys and drops them before the file is converted, so no v4 config ever carries them.
 */
export const LegacyAppearanceSchema = z.enum(['panel', 'transparent', 'accent'])
export const LegacyAccentStyleSchema = z.enum(['fill', 'outline'])

export const WidgetInstanceSchema = z.object({
  instanceId: z.string().min(1),
  widgetId: z.string().regex(WIDGET_ID_RE),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  title: z.string().optional(),
  showTitle: z.boolean().default(true),
  /** Colour of the tile's own surface. Absent means the theme surface, `--surface`. */
  bgColor: z.string().regex(HEX_COLOR_RE).optional(),
  /** Overrides the theme accent for this instance, whatever `accentMode` does with it. */
  accentColor: z.string().regex(HEX_COLOR_RE).optional(),
  /** How much of the tile the accent paints; absent means 'none'. */
  accentMode: AccentModeSchema.optional(),
  /** Absent means the tile keeps its plain surface, which is the default. */
  background: WidgetBackgroundSchema.optional(),
  /**
   * Opacity of the tile's own surface, letting the screen background show through. 0 makes the
   * tile — border included — fully see-through. Absent means a solid tile.
   */
  opacity: OpacitySchema.optional(),
  /** @deprecated Converted and dropped by `normalizeV3`; never written back out. */
  appearance: LegacyAppearanceSchema.optional(),
  /** @deprecated Converted and dropped by `normalizeV3`; never written back out. */
  accentStyle: LegacyAccentStyleSchema.optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
})

export const PageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  widgets: z.array(WidgetInstanceSchema).default([]),
})

/**
 * One widget drawn inside the navigation bar. It has no geometry — the bar sizes it from the
 * manifest's `compact.width` — and no appearance: the bar is its surface. `slot` picks the
 * cluster it joins, and its position in this list orders it within that cluster.
 */
export const NavWidgetSchema = z.object({
  instanceId: z.string().min(1),
  widgetId: z.string().regex(WIDGET_ID_RE),
  slot: NavSlotSchema.default('left'),
  /**
   * Touching the widget opens a popover showing the same widget in full, as a tile. Absent means
   * no popover, so the touch reaches the compact widget itself, which is the default everywhere.
   */
  popup: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
})

export const DisplaySchema = z.object({
  cols: z.number().int().min(1).default(64),
  rows: z.number().int().min(1).default(16),
  cell: z.number().int().min(1).default(40),
  autoCycleSeconds: z.number().int().min(0).default(0),
  /** Id of a theme in `themes/`. An unknown id falls back to the built-in one. */
  theme: z.string().regex(/^[a-z0-9_-]+$/).default(BUILTIN_THEME),
  /** Absent means 80: the default is stored as a missing key, never as a value. */
  navHeight: NavHeightSchema.optional(),
  /**
   * Dots or page names in the bar; absent means dots. Named pages landed while files were still
   * v3, so a v3 file can carry it, and v4 keeps it on the Edge screen's display.
   */
  navStyle: NavStyleSchema.optional(),
  /** Opacity of the navigation bar's background. Absent means a solid bar. */
  navOpacity: OpacitySchema.optional(),
  /**
   * The opacity a tile gets when it is added. Absent means solid, like a tile with no
   * `opacity` of its own; each tile keeps its own value afterwards, so changing this touches
   * only the tiles placed from then on.
   */
  tileOpacity: OpacitySchema.optional(),
  /** Absent means `both`; see `AdminGestureSchema`. */
  adminGesture: AdminGestureSchema.optional(),
  /** Absent means the plain --bg theme background, which is the default everywhere. */
  background: BackgroundSchema.optional(),
  /**
   * Compact widgets drawn in the navigation bar, in cluster order. Absent means none. Each one
   * becomes a `widgets` entry and a nav item of the Edge screen in v4.
   */
  navWidgets: z.array(NavWidgetSchema).max(MAX_NAV_WIDGETS).optional(),
})

export const V3ConfigSchema = z.object({
  version: z.literal(3),
  display: DisplaySchema.prefault({}),
  connections: z.array(ConnectionSchema).default([]),
  secrets: SecretsSchema.prefault({}),
  /** Language of the admin and of the screen. Absent in every file written before it existed. */
  locale: LocaleSchema.default(defaultLocale()),
  privacy: PrivacySchema,
  /** Absent in every file written before the marketplace existed, which means nothing installed. */
  marketplace: MarketplaceSchema,
  pages: z.array(PageSchema).min(1),
})

export type V3Config = z.infer<typeof V3ConfigSchema>
export type V3WidgetInstance = z.infer<typeof WidgetInstanceSchema>
