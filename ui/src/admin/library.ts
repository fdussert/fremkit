import type { WidgetManifest } from '../shared/types'

/**
 * The shelves of the widget library, in reading order: what the person is building with first,
 * then the machine, then the day's work, then the room. A widget whose manifest names no
 * category — or one this version does not know — lands in `other` rather than disappearing.
 */
export const WIDGET_CATEGORIES = ['ai', 'dev', 'system', 'productivity', 'media', 'info', 'home', 'other'] as const
export type WidgetCategory = (typeof WIDGET_CATEGORIES)[number]

export const categoryOf = (manifest: WidgetManifest): WidgetCategory =>
  ((WIDGET_CATEGORIES as readonly string[]).includes(manifest.category ?? '') ? manifest.category : 'other') as WidgetCategory

/** The manifests grouped by shelf, empty shelves left out, each group sorted by `compare`. */
export function groupByCategory(
  manifests: WidgetManifest[],
  compare: (a: WidgetManifest, b: WidgetManifest) => number,
): { id: WidgetCategory; widgets: WidgetManifest[] }[] {
  const groups = new Map<WidgetCategory, WidgetManifest[]>()
  for (const manifest of manifests) {
    const key = categoryOf(manifest)
    const list = groups.get(key) ?? []
    list.push(manifest)
    groups.set(key, list)
  }
  return WIDGET_CATEGORIES
    .filter((id) => groups.has(id))
    .map((id) => ({ id, widgets: groups.get(id)!.sort(compare) }))
}
