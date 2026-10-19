import type { Locale } from './i18n'

/**
 * Mirrors the server schema: how much of the tile the accent paints. `none` leaves it to the
 * widget's own bars and highlights, `frame` colours the title bar and the border, `fill` colours
 * the whole tile. Absent means `none`.
 */
export type AccentMode = 'none' | 'frame' | 'fill'
export type BackgroundFit = 'cover' | 'contain'
/** Mirrors the server schema; `dim` is the black overlay opacity laid over the image. */
export interface WidgetBackground { image: string; fit?: BackgroundFit; dim?: number }
/**
 * Mirrors the server schema: what a widget instance *is*, shared by every screen that shows it.
 * Stored in `Config.widgets` under its instance id; where it sits is a `Placement` or a `NavItem`.
 */
export interface Widget {
  widgetId: string
  title?: string; showTitle: boolean
  /** Colour of the tile's surface: `#rrggbb`, absent means the theme surface. */
  bgColor?: string
  /** Mirrors the server schema: `#rrggbb`, absent unless the user picked one. */
  accentColor?: string
  /** How much of the tile the accent paints; absent means 'none'. */
  accentMode?: AccentMode
  /** Absent means the tile keeps its plain surface. */
  background?: WidgetBackground
  /** Opacity of the tile's surface, 0–1; absent means solid. 0 makes it fully see-through. */
  opacity?: number
  settings: Record<string, unknown>
}
/** Mirrors the server schema: where one widget sits on one page of one screen, in cells. */
export interface Placement {
  instanceId: string; x: number; y: number; w: number; h: number
  /** The editor neither drags nor resizes a locked tile. Absent means unlocked. */
  locked?: boolean
}
/**
 * A widget joined with one of its placements: what a frame draws and what the bridge hands the
 * widget. Never stored — built by `tileOf` (or `compactOf` for the bar) from the config.
 */
export type WidgetInstance = Widget & Placement
/**
 * Mirrors the server schema. `background`, when present, is shown instead of the screen's while
 * this page is on screen; absent, the page shows the screen's.
 */
export interface Page { id: string; name: string; items: Placement[]; background?: Background }
/** Mirrors the server schema: which side of the centred dots a bar widget sits on. */
export type NavSlot = 'left' | 'right'
/** The two clusters, in the order the Screen tab offers them. */
export const NAV_SLOTS: NavSlot[] = ['left', 'right']

/**
 * Mirrors the server schema: one widget drawn inside a screen's navigation bar. No geometry — the
 * bar sizes it from the manifest's `compact.width` — and no appearance, since the bar is its
 * surface. Its widget and settings are the `Config.widgets` entry it names. `slot` picks its
 * cluster; its position in the screen's `nav` orders it within that cluster.
 */
export interface NavItem {
  instanceId: string; slot: NavSlot
  /** Touching it opens a popover with the same widget in full; absent means the touch reaches the widget. */
  popup?: boolean
}
/** Mirrors the server schema; absent means the plain theme background. */
export interface Background { color?: string; image?: string; fit?: BackgroundFit }
/** Mirrors the server schema: the two heights the navigation bar may take. */
export type NavHeight = 80 | 40
export type NavStyle = 'dots' | 'names'
export const DEFAULT_NAV_STYLE: NavStyle = 'dots'
/**
 * Mirrors the server schema: the grid and the look of one screen. The theme is the config's,
 * the same on every screen, and the bar's content is the screen's `nav`.
 */
