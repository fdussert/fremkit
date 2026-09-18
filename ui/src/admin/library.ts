
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
