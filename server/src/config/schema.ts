import { z } from 'zod'
import { HistorySourceSchema } from '../codex/sources.js'
import { BUILTIN_THEME } from '../themes/theme.js'
import { defaultSecretsBackend } from '../secrets/index.js'
import { tr } from '../i18n.js'
import { DEFAULT_BACKGROUND } from '../backgrounds/seed.js'
import { navHasRoom, navSideRoom, navWiderClusterWidth } from './nav.js'

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

/**
 * The longest instance id the config accepts. The proxy already caps the id it is handed at 64,
 * and an id the proxy would refuse is an instance that could never reach its connection.
 */
export const INSTANCE_ID_MAX = 64
const InstanceIdSchema = z.string().min(1).max(INSTANCE_ID_MAX)

/**
 * What a widget instance *is*, shared by every screen that shows it: which widget, how its tile
 * looks, and its settings. Where it sits is a `Placement` (or a `NavItem`) on each screen, keyed
 * by the instance id this is stored under in `Config.widgets`.
 *
 * The v3 `WidgetInstance` (see `v3.ts`) minus its id, its geometry and the two legacy appearance
 * keys, which the migration converts on the v3 shape before building this one. Unknown keys are
 * stripped, so a stray `x` never survives a parse.
 */
export const WidgetSchema = z.object({
  widgetId: z.string().regex(WIDGET_ID_RE),
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
  settings: z.record(z.string(), z.unknown()).default({}),
})

/** Where one widget sits on one page of one screen, in cells. Everything else is in `widgets`. */
export const PlacementSchema = z.object({
  instanceId: InstanceIdSchema,
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  /**
   * Pins the tile where it is: the editor neither drags nor resizes it. Absent means unlocked,
   * so a file written before this existed reads exactly as before and needs no migration.
   */
  locked: z.boolean().optional(),
})

export const BackgroundSchema = z.object({
  color: z.string().regex(HEX_COLOR_RE).optional(),
  image: BackgroundImageName.optional(),
  fit: BackgroundFitSchema.optional(),
})
export type Background = z.infer<typeof BackgroundSchema>

export const PageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  items: z.array(PlacementSchema).default([]),
  /**
   * This page's own background, shown instead of the screen's while the page is on screen. Absent
   * means the screen's (`display.background`), which is every page written before this existed,
   * so no file needs a migration. It replaces the screen's as a whole rather than merging with it:
   * a page with only a colour shows no image, whatever the screen has.
   */
  background: BackgroundSchema.optional(),
})

/**
 * Height of the dashboard navigation bar, in pixels. The Edge panel is 720 px tall and the bar
 * eats into the widget area: 80 px leaves 16 rows of 40 px, 40 px leaves 17. Absent means 80,
 * the height the bar has always had, so no existing file has to be rewritten.
 */
export const NavHeightSchema = z.union([z.literal(80), z.literal(40)])
export type NavHeight = z.infer<typeof NavHeightSchema>
export const NavStyleSchema = z.enum(['dots', 'names'])

/**
 * A sanity ceiling on the bar's widget count. The real limit is width: the admin refuses a
 * widget whose cells would push a cluster into the page dots, so this only guards the file.
 */
export const MAX_NAV_WIDGETS = 12

/** Which side of the centred dots a bar widget sits on. */
export const NavSlotSchema = z.enum(['left', 'right'])
export type NavSlot = z.infer<typeof NavSlotSchema>

/**
 * One widget drawn inside a screen's navigation bar. It has no geometry — the bar sizes it from
 * the manifest's `compact.width` — and no appearance: the bar is its surface. Its widget and
 * settings are the `widgets` entry it names. `slot` picks the cluster it joins, and its position
 * in the screen's `nav` list orders it within that cluster.
 */