export interface ScreenDisplay {
  cols: number; rows: number; cell: number; autoCycleSeconds: number
  /** Absent means `DEFAULT_NAV_HEIGHT`; the default is stored as a missing key. */
  navHeight?: NavHeight
  /** Absent keeps the existing dot navigation. */
  navStyle?: NavStyle
  /** Opacity of the navigation bar's background, 0–1; absent means solid. */
  navOpacity?: number
  /** The opacity a tile gets when it is added; absent means solid. */
  tileOpacity?: number
  /** Absent means `both`; see `AdminGesture`. */
  adminGesture?: AdminGesture
  background?: Background
  /** The orientation a device screen was made for; absent on the Edge. */
  orientation?: 'landscape' | 'portrait'
  /** The device's viewport in that orientation, in CSS px, as it reported it; absent on the Edge. */
  viewport?: { width: number; height: number }
}
/** The pre-screens name of `ScreenDisplay`, kept so the components reading it need not change. */
export type Display = ScreenDisplay
/**
 * Mirrors the server schema: one display the dashboard is drawn on — the Edge or a paired device —
 * with its own grid, bar and pages. Widgets are referenced by instance id from `Config.widgets`.
 */
export interface Screen {
  /** A slug: stable, used in `?screen=` and in device records. */
  id: string
  name: string
  kind: 'edge' | 'device'
  display: ScreenDisplay
  /** Compact widgets drawn in this screen's bar, in cluster order. */
  nav: NavItem[]
  pages: Page[]
  /** Automatic brightness for this screen; absent means both modes off. */
  brightness?: BrightnessSettings
}
/** Mirrors `BrightnessSettingsSchema`: how a screen's brightness is driven when nobody touches it. */
export interface BrightnessSettings {
  dayNight: {
    enabled: boolean
    day: number
    night: number
    schedule: 'sun' | 'fixed'
    latitude?: number
    longitude?: number
    /** `HH:MM`, the Mac's time zone. */
    dayAt: string
    nightAt: string
    rampMinutes: number
  }
  followMac: { enabled: boolean; scale: number; offset: number }
}
export interface Connection { id: string; type: string; name: string; fields: Record<string, string> }
export type SecretsBackend = 'keychain' | 'file'

/**
 * What Fremkit is allowed to read on this Mac beyond its own files. Everything is off until the
 * user ticks it in the admin's Screen panel, which is the only place it is turned on.
 */
export interface Privacy {
  /**
   * Read Claude Code's OAuth token from the keychain and ask api.anthropic.com for this account's
   * usage — the gauges of the claude-usage widget.
   */
  claudeAccountUsage: boolean
  /**
   * Let account providers publish the account's e-mail address. Off, the server leaves it out
   * of every snapshot, so no widget and no screen ever sees it.
   */
  showAccountEmail: boolean
  codexAccount: boolean
  codexHistorySources: ('cli' | 'vscode' | 'exec' | 'appServer' | 'subAgent' | 'subAgentReview' | 'subAgentCompact' | 'subAgentThreadSpawn' | 'subAgentOther' | 'unknown')[]
  /** Use the optional local macmon executable for Apple Silicon CPU temperature. */
  macmonTemperature: boolean
  /** Permit an explicit local request to read a recent Messages verification code. */
  messages2FA?: boolean
}

/**
 * Features shipped but kept out of the admin until they are ready. `devices` is iPad pairing and
 * adding screens; the server infers it for a config written before it existed.
 */
export interface Labs {
  devices: boolean
  /** The browser companion and Fremplay; absent in a config the admin built itself, meaning off. */
  companion?: boolean
}

export interface Config {
  version: 4
  /** Id of a theme in `themes/`, the same on every screen; an unknown id paints the built-in one. */
  theme?: string
  /** A night theme and when it takes over; absent means one theme, day and night. A paired device gets only `night`. */
  themeSchedule?: ThemeSchedule
  connections: Connection[]
  secrets: { backend: SecretsBackend }
  locale?: Locale
  privacy: Privacy
  /** Absent in a config the server has not answered with yet, which reads as all off. */
  labs?: Labs
  /** Every widget instance, keyed by instance id, however many screens show it. */
  widgets: Record<string, Widget>
  /** At least one; the first `edge` one is what the Edge shows. */
  screens: Screen[]
}

/** A manifest text: one string, or a `{ fr, en }` pair. Resolved with `pick()` at render time. */
export type LocalizedText = string | Record<string, string>

/** One choice of an `enum` setting: a bare string is its own value, the object form separates them. */
export type SettingOption = string | { value: string; label: LocalizedText }

