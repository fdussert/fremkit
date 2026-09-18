import { z } from 'zod'
import { BUILTIN_THEME } from '../themes/theme.js'
import { defaultSecretsBackend } from '../secrets/index.js'
import { tr } from '../i18n.js'
import { DEFAULT_BACKGROUND } from '../backgrounds/seed.js'

export const WIDGET_ID_RE = /^[a-z0-9_-]+$/
/** Colours are stored as `#rrggbb` only: no short form, no alpha, no named colour. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * How much of the tile the accent paints: `none` leaves it to the widget's own bars and
 * highlights, `frame` colours the title bar and the border, `fill` colours the whole tile.
 * Absent means `none`, so the default is stored as a missing key rather than as a value.
 */
export const AccentModeSchema = z.enum(['none', 'frame', 'fill'])
export type AccentMode = z.infer<typeof AccentModeSchema>

/**
 * The three-way `appearance` a tile used to carry, with its `accentStyle` companion. Kept only so
 * a file written against them still parses: `normalizeInstances` turns both into the background
 * and accent keys above and drops them, on load and on save alike.
 */
export const LegacyAppearanceSchema = z.enum(['panel', 'transparent', 'accent'])
export const LegacyAccentStyleSchema = z.enum(['fill', 'outline'])

export const BackgroundFitSchema = z.enum(['cover', 'contain'])
export type BackgroundFit = z.infer<typeof BackgroundFitSchema>

/** Stored image name, as returned by POST /api/backgrounds. A file name, never a path. */
export const BACKGROUND_NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * The single gate every background file name goes through, in the config and in the routes.
 * The character class already excludes separators; the two extra rules keep out `..`
 * and dot-files, so the name can only ever resolve inside data/backgrounds.
 */
export function isSafeBackgroundName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 200 && BACKGROUND_NAME_RE.test(name)
    && !name.includes('..') && !name.startsWith('.')
}

// The message is a callback rather than a string so it is resolved when the value is parsed,
// against the locale in force then, instead of being frozen when this module loads.
const BackgroundImageName = z.string().refine(isSafeBackgroundName, { error: () => tr(undefined, 'config.backgroundName') })

/** Darkest overlay a widget image may carry: past this the image no longer reads as one. */
export const MAX_WIDGET_DIM = 0.9
/** Overlay opacity applied when a widget image carries no explicit `dim`. */
export const DEFAULT_WIDGET_DIM = 0.35

/**
 * A background image for one widget instance, drawn behind its transparent iframe. `dim` is
 * the opacity of the black overlay laid over it, which is what keeps the widget's text
 * readable; it is left absent far more often than not, hence the default rather than a value.
 */
export const WidgetBackgroundSchema = z.object({
  image: BackgroundImageName,
  fit: BackgroundFitSchema.optional(),
  dim: z.number().min(0).max(MAX_WIDGET_DIM).optional(),
})
export type WidgetBackground = z.infer<typeof WidgetBackgroundSchema>

/**
 * How opaque a surface is painted, 0 (invisible) to 1 (solid). Shared by the widget tile and the
 * navigation bar: both let the screen background show through when the value is below 1. Absent
 * means 1 everywhere, so the default is stored as a missing key rather than as a value.
 */
export const OpacitySchema = z.number().min(0).max(1)

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
  /** @deprecated Converted and dropped by `normalizeInstances`; never written back out. */
  appearance: LegacyAppearanceSchema.optional(),
  /** @deprecated Converted and dropped by `normalizeInstances`; never written back out. */
  accentStyle: LegacyAccentStyleSchema.optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
})

export const PageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  widgets: z.array(WidgetInstanceSchema).default([]),
})

export const BackgroundSchema = z.object({
  color: z.string().regex(HEX_COLOR_RE).optional(),
  image: BackgroundImageName.optional(),
  fit: BackgroundFitSchema.optional(),
})
export type Background = z.infer<typeof BackgroundSchema>

/**
 * Height of the dashboard navigation bar, in pixels. The Edge panel is 720 px tall and the bar
 * eats into the widget area: 80 px leaves 16 rows of 40 px, 40 px leaves 17. Absent means 80,
 * the height the bar has always had, so no existing file has to be rewritten.
 */
export const NavHeightSchema = z.union([z.literal(80), z.literal(40)])
export type NavHeight = z.infer<typeof NavHeightSchema>

/**
 * A sanity ceiling on the bar's widget count. The real limit is width: the admin refuses a
 * widget whose cells would push a cluster into the page dots, so this only guards the file.
 */
