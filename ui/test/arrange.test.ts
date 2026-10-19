import { describe, it, expect } from 'vitest'
import { arrangeInto } from '../src/admin/arrange'
import { overlaps } from '../src/admin/layout'
import type { Config, Page, Placement, Screen, WidgetManifest } from '../src/shared/types'

function manifest(id: string, minSize: [number, number], defaultSize: [number, number], compact?: number): WidgetManifest {
  return {
    id, name: { fr: id, en: id }, version: '1.0.0', sdk: 1, description: '', icon: 'clock',
    minSize, defaultSize, subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
    ...(compact ? { compact: { width: compact } } : {}),
  }
}

const MANIFESTS: Record<string, WidgetManifest> = {
  small: manifest('small', [4, 2], [8, 4], 5),
  wide: manifest('wide', [20, 4], [40, 6]),
  huge: manifest('huge', [40, 4], [48, 8]),
  tall: manifest('tall', [4, 12], [8, 16]),
  plain: manifest('plain', [4, 2], [8, 4]),
}

/** One widget per placement, of the kind its id starts with (`wide-1` is a `wide`). */
function widgetsFor(ids: string[]): Config['widgets'] {
  return Object.fromEntries(ids.map((id) => [id, { widgetId: id.split('-')[0], showTitle: false, settings: {} }]))
}

function screen(pages: Page[], nav: Screen['nav'] = [], cols = 64, rows = 16): Screen {
  return { id: 'edge', name: 'Xeneon Edge', kind: 'edge', display: { cols, rows, cell: 40, autoCycleSeconds: 0 }, nav, pages }
}

const at = (instanceId: string, x: number, y: number, w: number, h: number): Placement => ({ instanceId, x, y, w, h })
const ids = (page: Page): string[] => page.items.map((p) => p.instanceId)

function assertValid(pages: Page[], cols: number, rows: number): void {
  for (const page of pages) {
    for (const p of page.items) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.x + p.w).toBeLessThanOrEqual(cols)
      expect(p.y + p.h).toBeLessThanOrEqual(rows)
    }
    for (let i = 0; i < page.items.length; i++) {
      for (let j = i + 1; j < page.items.length; j++) expect(overlaps(page.items[i], page.items[j])).toBe(false)
    }
  }
}

