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
export interface WidgetInstance {
  instanceId: string; widgetId: string
  x: number; y: number; w: number; h: number
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
export interface Page { id: string; name: string; widgets: WidgetInstance[] }
/** Mirrors the server schema: which side of the centred dots a bar widget sits on. */
export type NavSlot = 'left' | 'right'
/** The two clusters, in the order the Screen tab offers them. */
export const NAV_SLOTS: NavSlot[] = ['left', 'right']

/**
 * Mirrors the server schema: one widget drawn inside the navigation bar. No geometry — the bar
 * sizes it from the manifest's `compact.width` — and no appearance, since the bar is its surface.
 * `slot` picks its cluster; its position in the list orders it within that cluster.
 */
export interface NavWidget {
  instanceId: string; widgetId: string; slot: NavSlot
  /** Touching it opens a popover with the same widget in full; absent means the touch reaches the widget. */
  popup?: boolean
  settings: Record<string, unknown>
}
/** Mirrors the server schema; absent means the plain theme background. */
export interface Background { color?: string; image?: string; fit?: BackgroundFit }
/** Mirrors the server schema: the two heights the navigation bar may take. */
export type NavHeight = 80 | 40
export interface Display {
  cols: number; rows: number; cell: number; autoCycleSeconds: number
  /** Id of a theme in `themes/`; an unknown id paints the built-in one. */
  theme?: string
  /** Absent means `DEFAULT_NAV_HEIGHT`; the default is stored as a missing key. */
  navHeight?: NavHeight
  /** Opacity of the navigation bar's background, 0–1; absent means solid. */
  navOpacity?: number
  /** The opacity a tile gets when it is added; absent means solid. */
  tileOpacity?: number
  /** Absent means `both`; see `AdminGesture`. */
  adminGesture?: AdminGesture
  /** Compact widgets drawn in the navigation bar; absent when the bar carries none. */
  navWidgets?: NavWidget[]
  background?: Background
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
}

export interface Config {
  version: 2; display: Display; connections: Connection[]
  secrets: { backend: SecretsBackend }
  locale?: Locale
  privacy: Privacy
  pages: Page[]
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
   * The plain field keys a stored secret is tied to — the ones that decide where it is sent. The
   * server refuses a save that changes one of them while keeping the stored secret, so the form
   * asks for the secret again as soon as one is edited.
   */
  secretBindings?: string[]
}

/** A connection as `GET /api/connections` returns it: secret values replaced by a boolean. */
export interface ConnectionSummary extends Connection { secrets: Record<string, boolean> }

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
/** The bar's widgets, with the absent-means-none default applied once, here. */
export const navWidgetsOf = (display: Display): NavWidget[] => display.navWidgets ?? []
/** The bar's widgets of one cluster, in their configured order. */
export const navWidgetsIn = (display: Display, slot: NavSlot): NavWidget[] =>
  navWidgetsOf(display).filter((w) => w.slot === slot)

/** A sanity ceiling on the bar's widget count; mirrors the server's `MAX_NAV_WIDGETS`. */
export const MAX_NAV_WIDGETS = 12
/** Cells kept free in the middle of the bar for the page dots, whatever the clusters hold. */
export const NAV_DOTS_RESERVE_CELLS = 10
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

/** The cells the bar's widgets take between them, each at the width its settings give it. */
export function navCellsUsed(display: Display, manifests: Record<string, WidgetManifest>): number {
  return navWidgetsOf(display).reduce((sum, w) => sum + compactWidth(manifests[w.widgetId], mergeSettings(manifests[w.widgetId], w.settings)), 0)
}

/** Whether one more compact widget of that width still leaves the dots their room. */
export function navHasRoom(display: Display, manifests: Record<string, WidgetManifest>, width: number): boolean {
  return navCellsUsed(display, manifests) + width <= display.cols - NAV_DOTS_RESERVE_CELLS
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

/** Where a widget came from: shipped with Fremkit, or installed from the marketplace. */
export type WidgetSource = 'builtin' | 'installed'

/** The three lists a widget asks for, as the registry index and a consent record spell them. */
export interface WidgetPermissionSet { subscriptions: string[]; commands: string[]; network: string[] }

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
   * The pages an instance of this widget sits on, by name. Empty for almost every row.
   *
   * Non-empty on a widget that is *not* installed means a tile somewhere paints as missing —
   * which is the whole upgrade path for a dashboard built before a widget moved to the registry.
   */
  placedOn: string[]
}

export interface MarketplaceResponse {
  registry: string | null
  generatedAt: string | null
  widgets: MarketplaceWidget[]
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
export interface ThemesResponse { themes: Record<string, ThemeInfo>; errors: { id: string; error: string }[] }
export interface WidgetSize { w: number; h: number; px: { width: number; height: number } }

export function mergeSettings(manifest: WidgetManifest | undefined, settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(manifest?.settingsSchema ?? {})) out[k] = f.default
  return { ...out, ...settings }
}