export const MAX_NAV_WIDGETS = 12

/** Which side of the centred dots a bar widget sits on. */
export const NavSlotSchema = z.enum(['left', 'right'])
export type NavSlot = z.infer<typeof NavSlotSchema>

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

/**
 * Which gesture on the page dots opens the admin.
 *
 * The Edge has no keyboard and no window chrome, so this is the only way in from the screen. The
 * touch driver turns a held press into a right click and a double tap into a double click, and
 * the two are independent — hence the choice, and hence `both` as the default: whichever the
 * panel and the browser happen to deliver, one of them gets there.
 */
export const AdminGestureSchema = z.enum(['longPress', 'doubleTap', 'both'])
export type AdminGesture = z.infer<typeof AdminGestureSchema>
export const DEFAULT_ADMIN_GESTURE: AdminGesture = 'both'

export const DisplaySchema = z.object({
  cols: z.number().int().min(1).default(64),
  rows: z.number().int().min(1).default(16),
  cell: z.number().int().min(1).default(40),
  autoCycleSeconds: z.number().int().min(0).default(0),
  /** Id of a theme in `themes/`. An unknown id falls back to the built-in one. */
  theme: z.string().regex(/^[a-z0-9_-]+$/).default(BUILTIN_THEME),
  /** Absent means 80: the default is stored as a missing key, never as a value. */
  navHeight: NavHeightSchema.optional(),
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
   * Compact widgets drawn in the navigation bar, in cluster order. Absent means none; an empty
   * list is folded back to a missing key by `normalizeInstances`, so the default is never
   * written out as a value.
   */
  navWidgets: z.array(NavWidgetSchema).max(MAX_NAV_WIDGETS).optional(),
})

/** A connection id is a slug: it becomes a channel suffix and a secret-key segment. */
export const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9-]*$/

export const ConnectionSchema = z.object({
  id: z.string().regex(CONNECTION_ID_RE),
  type: z.string().regex(WIDGET_ID_RE),
  name: z.string().min(1),
  /** Non-secret fields only. Secret values live in the SecretStore, never here. */
  fields: z.record(z.string(), z.string()).default({}),
})
export type Connection = z.infer<typeof ConnectionSchema>

export const SecretsSchema = z.object({
  backend: z.enum(['keychain', 'file']).default(defaultSecretsBackend()),
})

export const LocaleSchema = z.enum(['fr', 'en'])
export type Locale = z.infer<typeof LocaleSchema>

/** Read once, when this module loads: the process locale never changes under us. */
const SYSTEM_LOCALE = Intl.DateTimeFormat().resolvedOptions().locale

