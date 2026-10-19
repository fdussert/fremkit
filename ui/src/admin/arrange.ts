import {
  MAX_NAV_WIDGETS, compactWidth, mergeSettings, navHasRoom,
  type Config, type NavHeight, type NavItem, type Page, type Placement, type Screen, type WidgetManifest,
} from '../shared/types'
import { firstFreeSpot, largestFreeSpot, type Grid } from './layout'

/**
 * The grid a screen is being pre-filled for; `navCols` is the width its bar's room is checked
 * against, and `navHeight` the height of that bar (absent: the default), which scales its gaps.
 */
export interface ArrangeTarget { cols: number; rows: number; navCols: number; navHeight?: NavHeight }

/** What a pre-fill would give the new screen, before anything is saved. */
export interface Arrangement {
  pages: Page[]
  nav: NavItem[]
  /** Instance ids that found no place at all: their minimum size exceeds the grid, or no room was left. */
  leftOut: string[]
  /** Bar items that did not fit the new bar and were placed as tiles on the first page instead. */
  navToTiles: string[]
}

/**
 * The size a placement takes on the target grid: its own, narrowed (or shortened) to the grid
 * when the widget's minimum size allows it; null when the widget cannot fit the grid at all.
 */
function sizeOn(p: Placement, min: [number, number], grid: Grid): [number, number] | null {
  const w = p.w <= grid.cols ? p.w : min[0] <= grid.cols ? grid.cols : 0
  const h = p.h <= grid.rows ? p.h : min[1] <= grid.rows ? grid.rows : 0
  return w && h ? [w, h] : null
}

/**
 * Lays one screen's pages and bar out on another grid, for "pre-fill from": pages in order, each
 * page's tiles in reading order (row, then column), each at the first free position scanning rows
 * top to bottom and columns left to right, at its own size. A page that runs out of room
 * continues on a new page named `<name> 2`, `<name> 3`. Bar items are copied in order while the
 * new bar has room; the rest become tiles on the first page when one fits, or are left out.
 *
 * Pure, and it only ever references widgets that exist in `widgets`: it never creates one, and
 * it keeps each widget at most once on the result, as a screen requires.
 */
export function arrangeInto(
  source: Screen,
  target: ArrangeTarget,
  widgets: Config['widgets'],
  manifests: Record<string, WidgetManifest>,
): Arrangement {
  const grid: Grid = { cols: Math.max(1, target.cols), rows: Math.max(1, target.rows) }
  const minOf = (id: string): [number, number] => manifests[widgets[id]?.widgetId ?? '']?.minSize ?? [1, 1]
  const pages: Page[] = []
  const leftOut: string[] = []
  const navToTiles: string[] = []
  const seen = new Set<string>()
  // Source page ids keep their own; an overflow page takes `<id>-<n>`, never one already in use.
  const takenIds = new Set(source.pages.map((p) => p.id))
  const overflowId = (base: string): string => {
    let n = 2
    while (takenIds.has(`${base}-${n}`)) n++
    takenIds.add(`${base}-${n}`)
    return `${base}-${n}`
  }

  for (const page of source.pages) {
    // A page's own background goes with it, onto its overflow pages too: they are the same page, split.
    const own = page.background ? { background: { ...page.background } } : {}
    let current: Page = { id: page.id, name: page.name, items: [], ...own }
    let part = 1
    pages.push(current)
    const ordered = [...page.items].sort((a, b) => a.y - b.y || a.x - b.x)
    for (const p of ordered) {
      if (!widgets[p.instanceId] || seen.has(p.instanceId)) continue
      seen.add(p.instanceId)
      const size = sizeOn(p, minOf(p.instanceId), grid)
      if (!size) { leftOut.push(p.instanceId); continue }
      let spot = firstFreeSpot(size, grid, current.items)
      if (!spot) {
        part++
        current = { id: overflowId(page.id), name: `${page.name} ${part}`, items: [], ...own }
        pages.push(current)
        spot = firstFreeSpot(size, grid, current.items)
      }
      // The size never exceeds the grid, so an empty page always has room.
      if (spot) current.items.push({ instanceId: p.instanceId, ...spot })
      else leftOut.push(p.instanceId)
    }
  }

  // The bar is checked as it fills, against the target's width, by the same rule the editor uses.
  // A new screen starts with page dots, whatever style the source uses: `addScreen` does not copy it.
  const { navStyle: _style, navHeight: _height, ...look } = source.display
  const bar: Screen = {
    ...source, nav: [], pages: [],
    display: { ...look, cols: target.navCols, ...(target.navHeight ? { navHeight: target.navHeight } : {}) },
  }
  for (const item of source.nav) {
    const widget = widgets[item.instanceId]
    if (!widget || seen.has(item.instanceId)) continue
    seen.add(item.instanceId)
    const manifest = manifests[widget.widgetId]
    const width = compactWidth(manifest, mergeSettings(manifest, widget.settings))
    if (width && bar.nav.length < MAX_NAV_WIDGETS && navHasRoom(bar, widgets, manifests, width, item.slot)) {
      bar.nav.push({ ...item })
      continue
    }
    const first = pages[0]
    const spot = first && manifest
      ? largestFreeSpot(manifest.defaultSize, manifest.minSize, grid, first.items)
      : null
    if (spot) {
      first.items.push({ instanceId: item.instanceId, ...spot })
      navToTiles.push(item.instanceId)
    } else {
      leftOut.push(item.instanceId)
    }
  }

  return { pages, nav: bar.nav, leftOut, navToTiles }
}