export const optionValue = (option: SettingOption): string => (typeof option === 'string' ? option : option.value)
export const optionLabel = (option: SettingOption): LocalizedText => (typeof option === 'string' ? option : option.label)

/**
 * Mirrors the server: the types one item of a `list` setting may be made of. No nested list, and
 * nothing that needs the admin's own data, so a row stays one compact inline line.
 */
export interface ListItemField {
  type: 'string' | 'boolean' | 'enum' | 'number' | 'timezone'
  label: LocalizedText
  default?: unknown
  options?: SettingOption[]
  /**
   * `string` fields only: where the admin reads the suggestions it offers while typing.
   * `apps` lists the applications installed on this machine. A suggestion is only that — any
   * value stays typeable.
   */
  suggest?: 'apps'
  /**
   * Narrows `suggest` to the rows where a sibling field of the same item holds a given value —
   * `{ kind: 'app' }` offers the applications only while the row's kind is "app".
   */
  suggestWhen?: Record<string, string>
}

/**
 * True when a list item field's suggestions apply to this row.
 *
 * A field with no `suggest` never suggests; a `suggestWhen` narrows it to the rows whose sibling
 * fields hold the named values, so the shortcuts widget offers applications only on "app" rows.
 */
export function suggestApplies(field: ListItemField, item: Record<string, unknown>): boolean {
  if (!field.suggest) return false
  return Object.entries(field.suggestWhen ?? {}).every(([key, value]) => String(item[key] ?? '') === value)
}

/** One installed application, as `GET /api/apps/installed` returns it. */
export interface InstalledAppInfo {
  name: string
  bundleId: string
  /** The bundle's file name without `.app`, present only when it differs from `name`. */
  file?: string
}

/**
 * Which rendering of the widget a setting belongs to: the tile drawn on a page, or the compact
 * one drawn in the navigation bar. Absent means both, which is how every setting behaved before
 * this existed.
 */
export type SettingScope = 'tile' | 'compact'

export interface SettingField {
  type: 'boolean' | 'string' | 'number' | 'enum' | 'color' | 'connection' | 'connections' | 'apps' | 'timezone' | 'list' | 'pick'
  label: LocalizedText
  /** Which rendering the setting configures; absent means both. */
  scope?: SettingScope
  default?: unknown
  options?: SettingOption[]
  /** `enum` only: a provider command the admin sends with the chosen value, as a preview. */
  preview?: { channel: string; command: string }
  /**
   * For `connection` and `connections` fields: which connection type the admin offers.
   * `connection` stores one id, `connections` an array of them.
   */
  connectionType?: string
  /**
   * For `pick` fields: the key of the sibling `connection` setting the choices are read from,
   * and which list of that connection to offer.
   */
  connection?: string
  source?: string
  /** For `list` fields: the fields one item is made of. */
  itemSchema?: Record<string, ListItemField>
  /** For `list` fields: how many items may be added. Absent means no ceiling. */
  max?: number
}

/**
 * One choice a `pick` setting offers, as `GET /api/connections/:id/options` returns it. `value` is
 * what the widget stores, `group` heads a section of the list and `hint` is a discreet second line.
 */
export interface PickOption { value: string; label: string; group?: string; hint?: string }

/** A connection type as `GET /api/connections/types` describes it. */
export interface ConnectionFieldSpec {
  key: string; label: string
  secret?: boolean; required?: boolean
  placeholder?: string; help?: string; options?: string[]
  /** A `#rrggbb` colour: rendered as a swatch, and shown wherever the connection is offered. */
  color?: boolean
}

/**
 * The colours a new connection's `color` field is seeded from, taken in turn so two calendars
 * created one after the other never start out the same. The user can still pick anything.
 */
export const CONNECTION_COLORS = ['#5b8def', '#e8833a', '#3fa66b', '#c05bd6', '#d94f6a', '#2fb3b3']
export const nextConnectionColor = (taken: number): string =>
  CONNECTION_COLORS[Math.abs(taken) % CONNECTION_COLORS.length]