/** A French system gets French, everything else English — the same shape as the secrets default. */
export function defaultLocale(locale: string = SYSTEM_LOCALE): Locale {
  return locale.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

/**
 * What Fremkit is allowed to read on this Mac beyond its own files.
 *
 * Everything here is off until the user turns it on in the admin, and each entry names exactly
 * what is read and where it goes. Nothing is inferred from a widget being on the dashboard: a
 * widget asking for data is not consent to read a credential.
 */
const PrivacySchema = z.object({
  /**
   * Read Claude Code's OAuth token from the macOS keychain item `Claude Code-credentials` and
   * ask `api.anthropic.com` for this account's usage, which is what the claude-usage widget's
   * gauges show. The token is never stored, logged or sent anywhere else. The endpoint is
   * undocumented and may disappear.
   */
  claudeAccountUsage: z.boolean().default(false),
}).prefault({})

/**
 * What the user was shown and accepted when a widget was installed, per widget.
 *
 * The manifest on disk is what a widget *asks* for; this is what it was *granted*. They are the
 * same thing on the day of the install and can drift the moment an update lands, so the bridge
 * enforces the intersection: a channel in the manifest and not here is refused exactly like one
 * that was never declared. An update whose permissions grew therefore does nothing until the
 * user has seen the difference and said yes — the widget's own files cannot widen it.
 *
 * Built-ins have no record and need none: they ship with the server and are trusted with it.
 * `registry` is stored so a record says which index the widget came from, not just that one did.
 */
export const ConsentSchema = z.object({
  version: z.string().min(1),
  registry: z.string().min(1).max(64),
  consentedPermissions: z.object({
    subscriptions: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    network: z.array(z.string()).default([]),
  }),
  installedAt: z.string().min(1),
})
export type WidgetConsent = z.infer<typeof ConsentSchema>

export const MarketplaceSchema = z.object({
  /** Keyed by widget id, which is also the folder name under `<dataDir>/widgets`. */
  installed: z.record(z.string().regex(WIDGET_ID_RE), ConsentSchema).default({}),
}).prefault({})
export type MarketplaceState = z.infer<typeof MarketplaceSchema>

export const ConfigSchema = z.object({
  version: z.literal(2),
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

export type Config = z.infer<typeof ConfigSchema>
export type Page = z.infer<typeof PageSchema>
export type WidgetInstance = z.infer<typeof WidgetInstanceSchema>
export type NavWidget = z.infer<typeof NavWidgetSchema>

export const DEFAULT_CONFIG: Config = {
  version: 2,
  display: {
    cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0, theme: BUILTIN_THEME,
    // The shipped wallpaper, seeded into the background library at start. Referenced like any
    // other image, so the Screen inspector shows it selected and "remove" leaves no background
    // at all rather than putting a hardcoded one back.
    //
    // Which means a copy of the project with no `brand/wallpaper/` starts with a config naming an
    // image that is not there: the seed cannot fail the boot over it, and the page simply paints
    // no background. Harmless, and the user can pick another — but it is why `brand/wallpaper/`
    // travels with a release, not only with the git checkout. See `backgrounds/seed.ts`.
    background: { image: DEFAULT_BACKGROUND, fit: 'cover' },
  },
  connections: [],
  secrets: { backend: defaultSecretsBackend() },
  locale: defaultLocale(),
  privacy: { claudeAccountUsage: false },
  marketplace: { installed: {} },
  pages: [
    {
      id: 'home',
      name: tr(defaultLocale(), 'config.defaultPageName'),
      widgets: [{ instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, showTitle: true, settings: {} }],
    },
  ],
}

type SizeInfo = { minSize: [number, number]; compact?: { width: number } }

function overlaps(a: WidgetInstance, b: WidgetInstance): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Messages come back in the language the config being checked asks for. */
export function validateLayout(config: Config, manifests: Map<string, SizeInfo>): string[] {
  const errors: string[] = []
  const locale = config.locale
  for (const page of config.pages) {
    const seen = new Set<string>()
    for (const w of page.widgets) {
      if (seen.has(w.instanceId)) errors.push(tr(locale, 'layout.duplicateInstance', { page: page.id, instanceId: w.instanceId }))
      seen.add(w.instanceId)
      if (w.x + w.w > config.display.cols || w.y + w.h > config.display.rows) {
        errors.push(tr(locale, 'layout.outsideGrid', { page: page.id, instanceId: w.instanceId }))
      }
      const m = manifests.get(w.widgetId)
      if (m && (w.w < m.minSize[0] || w.h < m.minSize[1])) {
        errors.push(tr(locale, 'layout.tooSmall', {
          page: page.id, instanceId: w.instanceId, w: w.w, h: w.h, minW: m.minSize[0], minH: m.minSize[1], widgetId: w.widgetId,
        }))
      }
    }
    for (let i = 0; i < page.widgets.length; i++) {
      for (let j = i + 1; j < page.widgets.length; j++) {
        const a = page.widgets[i], b = page.widgets[j]
        if (overlaps(a, b)) errors.push(tr(locale, 'layout.overlap', { page: page.id, a: a.instanceId, b: b.instanceId }))
      }
    }
  }
  return errors
}

/**
 * The navigation bar only draws widgets that have a compact rendering, so a bar entry naming a
 * widget the catalog does not know — or one that declares no `compact` — is refused rather than
 * silently dropped. Messages come back in the language the config asks for, like the layout ones.
 */
export function validateNavWidgets(config: Config, manifests: Map<string, SizeInfo>): string[] {
  const errors: string[] = []
  const locale = config.locale
  const seen = new Set<string>()
  for (const w of config.display.navWidgets ?? []) {
    if (seen.has(w.instanceId)) errors.push(tr(locale, 'navWidgets.duplicateInstance', { instanceId: w.instanceId }))
    seen.add(w.instanceId)
    const m = manifests.get(w.widgetId)
    if (!m) errors.push(tr(locale, 'navWidgets.unknownWidget', { widgetId: w.widgetId }))
    else if (!m.compact) errors.push(tr(locale, 'navWidgets.notCompact', { widgetId: w.widgetId }))
  }
  return errors
}

/** Connection-level checks the zod schema cannot express on its own. */
export function validateConnections(config: Config): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const c of config.connections) {
    if (seen.has(c.id)) errors.push(tr(config.locale, 'config.duplicateConnection', { id: c.id }))
    seen.add(c.id)
  }
  return errors
}