describe('arrangeInto', () => {
  it('carries a page background, onto its overflow pages too', () => {
    const background = { color: '#101820', image: 'dunes.webp' }
    const src = screen([{ id: 'home', name: 'Home', background, items: [at('wide-a', 0, 0, 40, 6), at('wide-b', 0, 6, 40, 6)] }])
    const out = arrangeInto(src, { cols: 40, rows: 8, navCols: 40 }, widgetsFor(['wide-a', 'wide-b']), MANIFESTS)
    expect(out.pages).toHaveLength(2)
    for (const page of out.pages) expect(page.background).toEqual(background)
    // A copy, not the same object: editing the new screen's page leaves the source alone.
    expect(out.pages[0].background).not.toBe(background)
  })
  it('keeps reading order', () => {
    // Listed out of order: reading order is by row, then by column.
    const src = screen([{ id: 'home', name: 'Home', items: [
      at('small-c', 0, 4, 8, 4), at('small-b', 8, 0, 8, 4), at('small-a', 0, 0, 8, 4),
    ] }])
    const out = arrangeInto(src, { cols: 16, rows: 8, navCols: 16 }, widgetsFor(['small-a', 'small-b', 'small-c']), MANIFESTS)
    expect(out.pages).toHaveLength(1)
    expect(out.pages[0].items).toEqual([at('small-a', 0, 0, 8, 4), at('small-b', 8, 0, 8, 4), at('small-c', 0, 4, 8, 4)])
    expect(out.pages[0]).toMatchObject({ id: 'home', name: 'Home' })
  })

  it('opens "Home 2" on overflow', () => {
    const src = screen([
      { id: 'home', name: 'Home', items: [at('small-a', 0, 0, 8, 4), at('small-b', 8, 0, 8, 4), at('small-c', 16, 0, 8, 4)] },
      // A source page already called home-2 keeps its id; the overflow page must not take it.
      { id: 'home-2', name: 'Other', items: [] },
    ])
    const out = arrangeInto(src, { cols: 10, rows: 4, navCols: 10 }, widgetsFor(['small-a', 'small-b', 'small-c']), MANIFESTS)
    expect(out.pages.map((p) => p.name)).toEqual(['Home', 'Home 2', 'Home 3', 'Other'])
    expect(out.pages.map(ids)).toEqual([['small-a'], ['small-b'], ['small-c'], []])
    const pageIds = out.pages.map((p) => p.id)
    expect(new Set(pageIds).size).toBe(pageIds.length)
    expect(pageIds[0]).toBe('home')
    expect(pageIds[3]).toBe('home-2')
    expect(out.leftOut).toEqual([])
  })

  it('narrows a wide tile when minSize allows', () => {
    const src = screen([{ id: 'home', name: 'Home', items: [at('wide-1', 0, 0, 40, 6)] }])
    const out = arrangeInto(src, { cols: 34, rows: 23, navCols: 34 }, widgetsFor(['wide-1']), MANIFESTS)
    expect(out.pages[0].items).toEqual([at('wide-1', 0, 0, 34, 6)])
    expect(out.leftOut).toEqual([])
  })

  it('reports a tile whose minSize exceeds the grid', () => {
    const src = screen([{ id: 'home', name: 'Home', items: [at('huge-1', 0, 0, 48, 8), at('tall-1', 48, 0, 8, 16), at('small-1', 56, 0, 8, 4)] }])
    // 34 wide is narrower than huge's 40 minimum; tall's 16 rows fit a 16-row grid.
    const out = arrangeInto(src, { cols: 34, rows: 16, navCols: 34 }, widgetsFor(['huge-1', 'tall-1', 'small-1']), MANIFESTS)
    expect(out.leftOut).toEqual(['huge-1'])
    expect(out.pages.flatMap(ids)).toEqual(['tall-1', 'small-1'])
    // A grid shorter than tall's minimum height leaves it out too.
    const short = arrangeInto(src, { cols: 34, rows: 10, navCols: 34 }, widgetsFor(['huge-1', 'tall-1', 'small-1']), MANIFESTS)
    expect(short.leftOut).toEqual(['huge-1', 'tall-1'])
  })

  it('copies the bar while it fits and turns the rest into tiles', () => {
    // A 30-column bar is 1200 px; the dots keep 400, so each side may take 400. A 5-cell item
    // takes 224 with its padding: one fits on each side, a second on the right (436) does not.
    const src = screen([{ id: 'home', name: 'Home', items: [at('small-p', 0, 0, 8, 4)] }], [
      { instanceId: 'small-1', slot: 'left' },
      { instanceId: 'small-2', slot: 'right', popup: true },
      { instanceId: 'small-3', slot: 'right' },
    ])
    const widgets = widgetsFor(['small-p', 'small-1', 'small-2', 'small-3'])
    const out = arrangeInto(src, { cols: 20, rows: 8, navCols: 30 }, widgets, MANIFESTS)
    expect(out.nav).toEqual([{ instanceId: 'small-1', slot: 'left' }, { instanceId: 'small-2', slot: 'right', popup: true }])
    expect(out.navToTiles).toEqual(['small-3'])
    expect(ids(out.pages[0])).toEqual(['small-p', 'small-3'])
    expect(out.leftOut).toEqual([])
    assertValid(out.pages, 20, 8)

    // No room on the first page for it either: reported.
    const full = screen([{ id: 'home', name: 'Home', items: [at('small-p', 0, 0, 20, 8)] }], src.nav)
    const none = arrangeInto(full, { cols: 20, rows: 8, navCols: 30 }, widgets, MANIFESTS)
    expect(none.navToTiles).toEqual([])
    expect(none.leftOut).toEqual(['small-3'])
  })

  it('checks the new bar against page dots and its own bar height, whatever the source uses', () => {
    // Twelve named pages would keep 1200 px of a 64-column bar, 680 a side: four 5-cell items
    // (860 px) would not fit. The new screen starts with dots, 1080 a side, so they all do.
    const pages = Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, items: [] }))
    const nav = ['small-1', 'small-2', 'small-3', 'small-4'].map((instanceId) => ({ instanceId, slot: 'left' as const }))
    const src = { ...screen(pages, nav), display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0, navStyle: 'names' as const } }
    const out = arrangeInto(src, { cols: 64, rows: 16, navCols: 64 }, widgetsFor(nav.map((x) => x.instanceId)), MANIFESTS)
    expect(out.nav).toEqual(nav)
    // A 31-column bar leaves 420 px a side. Two items take 400 + 6 + 12 = 418 under a slim
    // 40 px bar, and 400 + 12 + 24 = 436 under the 80 px one: the target's height decides.
    const ids4 = widgetsFor(nav.map((x) => x.instanceId))
    expect(arrangeInto(src, { cols: 31, rows: 16, navCols: 31, navHeight: 40 }, ids4, MANIFESTS).nav).toHaveLength(2)
    expect(arrangeInto(src, { cols: 31, rows: 16, navCols: 31 }, ids4, MANIFESTS).nav).toHaveLength(1)
  })

  it('never creates a widget', () => {
    const src = screen([
      { id: 'home', name: 'Home', items: [at('small-a', 0, 0, 8, 4), at('ghost-1', 8, 0, 8, 4), at('wide-1', 0, 4, 40, 6)] },
      { id: 'two', name: 'Two', items: [at('plain-1', 0, 0, 8, 4)] },
    ], [{ instanceId: 'small-n', slot: 'left' }, { instanceId: 'ghost-2', slot: 'right' }])
    const widgets = widgetsFor(['small-a', 'wide-1', 'plain-1', 'small-n'])
    const out = arrangeInto(src, { cols: 12, rows: 6, navCols: 12 }, widgets, MANIFESTS)
    const all = [...out.pages.flatMap(ids), ...out.nav.map((n) => n.instanceId), ...out.leftOut, ...out.navToTiles]
    for (const id of all) expect(widgets[id]).toBeDefined()
    expect(all).not.toContain('ghost-1')
    expect(all).not.toContain('ghost-2')
  })

  it('the Edge into a 13" landscape iPad (34×23) keeps every widget whose min size fits', () => {
    const src = screen([
      { id: 'home', name: 'Accueil', items: [
        at('small-1', 0, 0, 16, 4), at('wide-1', 16, 0, 40, 8), at('small-2', 56, 0, 8, 4),
        at('huge-1', 0, 8, 48, 8), at('plain-1', 48, 8, 16, 8),
      ] },
      { id: 'dev', name: 'Dev', items: [at('wide-2', 0, 0, 64, 16)] },
      { id: 'misc', name: 'Misc', items: [at('tall-1', 0, 0, 8, 16), at('small-3', 8, 0, 8, 4)] },
    ], [{ instanceId: 'small-4', slot: 'left' }])
    const all = ['small-1', 'wide-1', 'small-2', 'huge-1', 'plain-1', 'wide-2', 'tall-1', 'small-3', 'small-4']
    const widgets = widgetsFor(all)
    const out = arrangeInto(src, { cols: 34, rows: 23, navCols: 34 }, widgets, MANIFESTS)
    assertValid(out.pages, 34, 23)
    const placed = out.pages.flatMap(ids)
    for (const id of all) {
      const m = MANIFESTS[widgets[id].widgetId]
      const fitsGrid = m.minSize[0] <= 34 && m.minSize[1] <= 23
      if (id === 'small-4') { expect(out.nav.map((n) => n.instanceId)).toEqual(['small-4']); continue }
      if (fitsGrid) expect(placed).toContain(id)
      else expect(out.leftOut).toContain(id)
    }
    expect(out.leftOut).toEqual(['huge-1'])
    // Each widget at most once on the target screen.
    expect(new Set(placed).size).toBe(placed.length)
    // Every placement keeps at least its widget's minimum size.
    for (const p of out.pages.flatMap((page) => page.items)) {
      const m = MANIFESTS[widgets[p.instanceId].widgetId]
      expect(p.w).toBeGreaterThanOrEqual(m.minSize[0])
      expect(p.h).toBeGreaterThanOrEqual(m.minSize[1])
    }
  })
})