export interface ConnectionTypeInfo {
  id: string; name: string; description: string; icon: string; fields: ConnectionFieldSpec[]
  /**
   * The widget that declared this type, when a widget did. Absent on a type the core has code
   * for. The admin says so on the form: an API key field should name what asked for it.
   */
  declaredBy?: string
  /**
   * The plain field keys a stored secret is tied to — the ones that decide where it is sent. The
   * server refuses a save that changes one of them while keeping the stored secret, so the form
   * asks for the secret again as soon as one is edited.
   */
  secretBindings?: string[]
}

/** A connection as `GET /api/connections` returns it: secret values replaced by a boolean. */
export interface ConnectionSummary extends Connection {
  secrets: Record<string, boolean>
  /**
   * Widget ids that were granted the use of this connection although it belongs to another
   * widget's declared type. Absent on an older server; empty on almost every connection.
   */
  sharedWith?: string[]
}

/**
 * Whether a widget may touch a channel. A manifest entry is either a literal channel name or a
 * prefix ending in `:*`, which covers every per-connection channel of that type
 * (`azure-devops:*` covers `azure-devops:ado-x1z9`). Widgets build the channel from their
 * `connection` setting, so the exact id is unknown when the manifest is written.
 */
export function channelAllowed(allowed: string[], channel: string): boolean {
  for (const entry of allowed) {
    if (entry === channel) return true
    if (entry.endsWith(':*') && channel.startsWith(entry.slice(0, -1))) return true
  }
  return false
}
/** Mirrors the server schema: the widget has a compact rendering `width` grid cells wide. */
export interface Compact { width: number }

export interface WidgetManifest {
  /** Which shelf of the library it sits on; absent in a manifest written before categories. */
  category?: string
  id: string; name: LocalizedText; version: string; description: LocalizedText; icon: string
  /** The SDK generation the widget needs; 1 for everything written before the marketplace. */
  sdk: number
  /** Shown beside the widget and never executed: a link, a name, an SPDX identifier. */
  homepage?: string; author?: string; license?: string
  minSize: [number, number]; defaultSize: [number, number]
  /** Absent when the widget is only ever drawn as a tile, never in the navigation bar. */
  compact?: Compact
  subscriptions: string[]; commands: string[]
  settingsSchema: Record<string, SettingField>
  permissions: { network: string[] }
  /** A picture of the widget, a path inside its folder (`/widgets/<id>/<preview>`). */
  preview?: string
}

/**
 * Which gesture on the page dots opens the admin.
 *
 * The Edge has no keyboard and no window chrome, so this is the only way in from the screen. The
 * touch driver turns a held press into a right click and a double tap into a double click, and
 * the two are independent — hence the choice, and hence `both` as the default.
 */
export type AdminGesture = 'longPress' | 'doubleTap' | 'both'
export const ADMIN_GESTURES: AdminGesture[] = ['both', 'longPress', 'doubleTap']
export const DEFAULT_ADMIN_GESTURE: AdminGesture = 'both'

/** The height of the nav bar when `display.navHeight` says nothing, which is the usual case. */
export const DEFAULT_NAV_HEIGHT: NavHeight = 80
/** The two heights offered, tallest first, as the Screen tab lists them. */
export const NAV_HEIGHTS: NavHeight[] = [80, 40]
/**
 * How many rows of widgets each nav height leaves. The Edge panel is 720 px tall and its cells
 * are 40 px, so the bar and the board always add up to the same screen.
 */
export const ROWS_BY_NAV_HEIGHT: Record<NavHeight, number> = { 80: 16, 40: 17 }
/** The nav bar height a display actually renders at. */
export const navHeightOf = (display: Display): NavHeight => display.navHeight ?? DEFAULT_NAV_HEIGHT
/** One screen's bar items, in their configured order. */
export const navItemsOf = (screen: Screen): NavItem[] => screen.nav
/** One screen's bar items of one cluster, in their configured order. */
export const navItemsIn = (screen: Screen, slot: NavSlot): NavItem[] =>
  navItemsOf(screen).filter((item) => item.slot === slot)

