import type { Config } from '../config/schema.js'

/** The built-in widget that shows the browser extension's share. */
export const FREMPLAY_WIDGET_ID = 'fremplay'

/**
 * Where a share would be shown: on the Edge's screen — the first `edge` screen, or the first
 * screen when there is none, as the dashboard picks it with no `?screen=` — in its bar
 * (`pageIndex` null) or on the first page in order that holds the widget. Null when that screen
 * holds none, which is what refuses a share: a picture only a paired iPad could show is not one
 * this Mac starts capturing for.
 */
export function placeFremplay(config: Config): { screenId: string; pageIndex: number | null } | null {
  const screen = config.screens.find((s) => s.kind === 'edge') ?? config.screens[0]
  if (!screen) return null
  const holds = (instanceId: string): boolean => config.widgets[instanceId]?.widgetId === FREMPLAY_WIDGET_ID
  if (screen.nav.some((item) => holds(item.instanceId))) return { screenId: screen.id, pageIndex: null }
  const pageIndex = screen.pages.findIndex((page) => page.items.some((item) => holds(item.instanceId)))
  return pageIndex === -1 ? null : { screenId: screen.id, pageIndex }
}
