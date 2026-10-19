/**
 * `labs.companion` off is Fremplay off: what the dashboard and the admin do with the Fremplay
 * widgets already placed. The config keeps every one of them where it is, so turning the switch
 * back on brings them back in place; only what is drawn changes.
 *
 * - The dashboard draws none of them (`visibleScreen`): their tiles and bar items go, and a page
 *   that held nothing else drops out of the navigation.
 * - The admin keeps them on its canvas, greyed and labelled, to delete as usual (`turnedOff`).
 */
import type { Config, Screen } from './types'

/** The built-in widgets that belong to the companion. */
export const COMPANION_WIDGETS: readonly string[] = ['fremplay']

export function companionOn(config: Pick<Config, 'labs'> | null | undefined): boolean {
  return config?.labs?.companion === true
}

/**
 * The instance ids whose widget is off while the switch is: every placed Fremplay. Empty with the
 * switch on.
 */
export function turnedOff(config: Pick<Config, 'labs' | 'widgets'> | null | undefined): Set<string> {
  if (!config || companionOn(config)) return new Set()
  const off = new Set<string>()
  for (const [id, widget] of Object.entries(config.widgets)) if (COMPANION_WIDGETS.includes(widget.widgetId)) off.add(id)
  return off
}

/**
 * The screen as the dashboard draws it: the same object with the switch on, else one without the
 * companion's tiles and bar items, and without the pages that held only those. A page that was
 * empty to begin with stays. If every page would go, the first one stays, emptied, so the
 * dashboard always has a page to show.
 */
export function visibleScreen(config: Pick<Config, 'labs' | 'widgets'>, screen: Screen): Screen {
  const off = turnedOff(config)
  if (off.size === 0) return screen
  const touches = screen.nav.some((n) => off.has(n.instanceId)) || screen.pages.some((p) => p.items.some((i) => off.has(i.instanceId)))
  if (!touches) return screen
  const pages = screen.pages
    .filter((p) => p.items.length === 0 || p.items.some((i) => !off.has(i.instanceId)))
    .map((p) => (p.items.some((i) => off.has(i.instanceId)) ? { ...p, items: p.items.filter((i) => !off.has(i.instanceId)) } : p))
  return {
    ...screen,
    nav: screen.nav.filter((n) => !off.has(n.instanceId)),
    pages: pages.length > 0 ? pages : screen.pages.slice(0, 1).map((p) => ({ ...p, items: [] })),
  }
}