export const NavItemSchema = z.object({
  instanceId: InstanceIdSchema,
  slot: NavSlotSchema.default('left'),
  /**
   * Touching the widget opens a popover showing the same widget in full, as a tile. Absent means
   * no popover, so the touch reaches the compact widget itself, which is the default everywhere.
   */
  popup: z.boolean().optional(),
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

/**
 * The grid and the look of one screen. The theme is not here: it is the same on every screen and
 * lives at the top of the config. Neither is the bar's content, which is the screen's `nav`.
 */
export const ScreenDisplaySchema = z.object({
  cols: z.number().int().min(1).default(64),
  rows: z.number().int().min(1).default(16),
  cell: z.number().int().min(1).default(40),
  autoCycleSeconds: z.number().int().min(0).default(0),
  /** Absent means 80: the default is stored as a missing key, never as a value. */
  navHeight: NavHeightSchema.optional(),
  /** Absent preserves the existing page dots. */
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
   * The orientation a device screen was made for; the device app locks it. Absent on the Edge,
   * which has only one. Changing it is adding a screen, not reflowing this one.
   */
  orientation: z.enum(['landscape', 'portrait']).optional(),
  /**
   * The device's viewport in that orientation, in CSS pixels, as it reported it when it paired.
   * Kept so `rows` can be recomputed when `navHeight` changes; absent on the Edge.
   */
  viewport: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }).optional(),
})

/** `HH:MM`, 24-hour, in the Mac's own time zone. */
export const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/**
 * How a screen's brightness is driven when nobody touches it. Both modes are off by default, and
 * an absent `brightness` is the same as both off: the display keeps whatever level it was left
 * at. The level itself is *not* here — the display remembers it, and a slider drag is not a
 * config write. See `server/src/brightness/`.
 */
export const BrightnessSettingsSchema = z.object({
  /** Two levels, switching at sunrise and sunset (or at fixed times), with a ramp between. */
  dayNight: z.object({
    enabled: z.boolean().default(false),
    day: z.number().int().min(0).max(100).default(80),
    night: z.number().int().min(0).max(100).default(30),
    /** `sun`: computed locally from `latitude`/`longitude`, no network. `fixed`: `dayAt`/`nightAt`. */
    schedule: z.enum(['sun', 'fixed']).default('sun'),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    dayAt: ClockTimeSchema.default('07:00'),
    nightAt: ClockTimeSchema.default('21:00'),
    /** How long the change from one level to the other takes, starting at the transition. */
    rampMinutes: z.number().int().min(0).max(120).default(20),
  }).prefault({}),
  /** The screen follows the Mac's built-in display: `level = builtin% × scale + offset`. */
  followMac: z.object({
    enabled: z.boolean().default(false),
    scale: z.number().min(0.2).max(3).default(1),
    offset: z.number().int().min(-100).max(100).default(0),
  }).prefault({}),
})
export type BrightnessSettings = z.infer<typeof BrightnessSettingsSchema>

/** A theme id: the name of a folder in `themes/` (or in the installed themes). */
export const ThemeIdSchema = z.string().regex(/^[a-z0-9_-]+$/)

/**
 * A second theme for the night. `theme` stays the day's; this names the night's and when the
 * switch happens — at sunrise and sunset computed on this Mac from `latitude`/`longitude`, or at
 * fixed times — read exactly like a screen's brightness day / night (`brightness/schedule.ts`),
 * without the ramp: a theme changes at once. Absent: one theme, day and night.
 */
export const ThemeScheduleSchema = z.object({
  /** An unknown id falls back to the built-in theme, like `theme` does. */
  night: ThemeIdSchema,
  schedule: z.enum(['sun', 'fixed']).default('sun'),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  dayAt: ClockTimeSchema.default('07:00'),
  nightAt: ClockTimeSchema.default('21:00'),
})
export type ThemeSchedule = z.infer<typeof ThemeScheduleSchema>

/** A screen id is a slug: it is stable, it goes in the dashboard's `?screen=` and in device records. */
export const SCREEN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * One display the dashboard is drawn on — the Edge, or a paired device — with its own grid, its
 * own bar and its own pages. The widgets it shows are referenced by instance id from `widgets`,
 * so one widget can sit on several screens and stay one widget.
 */
export const ScreenSchema = z.object({
  id: z.string().regex(SCREEN_ID_RE),
  name: z.string().min(1).max(60),
  kind: z.enum(['edge', 'device']),
  display: ScreenDisplaySchema.prefault({}),
  /** Compact widgets drawn in this screen's navigation bar, in cluster order. */
  nav: z.array(NavItemSchema).max(MAX_NAV_WIDGETS).default([]),
  pages: z.array(PageSchema).min(1),
  /** Automatic brightness for this screen. Absent in every file written before it existed: both modes off. */
  brightness: BrightnessSettingsSchema.optional(),
})