/** A sanity ceiling on a screen's bar widget count; mirrors the server's `MAX_NAV_WIDGETS`. */
export const MAX_NAV_WIDGETS = 12
/** Minimum width retained for dot navigation. */
export const NAV_CENTRE_RESERVE_CELLS = 10
/**
 * The two settings that make a compact widget need more room than its manifest asks for, and
 * the width it then gets. A widget cannot resize its own iframe, so the rule lives on the host
 * side — here, in one place, rather than spread over the nav bar and the admin.
 */
export const WIDE_COMPACT_SETTINGS = ['compactDate', 'compactCities'] as const
export const WIDE_COMPACT_WIDTH = 8

/**
 * How many cells the navigation bar allots one compact widget: what its manifest declares,
 * widened when the instance turns on a setting that needs the extra room. 0 when the widget has
 * no compact rendering at all, which is the caller's cue not to draw it.
 */
export function compactWidth(manifest: WidgetManifest | undefined, settings: Record<string, unknown> = {}): number {
  const base = manifest?.compact?.width ?? 0
  if (!base) return 0
  const wide = WIDE_COMPACT_SETTINGS.some((key) => settings[key] === true)
  return wide ? Math.max(base, WIDE_COMPACT_WIDTH) : base
}

/**
 * The cells one screen's bar takes, each widget at the width its settings — merged over its
 * manifest's defaults — give it. An item naming a missing widget counts 0. Mirrors
 * `navCellsUsed` in `server/src/config/nav.ts`, which applies the same rule at save.
 */
export function navCellsUsed(screen: Screen, widgets: Config['widgets'], manifests: Record<string, WidgetManifest>): number {
  return navItemsOf(screen).reduce((sum, item) => {
    const widget = widgets[item.instanceId]
    if (!widget) return sum
    const manifest = manifests[widget.widgetId]
    return sum + compactWidth(manifest, mergeSettings(manifest, widget.settings))
  }, 0)
}

/**
 * The bar centres its pages between two equally wide side tracks, each as wide as the wider
 * cluster. Budget against that side, gaps and padding included, or a full cluster disappears
 * behind the centre. `width` cells are counted as one more widget in `slot`. Mirrors
 * `navWiderClusterWidth` in `server/src/config/nav.ts`.
 */
export function navWiderClusterWidth(
  screen: Screen,
  widgets: Config['widgets'],
  manifests: Record<string, WidgetManifest>,
  width = 0,
  slot: NavSlot = 'left',
): number {
  const display = screen.display
  const scale = navHeightOf(display) / DEFAULT_NAV_HEIGHT
  const clusterWidth = (side: NavSlot): number => {
    const items = navItemsIn(screen, side)
    const content = items.reduce((sum, item) => {
      const widget = widgets[item.instanceId]
      if (!widget) return sum
      const manifest = manifests[widget.widgetId]
      return sum + compactWidth(manifest, mergeSettings(manifest, widget.settings)) * display.cell
    }, 0)
    const count = items.length + (side === slot && width > 0 ? 1 : 0)
    return content + (side === slot ? width * display.cell : 0)
      + Math.max(0, count - 1) * 12 * scale + 24 * scale
  }
  return Math.max(clusterWidth('left'), clusterWidth('right'))
}

/** The widest the named-page centre grows, at the default bar height: NavBar.vue's centre track cap. */
export const NAV_NAMES_MAX_WIDTH = 1200

/** The width one screen's bar keeps for its pages: the dots' cells, or the names up to their cap. */
export function navCentreWidth(screen: Screen): number {
  const display = screen.display
  if (display.navStyle !== 'names') return NAV_CENTRE_RESERVE_CELLS * display.cell
  // Names take their natural width up to the centre track's cap in NavBar.vue (1200 px, scaled).
  // Reserving less lets a side cluster eat into that track, and the names drift off centre.
  const names = Math.max(screen.pages.length, 1)
  return Math.min(names * 120 + (names - 1) * 8, NAV_NAMES_MAX_WIDTH) * navHeightOf(display) / DEFAULT_NAV_HEIGHT
}

