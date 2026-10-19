
import type { Config } from '../shared/types'

/**
 * The shelves of the widget library, in reading order: what the person is building with first,
 * then the machine, then the day's work, then the room. A widget whose manifest names no
 * category — or one this version does not know — lands in `other` rather than disappearing.
 */
export const WIDGET_CATEGORIES = ['ai', 'dev', 'system', 'productivity', 'media', 'info', 'home', 'other'] as const
export type WidgetCategory = (typeof WIDGET_CATEGORIES)[number]

export const categoryOf = (widget: { category?: string }): WidgetCategory =>
  ((WIDGET_CATEGORIES as readonly string[]).includes(widget.category ?? '') ? widget.category : 'other') as WidgetCategory

/**
 * Anything with a shelf, grouped by it — empty shelves left out, each group sorted by `compare`.
 *
 * Generic over the row because two lists want the same shelves: the palette, which groups
 * manifests of what is installed, and the registry panel, which groups index entries of what is
 * not. Writing the order and the empty-shelf rule twice is how the two would end up disagreeing
 * about where a widget lives before and after it is installed.
 */
export function groupByCategory<T extends { category?: string }>(
  widgets: T[],
  compare: (a: T, b: T) => number,
): { id: WidgetCategory; widgets: T[] }[] {
  const groups = new Map<WidgetCategory, T[]>()
  for (const widget of widgets) {
    const key = categoryOf(widget)
    const list = groups.get(key) ?? []
    list.push(widget)
    groups.set(key, list)
  }
  return WIDGET_CATEGORIES
    .filter((id) => groups.has(id))
    .map((id) => ({ id, widgets: groups.get(id)!.sort(compare) }))
}

/**
 * The widgets other screens show and this one does not, each once, in the order they first
 * appear (screens in config order; on a screen, its pages before its bar). A screen shows a
 * widget at most once, so one already on this screen — on a page or in its bar — is not offered.
 */
/** Lower case with the accents stripped, so "meteo" finds "Météo" and "Meteo" alike. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Whether a search box matches a card: every word typed appears somewhere in what the card
 * shows. The palette and the registry panel both search through here, so the same query finds
 * the same widget before and after it is installed.
 */
export function matchesQuery(parts: readonly string[], query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = fold(parts.join(' '))
  return words.every((word) => haystack.includes(word))
}

/** The kinds of widget (manifest ids) a screen already shows, on any of its pages or in its bar. */
export function widgetKindsOnScreen(config: Config, screenId: string): Set<string> {
  const screen = config.screens.find((s) => s.id === screenId)
  if (!screen) return new Set()
  const ids = [...screen.pages.flatMap((p) => p.items.map((i) => i.instanceId)), ...screen.nav.map((i) => i.instanceId)]
  return new Set(ids.map((id) => config.widgets[id]?.widgetId).filter((w): w is string => !!w))
}

export function otherScreenWidgets(config: Config, screenId: string): string[] {
  const idsOf = (s: Config['screens'][number]): string[] =>
    [...s.pages.flatMap((p) => p.items.map((i) => i.instanceId)), ...s.nav.map((i) => i.instanceId)]
  const here = new Set(config.screens.filter((s) => s.id === screenId).flatMap(idsOf))
  const out = new Set<string>()
  for (const s of config.screens) {
    if (s.id === screenId) continue
    for (const id of idsOf(s)) if (!here.has(id) && config.widgets[id]) out.add(id)
  }
  return [...out]
}