/** A connection id is a slug: it becomes a channel suffix and a secret-key segment. */
export const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * A connection *type* id: a coded type's slug, or a declared one's `decl:<widget>:<slug>`.
 *
 * Two colons and three slugs, spelled out rather than left open: the type id is read back from a
 * config file, used to look a type up and written into log lines, and a pattern that admitted
 * anything would be one more place a hand-edited file could put something surprising.
 */
export const CONNECTION_TYPE_RE = /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*)?$/

export const ConnectionSchema = z.object({
  id: z.string().regex(CONNECTION_ID_RE),
  type: z.string().regex(CONNECTION_TYPE_RE),
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
export const PrivacySchema = z.object({
  /**
   * Read Claude Code's OAuth token from the macOS keychain item `Claude Code-credentials` and
   * ask `api.anthropic.com` for this account's usage, which is what the claude-usage widget's
   * gauges show. The token is never stored, logged or sent anywhere else. The endpoint is
   * undocumented and may disappear.
   */
  claudeAccountUsage: z.boolean().default(false),
  /**
   * Let an account provider (Claude, Codex, …) put the account's e-mail address in what it
   * publishes. Off, the field is never in the snapshot: anything on a channel reaches every
   * widget subscribed to it, a third-party one with network access included, and the Edge sits
   * on a desk. The plan and the sign-in method are published either way. Providers read it with
   * `withAccountEmail()` from `privacy.ts` on every poll.
   */
  showAccountEmail: z.boolean().default(false),
  codexAccount: z.boolean().default(false),
  codexHistorySources: z.array(HistorySourceSchema).max(10).default([]),
  /** Read CPU temperature from the optional local macmon executable. */
  macmonTemperature: z.boolean().default(false),
  /** Read recent Messages for a verification code only after a separate, explicit opt-in. */
  messages2FA: z.boolean().default(false),
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
  /**
   * What was installed, which decides the folder it lives in and the rules it was held to.
   *
   * Absent in every record written before themes could be installed, and read as `'widget'`
   * there — the only thing that existed then. A theme's record carries no permissions and never
   * came from a dialog: there is nothing in validated JSON to consent to.
   */
  kind: z.enum(['widget', 'theme']).default('widget'),
  version: z.string().min(1),
  registry: z.string().min(1).max(64),
  consentedPermissions: z.object({
    subscriptions: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    network: z.array(z.string()).default([]),
    /**
     * The connection declaration the user agreed to, when the widget declares one.
     *
     * Stored loosely on purpose: the config is this machine's own file, and running an old
     * record through a schema that has since grown a rule would refuse a config the user never
     * changed. What *enforces* it — `grantedPermissions` — parses it properly and treats a
     * record it cannot validate as granting no connection at all, so loose storage never
     * becomes a loose grant.
     */
    connection: z.record(z.string(), z.unknown()).optional(),
  }),
  installedAt: z.string().min(1),
  /**
   * Connections of *another* widget's declared type this widget may use.
   *
   * Two widgets that want the same Homey should not mean two forms and two copies of one API
   * key. Accepting "reuse this one?" records the connection's id here rather than copying
   * anything — there is still one credential, in one place, and revoking is deleting one line.
   *
   * It is a grant like any other, which is why it lives on the consent record: the proxy accepts
   * a connection outside the widget's own type only when it is listed here.
   */
  sharedConnections: z.array(z.string().min(1).max(64)).max(32).default([]),
})
export type WidgetConsent = z.infer<typeof ConsentSchema>

export const MarketplaceSchema = z.object({
  /** Keyed by widget id, which is also the folder name under `<dataDir>/widgets`. */
  installed: z.record(z.string().regex(WIDGET_ID_RE), ConsentSchema).default({}),
}).prefault({})
export type MarketplaceState = z.infer<typeof MarketplaceSchema>

/**
 * Features that ship in the code but stay out of the admin until they are ready for everyone.
 *
 * `devices` is pairing an iPad and adding screens: the server side works, but there is nothing to
 * pair until the iPad app is out, so a fresh install keeps the Devices section, the screen
 * selector and "Add a screen" out of sight. It changes what the admin *shows*, nothing the server
 * does: the remote listener stays exactly as `devices.json` says. A config written before this
 * existed is given a value by `adoptLabs` in `migrate.ts`, never this default.
 *
 * `companion` is the Fremkit Companion browser extension and the Fremplay widget it feeds: the
 * extension rows and pairing request in the Devices pane, Fremplay in the widget library and the
 * pairing prompt on the Edge. UI only, like `devices`: the server never reads it, and must not rely
 * on it for security. The companion routes, the socket's challenge and the `companion` channel's
 * refusal to paired devices guard the same way whether it is on or off.
 */
export const LabsSchema = z.object({
  devices: z.boolean().default(false),
  companion: z.boolean().default(false),
}).prefault({})
export type Labs = z.infer<typeof LabsSchema>

/**
 * The version a config file written today carries.
 *
 * v1 → v2 halved the cell and doubled every coordinate. v2 → v3 moved the Homey connection from
 * the coded `homey` type to the one `homey-devices` declares. v3 → v4 split the single dashboard
 * into shared `widgets` and per-display `screens`, and moved the theme to the top; see `migrate.ts`
 * and `v3.ts`.
 */
export const CONFIG_VERSION = 4

export const ConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  /** Id of a theme in `themes/`, the same on every screen. An unknown id falls back to the built-in one. */
  theme: ThemeIdSchema.default(BUILTIN_THEME),
  /** A night theme and when it takes over. Absent in every file written before it existed: one theme. */
  themeSchedule: ThemeScheduleSchema.optional(),
  connections: z.array(ConnectionSchema).default([]),
  secrets: SecretsSchema.prefault({}),
  /** Language of the admin and of the screen. Absent in every file written before it existed. */
  locale: LocaleSchema.default(defaultLocale()),
  privacy: PrivacySchema,
  /** Experimental features the admin shows; see `LabsSchema`. */
  labs: LabsSchema,
  /** Absent in every file written before the marketplace existed, which means nothing installed. */
  marketplace: MarketplaceSchema,
  /** Every widget instance, keyed by instance id, whatever the number of screens showing it. */
  widgets: z.record(InstanceIdSchema, WidgetSchema).default({}),
  screens: z.array(ScreenSchema).min(1),
})