/**
 * Whether one more compact widget of `width` cells in `slot` still leaves that screen's pages
 * their centre. Mirrors `navHasRoom` in `server/src/config/nav.ts`, which applies it at save.
 */
export function navHasRoom(
  screen: Screen,
  widgets: Config['widgets'],
  manifests: Record<string, WidgetManifest>,
  width: number,
  slot: NavSlot = 'left',
): boolean {
  return 2 * navWiderClusterWidth(screen, widgets, manifests, width, slot) + navCentreWidth(screen)
    <= screen.display.cols * screen.display.cell
}

/**
 * The settings one editor may show: those the manifest scopes to that rendering, plus every
 * setting that scopes itself to neither. Insertion order is the manifest's, so the form keeps
 * the order the widget author wrote.
 */
export function fieldsInScope(
  schema: Record<string, SettingField> | undefined,
  scope: SettingScope | undefined,
): Record<string, SettingField> {
  const out: Record<string, SettingField> = {}
  for (const [key, field] of Object.entries(schema ?? {})) {
    if (scope === undefined || field.scope === undefined || field.scope === scope) out[key] = field
  }
  return out
}

/**
 * Where a widget came from: shipped with Fremkit, installed from the marketplace, or the folder
 * a widget author works in (only under `FREMKIT_WIDGET_DEV=1`).
 */
export type WidgetSource = 'builtin' | 'installed' | 'dev'

/** The three lists a widget asks for, as the registry index and a consent record spell them. */
/**
 * One field of a connection a widget declares. The shape the server's `ConnectionDeclSchema`
 * produces, narrowed to what the admin renders.
 */
export interface ConnectionDeclField {
  key: string
  label: LocalizedText
  help?: LocalizedText
  placeholder?: LocalizedText
  secret?: boolean
  required?: boolean
}

/** A request a declared connection may make, as the dialog lists it. */
export interface ConnectionDeclRequest { method: string; path: string; cacheMs?: number }

/**
 * A connection a widget declares for itself, as the admin receives it.
 *
 * Mirrors `ConnectionDeclSchema` on the server. It arrives inside a permission set rather than
 * beside one because that is what it is: agreeing to it is agreeing that the server will hold a
 * credential for this service and make exactly these requests with it.
 */
export interface ConnectionDecl {
  name: LocalizedText
  kind: 'host' | 'http-bearer' | 'http-basic' | 'api-key-header' | 'api-key-query'
  fields: ConnectionDeclField[]
  headerName?: string
  queryName?: string
  scheme: 'https' | 'http'
  test?: { method: 'GET'; path: string; expect: number }
  requests: ConnectionDeclRequest[]
  hint?: LocalizedText
}

export interface WidgetPermissionSet {
  subscriptions: string[]
  commands: string[]
  network: string[]
  /** Present only when the widget declares a connection; see `ConnectionDecl`. */
  connection?: ConnectionDecl
}

/**
 * One row of the marketplace: what the registry published, plus what this machine makes of it.
 *
 * The permissions here are what the entry *advertises*. The install re-reads them from the
 * manifest inside the downloaded package, which is the one that was hashed — so the dialog shows
 * the shop window and the server consents against the goods.
 */
