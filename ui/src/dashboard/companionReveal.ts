import type { Config, Screen } from '../shared/types'
import { COMPANION_WIDGETS, companionOn } from '../shared/companionGate'

/**
 * Which page a browser-extension share should bring up on this dashboard.
 *
 * The server stamps each reveal with a `seq`. This dashboard acts on a seq it has not acted on yet:
 * "differs", not "greater", because the counter restarts at 1 when the server does. The first
 * snapshot after (re)subscribing is only recorded, so a reconnect never jumps pages on its own
 * over a share that was revealed earlier: a dashboard that stayed loaded is not moved.
 *
 * A dashboard that has just loaded is another matter (`landingPage`): the kiosk reloads when the
 * server restarts, and a share taken back after that restart is not revealed again (the server
 * counts it as on screen already), so the reloaded page would land on its first page and stay
 * there. Within `LANDING_WINDOW_MS` of the load, the first snapshot that shows a live share turns
 * to the Fremplay page, once. The extension comes back on its own backoff, seconds after the
 * kiosk, so that is rarely the first snapshot. Past the window, or once it has landed, a
 * dashboard is only ever moved by a new share (`reveal`).
 */

/** How long after a load a resumed share may still bring its page up. */
export const LANDING_WINDOW_MS = 15_000
export interface CompanionReveal { seq: number; screenId: string; pageIndex: number }

export function createRevealTracker() {
  let primed = false
  let seen: number | null = null
  return {
    /** The page index to select for this snapshot, or null when there is nothing to do. */
    observe(snapshot: { reveal?: CompanionReveal | null }, screenId: string | undefined): number | null {
      const reveal = snapshot.reveal ?? null
      if (!primed) { primed = true; seen = reveal?.seq ?? null; return null }
      if (!reveal) { seen = null; return null }
      if (reveal.seq === seen) return null
      seen = reveal.seq
      return screenId !== undefined && reveal.screenId === screenId ? reveal.pageIndex : null
    },
    /** Forget what was seen: the next snapshot is a fresh baseline. */
    reset() { primed = false; seen = null },
  }
}

/**
 * The page a dashboard that has just loaded turns to, from its first `companion` snapshot: the
 * first page in order holding a Fremplay widget, while a share is live and `labs.companion` is
 * on. Null when nothing is shared, when the bar holds the widget (it shows there whatever the
 * page), or when no page does. `screen` is the screen as drawn, so the index is the dashboard's.
 */
export function landingPage(
  snapshot: { tab?: { state?: string } | null },
  config: Pick<Config, 'labs' | 'widgets'>,
  screen: Pick<Screen, 'nav' | 'pages'>,
): number | null {
  if (snapshot.tab?.state !== 'sharing' || !companionOn(config)) return null
  const holds = (instanceId: string): boolean => COMPANION_WIDGETS.includes(config.widgets[instanceId]?.widgetId ?? '')
  if (screen.nav.some((item) => holds(item.instanceId))) return null
  const index = screen.pages.findIndex((page) => page.items.some((item) => holds(item.instanceId)))
  return index === -1 ? null : index
}
