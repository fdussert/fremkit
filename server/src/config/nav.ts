import type { Config, LayoutManifest, Screen } from './schema.js'

/**
 * The navigation bar's width rule, on the server: how many cells each compact widget takes and
 * how many a screen's bar may hold. The admin applies the same rule as the user edits; the server
 * applies it again at save, where a setting changed on a widget shared by several screens can
 * overflow the bar of a screen the admin is not showing.
 */

/** Cells kept free in the middle of the bar for the page dots. Mirrors `ui/src/shared/types.ts`. */
export const NAV_CENTRE_RESERVE_CELLS = 10

/**
 * The widest the named-page centre grows, in CSS px at the default 80 px bar: NavBar.vue's centre
 * track cap. Mirrors `ui/src/shared/types.ts`.
 */
export const NAV_NAMES_MAX_WIDTH = 1200

/** The bar height every px measure below is designed at; a 40 px bar halves them. */
const DESIGN_NAV_HEIGHT = 80

/**
 * The settings that make a compact widget need more room than its manifest asks for.
 * Mirrors `ui/src/shared/types.ts`.
 */
export const WIDE_COMPACT_SETTINGS = ['compactDate', 'compactCities'] as const

/** The width a compact widget gets when one of those settings is on. Mirrors `ui/src/shared/types.ts`. */
export const WIDE_COMPACT_WIDTH = 8

/**
 * How many cells the bar allots one compact widget: what its manifest declares, widened when a
 * wide setting is on — in the instance's settings or, failing that, as the manifest's default,
 * exactly as the UI merges them. 0 when the widget has no compact rendering.
 */
export function compactWidth(manifest: LayoutManifest | undefined, settings: Record<string, unknown>): number {
  const base = manifest?.compact?.width ?? 0
  if (!base) return 0
  const merged: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(manifest?.settingsSchema ?? {})) merged[k] = f.default
  Object.assign(merged, settings)
  const wide = WIDE_COMPACT_SETTINGS.some((key) => merged[key] === true)
  return wide ? Math.max(base, WIDE_COMPACT_WIDTH) : base
}

/** The cells one screen's bar takes; an entry naming a missing or unknown widget counts 0. */
export function navCellsUsed(screen: Screen, widgets: Config['widgets'], manifests: Map<string, LayoutManifest>): number {
  return screen.nav.reduce((sum, item) => {
    // Own keys only: an id such as `constructor` must not find Object.prototype's.
    const widget = Object.hasOwn(widgets, item.instanceId) ? widgets[item.instanceId] : undefined
    return widget ? sum + compactWidth(manifests.get(widget.widgetId), widget.settings) : sum
  }, 0)
}

/**
 * The CSS px the wider of a screen's two clusters takes, gaps and padding included. The bar
 * centres its pages between two side tracks as wide as that cluster, so it is the one that
 * counts. Mirrors `navWiderClusterWidth` in `ui/src/shared/types.ts`.
 */
export function navWiderClusterWidth(screen: Screen, widgets: Config['widgets'], manifests: Map<string, LayoutManifest>): number {
  const { cell } = screen.display
  const scale = (screen.display.navHeight ?? DESIGN_NAV_HEIGHT) / DESIGN_NAV_HEIGHT
  const side = (slot: 'left' | 'right'): number => {
    const items = screen.nav.filter((item) => item.slot === slot)
    const cells = items.reduce((sum, item) => {
      const widget = Object.hasOwn(widgets, item.instanceId) ? widgets[item.instanceId] : undefined
      return widget ? sum + compactWidth(manifests.get(widget.widgetId), widget.settings) : sum
    }, 0)
    // 12 px between widgets and 12 px of padding at each end, at the 80 px design.
    return cells * cell + Math.max(0, items.length - 1) * 12 * scale + 24 * scale
  }
  return Math.max(side('left'), side('right'))
}

/**
 * The CSS px a screen's bar keeps for its pages: the dots' cells, or the names — 120 px each,
 * 8 px apart — up to the centre track's cap. Mirrors `navCentreWidth` in `ui/src/shared/types.ts`.
 */
export function navCentreWidth(screen: Screen): number {
  const { display } = screen
  if (display.navStyle !== 'names') return NAV_CENTRE_RESERVE_CELLS * display.cell
  const names = Math.max(screen.pages.length, 1)
  const scale = (display.navHeight ?? DESIGN_NAV_HEIGHT) / DESIGN_NAV_HEIGHT
  return Math.min(names * 120 + (names - 1) * 8, NAV_NAMES_MAX_WIDTH) * scale
}

/** The CSS px each side track may take before the clusters reach the pages. */
export function navSideRoom(screen: Screen): number {
  return (screen.display.cols * screen.display.cell - navCentreWidth(screen)) / 2
}

/** Whether a screen's clusters leave its pages their centre. Mirrors `navHasRoom` in the UI. */
export function navHasRoom(screen: Screen, widgets: Config['widgets'], manifests: Map<string, LayoutManifest>): boolean {
  return navWiderClusterWidth(screen, widgets, manifests) <= navSideRoom(screen)
}