export interface MarketplaceWidget {
  id: string
  /**
   * What the row is. Absent today — the server lists widgets only — and read as `widget` then.
   *
   * It is here so that the modal's kind filter is already the code themes will use, rather than
   * a second list and a branch around it once the index's `themes` become installable.
   */
  kind?: 'widget' | 'theme'
  version: string
  sdk: number
  name: LocalizedText
  description: LocalizedText
  icon: string
  /**
   * The shelf the Available view puts it on, one of `WIDGET_CATEGORIES`. The server resolves an
   * absent or unknown one to `other`, so unlike a manifest's this is always there.
   */
  category: string
  author?: string
  license?: string
  homepage?: string
  permissions: WidgetPermissionSet
  /** Connection types the widget's settings need: "needs a Synology connection". */
  connections: string[]
  size: number
  publishedAt: string
  installed: boolean
  installedVersion: string | null
  updateAvailable: boolean
  /** The widget needs a newer Fremkit than this one. */
  sdkTooNew: boolean
  consentNeeded: boolean
  newPermissions: WidgetPermissionSet
  /** A built-in already owns this id, so it can never be installed. */
  shadowsBuiltin: boolean
  /**
   * The registry's URL of the widget's preview image, when it publishes one. Never loaded as is:
   * the admin shows `/api/marketplace/preview/<id>`, which the server fetches and checks.
   */
  preview?: string
  /**
   * What this version changed, as plain text from the package's changelog.
   *
   * **Rendered as text, never as markup.** The registry strips the markdown, but this is a
   * string that came over the network from a file somebody wrote in a pull request.
   */
  changes?: string
  /** What each version documented, newest first, this one included. Empty when none did. */
  history: { version: string; changes: string }[]
  /**
   * Where an instance of this widget sits: a page's name or the bar, prefixed with the screen's
   * name when there is more than one screen. Empty for almost every row.
   *
   * Non-empty on a widget that is *not* installed means a tile somewhere paints as missing —
   * which is the whole upgrade path for a dashboard built before a widget moved to the registry.
   */
  placedOn: string[]
}

/**
 * One theme of the registry, and what this machine makes of it.
 *
 * No permissions, no SDK and no consent: a theme is validated JSON that runs nothing. What it
 * carries instead is `tokens` — the four the card paints as a swatch strip, so a theme needs no
 * preview image and a card needs no second request.
 */
export interface MarketplaceTheme {
  id: string
  version: string
  name: LocalizedText
  description: LocalizedText
  author?: string
  license?: string
  homepage?: string
  tokens: { accent: string; bg: string; surface: string; text: string }
  size: number
  publishedAt: string
  installed: boolean
  installedVersion: string | null
  updateAvailable: boolean
  /** A built-in already owns this id, so it can never be installed. */
  shadowsBuiltin: boolean
  /** The screen is painted with it; removing it is refused until another is chosen. */
  inUse: boolean
  changes?: string
  history: { version: string; changes: string }[]
}

export interface MarketplaceResponse {
  registry: string | null
  generatedAt: string | null
  widgets: MarketplaceWidget[]
  themes: MarketplaceTheme[]
  /** The index could not be read; `widgets` is the last one seen, or empty. */
  offline: boolean
  sdk: number
}

export interface WidgetsResponse {
  /** Narrowed to what was granted; this is what the bridge enforces and the dashboard reads. */
  widgets: Record<string, WidgetManifest>; errors: { id: string; error: string }[]
  /** One entry per widget in `widgets`; a fact about the folder, not a claim of the manifest. */
  sources: Record<string, WidgetSource>
  /**
   * What each manifest *asks* for, un-narrowed. Admin only: "asks for X, granted Y" is the one
   * way to tell a widget quietly missing a permission from one that never wanted it.
   */
  asks: Record<string, WidgetPermissionSet>
  /** The SDK generation this server speaks; a manifest asking for more needs a newer Fremkit. */
  sdk: number
}

/** A theme as the server serves it: its manifest, plus the custom properties it resolves to. */
export interface ThemeInfo {
  id: string
  name: LocalizedText
  version: string
  description?: LocalizedText
  tokens: Record<string, string | number>
  variables: Record<string, string>
}
/** Mirrors `ThemeScheduleSchema`: `theme` is the day's, `night` the night's. */
export interface ThemeSchedule {
  night: string
  schedule: 'sun' | 'fixed'
  latitude?: number
  longitude?: number
  dayAt: string
  nightAt: string
}
/** Mirrors `ThemeInForce` in `server/src/themes/schedule.ts`: what the `theme` channel publishes. */
export interface ThemeInForce {
  id: string
  phase: 'day' | 'night'
  scheduled: boolean
  next?: { at: string; to: 'day' | 'night' }
  problem?: 'no-location'
}
export interface ThemesResponse {
  themes: Record<string, ThemeInfo>
  errors: { id: string; error: string }[]
  /** The theme in force when the catalog was read, for a first paint that is already right. */
  inForce?: ThemeInForce
}
export interface WidgetSize { w: number; h: number; px: { width: number; height: number } }

