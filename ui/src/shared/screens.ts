import type { Config, NavHeight, NavItem, Placement, Screen, Widget, WidgetInstance } from './types'

/**
 * Reading a v4 config from the screen's side: which screen a dashboard shows, the tiles it draws
 * from shared widgets and per-screen placements, and the grid a paired device gets.
 */

/** Cell size of a device screen, in CSS pixels; the same as the Edge's. */
export const DEVICE_CELL = 40
/**
 * The bar a new device screen gets. A tablet is held close and touched with a fingertip, so the
 * slim bar leaves the room to the pages; the Edge keeps its 80 px default.
 */
export const DEVICE_NAV_HEIGHT: NavHeight = 40

/**
 * What a placement or bar item naming no widget is drawn as: an empty `widgetId`, which no
 * manifest has, so the frame paints its "missing widget" state. The server refuses such a config,
 * so this only covers a config edited between two loads.
 */
const MISSING: Widget = { widgetId: '', showTitle: false, settings: {} }

/** A widget joined with one of its placements: what a page frame draws. */
export function tileOf(config: Pick<Config, 'widgets'>, p: Placement): WidgetInstance {
  return { ...(config.widgets[p.instanceId] ?? MISSING), ...p }
}

/**
 * A bar item presented as the tile the bridge speaks in: one row high, `cells` wide, from the
 * top-left, with no title and no appearance of its own — the bar paints the surface, and the
 * widget's tile look belongs to its tiles. The popover starts from this and sizes it to its box.
 */
export function compactOf(config: Pick<Config, 'widgets'>, item: NavItem, cells: number): WidgetInstance {
  const widget = config.widgets[item.instanceId] ?? MISSING
  return {
    instanceId: item.instanceId,
    widgetId: widget.widgetId,
    x: 0, y: 0, w: cells, h: 1,
    showTitle: false,
    settings: widget.settings,
  }
}

/**
 * The screen a dashboard opened with `?screen=<id>` shows: that one, or — for an unknown or absent
 * id — the first Edge screen, or the first screen when there is no Edge. Never nothing: a stale
 * link shows the Edge rather than an error page.
 */
export function pickScreen(config: Config, id: string | null): Screen {
  return config.screens.find((s) => s.id === id)
    ?? config.screens.find((s) => s.kind === 'edge')
    ?? config.screens[0]
}

/**
 * The grid a device screen gets from its viewport: 40 px cells across the whole width, and down
 * the height the bar leaves. 1376 × 1032 (a 13-inch iPad in landscape) under a 40 px bar is 34 × 24.
 */
export function deviceGrid(width: number, height: number, navHeight: NavHeight): { cols: number; rows: number } {
  return {
    cols: Math.floor(width / DEVICE_CELL),
    rows: Math.floor((height - navHeight) / DEVICE_CELL),
  }
}

/** Every screen that shows the instance, on one of its pages or in its bar, in config order. */
export function screensShowing(config: Config, instanceId: string): Screen[] {
  return config.screens.filter((s) =>
    s.nav.some((item) => item.instanceId === instanceId)
    || s.pages.some((page) => page.items.some((p) => p.instanceId === instanceId)))
}
