/**
 * `labs.fremdev` off is Fremdev off: what the dashboard and the admin do with the Fremdev widgets
 * already placed. The config keeps every one of them where it is, so turning the switch back on
 * brings them back in place; only what is drawn changes. Fremplay is always on and is not gated.
 *
 * - The dashboard draws none of them (`visibleScreen`): their tiles and bar items go, and a page
 *   that held nothing else drops out of the navigation.
 * - The admin keeps them on its canvas, greyed and labelled, to delete as usual (`turnedOff`).
 *
 * A product switch, not a security boundary: the server gates Fremdev's channel, commands and
 * routes on `fremdevEnabled` itself.
 */
import type { Config, Screen } from './types'

/** The built-in widget Fremdev's switch covers. */
export const FREMDEV_WIDGET = 'fremdev'

/** Fremdev runs only while its own switch (`labs.fremdev`) is on. */
export function fremdevOn(config: Pick<Config, 'labs'> | null | undefined): boolean {
  return config?.labs?.fremdev === true
}

/** The instance ids whose widget is off: every placed Fremdev while its switch is off. */
export function turnedOff(config: Pick<Config, 'labs' | 'widgets'> | null | undefined): Set<string> {
  if (!config || fremdevOn(config)) return new Set()
  const off = new Set<string>()
  for (const [id, widget] of Object.entries(config.widgets)) if (widget.widgetId === FREMDEV_WIDGET) off.add(id)
  return off
}

/**
 * The screen as the dashboard draws it: the same object with the switch on, else one without
 * Fremdev's tiles and bar items, and without the pages that held only those. A page that was empty
 * to begin with stays. If every page would go, the first one stays, emptied, so the dashboard
 * always has a page to show.
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