export type Config = z.infer<typeof ConfigSchema>
export type Widget = z.infer<typeof WidgetSchema>
export type Placement = z.infer<typeof PlacementSchema>
export type Page = z.infer<typeof PageSchema>
export type NavItem = z.infer<typeof NavItemSchema>
export type Screen = z.infer<typeof ScreenSchema>
export type ScreenDisplay = z.infer<typeof ScreenDisplaySchema>

export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  theme: BUILTIN_THEME,
  connections: [],
  secrets: { backend: defaultSecretsBackend() },
  locale: defaultLocale(),
  privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false, messages2FA: false },
  labs: { devices: false, companion: false },
  marketplace: { installed: {} },
  widgets: {
    'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
  },
  screens: [
    {
      id: 'edge',
      name: 'Xeneon Edge',
      kind: 'edge',
      display: {
        cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0,
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
      nav: [],
      pages: [
        {
          id: 'home',
          name: tr(defaultLocale(), 'config.defaultPageName'),
          items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }],
        },
      ],
    },
  ],
}

/** What the layout checks need from a widget's manifest. */
export type LayoutManifest = {
  minSize: [number, number]
  compact?: { width: number }
  settingsSchema?: Record<string, { default?: unknown }>
}

function overlaps(a: Placement, b: Placement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * The checks a config must pass beyond its shape, screen by screen. Screen ids are unique, and
 * page ids unique within a screen. Every placement and bar entry names a widget in `widgets`, and
 * a widget appears at most once per screen, its bar and its pages counted together — it may
 * appear on any number of screens. Each page is then checked against its own screen's grid:
 * inside it, at least the widget's minimum size, no overlap. A placement naming a missing widget
 * skips the size check. Screens are named by their `name`, the one the user knows them by.
 * Messages come back in the language the config being checked asks for.
 */
export function validateLayout(config: Config, manifests: Map<string, LayoutManifest>): string[] {
  const errors: string[] = []
  const locale = config.locale
  const screenIds = new Set<string>()
  for (const screen of config.screens) {
    const name = screen.name
    if (screenIds.has(screen.id)) errors.push(tr(locale, 'layout.duplicateScreen', { screen: name, id: screen.id }))
    screenIds.add(screen.id)

    // Pages in order, then the bar: the order `findInstances` reports them in.
    const onScreen = new Set<string>()
    const place = (instanceId: string): void => {
      if (!Object.hasOwn(config.widgets, instanceId)) errors.push(tr(locale, 'layout.missingWidget', { screen: name, instanceId }))
      else if (onScreen.has(instanceId)) errors.push(tr(locale, 'layout.duplicateOnScreen', { screen: name, instanceId }))
      onScreen.add(instanceId)
    }

    const { cols, rows } = screen.display
    const pageIds = new Set<string>()
    for (const page of screen.pages) {
      if (pageIds.has(page.id)) errors.push(tr(locale, 'layout.duplicatePage', { screen: name, page: page.id }))
      pageIds.add(page.id)
      for (const p of page.items) {
        place(p.instanceId)
        if (p.x + p.w > cols || p.y + p.h > rows) {
          errors.push(tr(locale, 'layout.outsideGrid', { screen: name, page: page.id, instanceId: p.instanceId }))
        }
        const widgetId = Object.hasOwn(config.widgets, p.instanceId) ? config.widgets[p.instanceId].widgetId : undefined
        const m = widgetId === undefined ? undefined : manifests.get(widgetId)
        if (m && widgetId !== undefined && (p.w < m.minSize[0] || p.h < m.minSize[1])) {
          errors.push(tr(locale, 'layout.tooSmall', {
            screen: name, page: page.id, instanceId: p.instanceId, w: p.w, h: p.h, minW: m.minSize[0], minH: m.minSize[1], widgetId,
          }))
        }
      }
      for (let i = 0; i < page.items.length; i++) {
        for (let j = i + 1; j < page.items.length; j++) {
          const a = page.items[i], b = page.items[j]
          if (overlaps(a, b)) errors.push(tr(locale, 'layout.overlap', { screen: name, page: page.id, a: a.instanceId, b: b.instanceId }))
        }
      }
    }
    for (const item of screen.nav) place(item.instanceId)
  }
  return errors
}

/**
 * The navigation bar only draws widgets that have a compact rendering, so a bar entry naming a
 * widget the catalog does not know — or one that declares no `compact` — is refused rather than
 * silently dropped. Each screen's bar is checked on its own, and its wider cluster must leave the
 * pages their centre — the dots' `NAV_CENTRE_RESERVE_CELLS`, or the names' width up to
 * `NAV_NAMES_MAX_WIDTH` (`navHasRoom` in `nav.ts`): the admin enforces this while editing one
 * screen, but a setting changed on a widget shared with another screen can widen that screen's
 * bar too, and only the save sees every screen. A bar entry naming a missing widget is left to
 * `validateLayout`. Messages name the screen and come back in the language the config asks for.
 *
 * `previous`, the config being replaced, keeps an already over-full bar from locking every save:
 * a bar can be over the limit before this save (a wide setting switched on earlier, a manifest
 * whose compact width grew), and an unrelated edit must still go through. With it, a screen's
 * bar is refused only when it is over the limit *and* this save widens its wider cluster beyond
 * what the screen with the same id had in `previous`; a screen `previous` does not have is refused as soon
 * as it is over. Without it, any bar over the limit is refused.
 */
export function validateNavWidgets(config: Config, manifests: Map<string, LayoutManifest>, previous?: Config): string[] {
  const errors: string[] = []
  const locale = config.locale
  for (const screen of config.screens) {
    const name = screen.name
    for (const item of screen.nav) {
      const widgetId = Object.hasOwn(config.widgets, item.instanceId) ? config.widgets[item.instanceId].widgetId : undefined
      if (widgetId === undefined) continue
      const m = manifests.get(widgetId)
      if (!m) errors.push(tr(locale, 'navWidgets.unknownWidget', { screen: name, widgetId }))
      else if (!m.compact) errors.push(tr(locale, 'navWidgets.notCompact', { screen: name, widgetId }))
    }
    if (navHasRoom(screen, config.widgets, manifests)) continue
    const used = navWiderClusterWidth(screen, config.widgets, manifests)
    const before = previous?.screens.find((s) => s.id === screen.id)
    const grew = before === undefined || used > navWiderClusterWidth(before, previous!.widgets, manifests)
    if (grew) {
      errors.push(tr(locale, 'navWidgets.noRoom', { screen: name, used: Math.ceil(used), room: Math.floor(navSideRoom(screen)) }))
    }
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