export function mergeSettings(manifest: WidgetManifest | undefined, settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(manifest?.settingsSchema ?? {})) out[k] = f.default
  return { ...out, ...settings }
}

// ---------------------------------------------------------------------------------------------
// Shared layouts: mirrors server/src/share/. The server builds and reads the file; the admin
// shows what is in it and applies it through its store.

export type LayoutScope = 'page' | 'screen' | 'setup'
export type SharedSource = 'builtin' | 'sietch' | 'local'
export interface SharedBackground { color?: string; image?: string; fit?: BackgroundFit }
export interface SharedWidget {
  widgetId: string; title?: string; showTitle: boolean
  bgColor?: string; accentColor?: string; accentMode?: AccentMode
  background?: { image: string; fit?: BackgroundFit; dim?: number }
  opacity?: number
  settings: Record<string, unknown>
}
export interface SharedPlacement { widget: string; x: number; y: number; w: number; h: number; locked?: boolean }
export interface SharedPage { name: string; items: SharedPlacement[]; background?: SharedBackground }
export interface SharedNavItem { widget: string; slot: NavSlot; popup?: boolean }
export type SharedDisplay = Omit<ScreenDisplay, 'background'> & { background?: SharedBackground }
export interface SharedScreen { name: string; kind: 'edge' | 'device'; display: SharedDisplay; nav: SharedNavItem[]; pages: SharedPage[] }
export interface LayoutFile {
  format: 'fremkit-layout'
  version: number
  fremkit?: string
  scope: LayoutScope
  theme?: { day: string; night?: string }
  widgets: Record<string, SharedWidget>
  catalog: Record<string, { version: string; source: SharedSource }>
  screens: SharedScreen[]
  /** In a preview, an embedded image is its size; in a file, its bytes as base64. */
  images: Record<string, { shipped: true } | { data: string } | { bytes: number }>
}

export type LeftOutReason = 'connection' | 'personal' | 'unknown' | 'invalid'
export interface ExportReport {
  scope: LayoutScope
  name: string | null
  screens: number; pages: number; tiles: number
  widgets: { widgetId: string; name: LocalizedText; version: string; source: SharedSource; count: number }[]
  theme: { day: string; night?: string } | null
  images: { embedded: { key: string; bytes: number }[]; leftOut: { reason: 'missing' | 'tooLarge' | 'budget'; bytes?: number }[] }
  removed: { instanceId: string; widget: string; key: string; label: LocalizedText; reason: LeftOutReason }[]
  optional: { id: string; instanceId: string; widget: string; key: string; label: LocalizedText; preview: string; included: boolean }[]
  renamed: { kind: 'page' | 'screen' | 'title'; to: string | null }[]
}
export interface ExportPreview { file: LayoutFile; filename: string; report: ExportReport }

export type ImportWidgetStatus = WidgetSource | 'missing'
export interface ImportReport {
  scope: LayoutScope
  fremkit: string | null
  name: string | null
  screens: number; pages: number; tiles: number
  widgets: { widgetId: string; version: string; source: SharedSource; status: ImportWidgetStatus; localVersion: string | null; count: number }[]
  theme: { day: string; night?: string } | null
  images: { key: string; bytes: number; shipped: boolean }[]
  connections: { widget: string; widgetId: string; setting: string; label: LocalizedText; connectionType: string; multiple: boolean }[]
  dropped: { settings: number; placements: number; images: number }
}
export interface ImportPreview { layout: LayoutFile; report: ImportReport; shippedBackground: string }
