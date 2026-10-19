import { describe, expect, it } from 'vitest'
import { createAdminStore } from '../src/admin/store'
import { firstFreeBlock, groupDelta } from '../src/admin/layout'
import { setLocale } from '../src/shared/i18n'
import type { Config, WidgetManifest } from '../src/shared/types'

const clock: WidgetManifest = {
  id: 'clock', name: 'Clock', version: '1.0.0', sdk: 1, description: '', icon: 'clock',
  minSize: [4, 2], defaultSize: [8, 4], subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
}

function config(): Config {
  return {
    version: 4, locale: 'en', connections: [], secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      a: { widgetId: 'clock', showTitle: true, settings: {} },
      b: { widgetId: 'clock', showTitle: true, settings: {} },
      c: { widgetId: 'clock', showTitle: true, settings: {} },
      d: { widgetId: 'clock', showTitle: true, settings: {} },
    },
    screens: [
      {
        id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
        pages: [
          {
            id: 'p', name: 'Home', items: [
              { instanceId: 'a', x: 0, y: 0, w: 8, h: 4 },
              { instanceId: 'b', x: 10, y: 0, w: 8, h: 4 },
              { instanceId: 'c', x: 0, y: 8, w: 8, h: 4, locked: true },
              { instanceId: 'd', x: 30, y: 0, w: 8, h: 4 },
            ],
          },
          { id: 'q', name: 'Second', items: [] },
          { id: 'r', name: 'Full', items: [] },
        ],
      },
      {
        id: 'desk', name: 'Desk', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
        pages: [{ id: 'm', name: 'Main', items: [{ instanceId: 'd', x: 0, y: 0, w: 8, h: 4 }] }],
      },
    ],
  }
}

async function make() {
  setLocale('en')
  const cfg = config()
  // The third page is full: one tile covering the whole grid.
  cfg.widgets.big = { widgetId: 'clock', showTitle: true, settings: {} }
  cfg.screens[0].pages[2].items.push({ instanceId: 'big', x: 0, y: 0, w: 64, h: 16 })
  const store = createAdminStore({
    api: {
      getConfig: async () => cfg, getStatus: async () => ({ degraded: false }),
      getWidgets: async () => ({ widgets: { clock }, errors: [], sources: {}, asks: {}, sdk: 1 }),
      putConfig: async (c) => c, rescan: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
    },
    subscribeConfig: () => () => {},
    debounceMs: 0,
  })
  await store.load()
  return store
}
type Store = Awaited<ReturnType<typeof make>>
const rect = (s: Store, id: string) => {
  const p = s.page.value!.items.find((x) => x.instanceId === id)!
  return { x: p.x, y: p.y, w: p.w, h: p.h }
}
const ids = (s: Store) => s.page.value!.items.map((p) => p.instanceId)

describe('the selection', () => {
  it('keeps selectedId for one tile and null for several', async () => {
    const s = await make()
    s.select('a')
    expect(s.state.selection).toEqual(['a'])
    expect(s.state.selectedId).toBe('a')
    expect(s.selected.value?.instanceId).toBe('a')
    s.toggleSelect('b')
    expect(s.state.selection).toEqual(['a', 'b'])
    expect(s.state.selectedId).toBeNull()
    expect(s.selected.value).toBeNull()
    expect(s.selectedTiles.value.map((w) => w.instanceId)).toEqual(['a', 'b'])
    s.toggleSelect('a')
    expect(s.state.selectedId).toBe('b')
    // Setting selectedId selects that tile alone, as every caller before groups expects.
    s.toggleSelect('a')
    s.state.selectedId = 'd'
    expect(s.state.selection).toEqual(['d'])
    s.select(null)
    expect(s.state.selection).toEqual([])
  })

  it('selects all of the page, many at once, never a tile of another page', async () => {
    const s = await make()
    s.selectAll()
    expect(s.state.selection).toEqual(['a', 'b', 'c', 'd'])
    s.selectMany(['b', 'nope', 'b', 'c'])
    expect(s.state.selection).toEqual(['b', 'c'])
    s.toggleSelect('big')
    expect(s.state.selection).toEqual(['b', 'c'])
    s.selectPage(1)
    expect(s.state.selection).toEqual([])
  })

  it('drops from the selection a tile that leaves the page', async () => {
    const s = await make()
    s.selectMany(['a', 'b'])
    s.removeFromScreen('a')
    expect(s.state.selection).toEqual(['b'])
  })
})

describe('group moves', () => {
  it('moves the group as one block, in one undo step', async () => {
    const s = await make()
    expect(s.moveTiles(['a', 'b'], 2, 3)).toBe(true)
    expect(rect(s, 'a')).toEqual({ x: 2, y: 3, w: 8, h: 4 })
    expect(rect(s, 'b')).toEqual({ x: 12, y: 3, w: 8, h: 4 })
    s.undo()
    expect(rect(s, 'a')).toEqual({ x: 0, y: 0, w: 8, h: 4 })
    expect(rect(s, 'b')).toEqual({ x: 10, y: 0, w: 8, h: 4 })
  })

  it('cuts the step short at the grid edge, for the whole block', async () => {
    const s = await make()
    expect(s.moveTiles(['a', 'b'], -5, 0)).toBe(false)
    expect(s.moveTiles(['a', 'b'], 0, 100)).toBe(true)
    expect(rect(s, 'a').y).toBe(12)
    expect(rect(s, 'b').y).toBe(12)
  })

  it('leaves a locked tile where it is and moves the others', async () => {
    const s = await make()
    expect(s.moveTiles(['a', 'c'], 0, 1)).toBe(true)
    expect(rect(s, 'a')).toEqual({ x: 0, y: 1, w: 8, h: 4 })
    expect(rect(s, 'c')).toEqual({ x: 0, y: 8, w: 8, h: 4 })
    // Only locked tiles: nothing moves.
    expect(s.moveTiles(['c'], 1, 0)).toBe(false)
  })

  it('is refused when a moved tile would land on one that stays', async () => {
    const s = await make()
    // Thirteen right puts b on 23..31, over d's first column (30).
    expect(s.moveTiles(['a', 'b'], 13, 0)).toBe(false)
    expect(rect(s, 'a').x).toBe(0)
    // Its own members never block it: a moves onto b's old cells with b.
    expect(s.moveTiles(['a', 'b'], 10, 0)).toBe(true)
    expect(rect(s, 'a').x).toBe(10)
  })

  it('joins a held arrow into one undo step', async () => {
    const s = await make()
    s.moveTiles(['a', 'b'], 0, 1)
    s.moveTiles(['a', 'b'], 0, 1, { repeat: true })
    s.moveTiles(['a', 'b'], 0, 1, { repeat: true })
    expect(rect(s, 'a').y).toBe(3)
    s.undo()
    expect(rect(s, 'a').y).toBe(0)
    expect(rect(s, 'b').y).toBe(0)
  })
})

describe('group copy, duplicate and delete', () => {
  it('duplicates the group in its arrangement, the copies selected, one undo step', async () => {
    const s = await make()
    s.duplicateTiles(['a', 'b'])
    const made = s.state.selection
    expect(made).toHaveLength(2)
    expect(made.every((id) => !['a', 'b'].includes(id))).toBe(true)
    const [ra, rb] = made.map((id) => rect(s, id))
    // Same sizes, same offset between them.
    expect(rb.x - ra.x).toBe(10)
    expect(rb.y - ra.y).toBe(0)
    expect(ids(s)).toHaveLength(6)
    s.undo()
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('copies a group and pastes it on another page as it was arranged', async () => {
    const s = await make()
    s.copyTiles(['b', 'c'])
    expect(s.state.clipboard?.map((x) => x.at)).toEqual([[10, 0], [0, 8]])
    s.selectPage(1)
    expect(s.pasteWidget()).toBe(true)
    expect(ids(s)).toHaveLength(2)
    const [first, second] = s.state.selection.map((id) => rect(s, id))
    expect(first).toEqual({ x: 10, y: 0, w: 8, h: 4 })
    expect(second).toEqual({ x: 0, y: 8, w: 8, h: 4 })
    s.undo()
    expect(ids(s)).toEqual([])
  })

  it('refuses a group paste where the block has no room', async () => {
    const s = await make()
    s.copyTiles(['a', 'b'])
    s.selectPage(2)
    expect(s.pasteWidget()).toBe(false)
    expect(s.state.toast).not.toBe('')
  })

  it('removes the group in one undo step, deleting widgets shown nowhere else', async () => {
    const s = await make()
    s.selectMany(['a', 'd'])
    s.removeTiles(['a', 'd'])
    expect(ids(s)).toEqual(['b', 'c'])
    expect(s.state.selection).toEqual([])
    expect(s.state.config!.widgets.a).toBeUndefined()
    // d is still on the Desk.
    expect(s.state.config!.widgets.d).toBeDefined()
    s.undo()
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('group menu commands', () => {
  it('moves the group to another page, kept together, and the editor follows', async () => {
    const s = await make()
    s.moveTilesToPage(['a', 'b'], 1)
    expect(s.state.pageIndex).toBe(1)
    expect(ids(s)).toEqual(['a', 'b'])
    expect(s.state.selection).toEqual(['a', 'b'])
    expect(rect(s, 'b').x - rect(s, 'a').x).toBe(10)
    s.undo()
    expect(s.state.config!.screens[0].pages[0].items.map((p) => p.instanceId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('refuses a page with no room for the block', async () => {
    const s = await make()
    s.moveTilesToPage(['a', 'b'], 2)
    expect(s.state.pageIndex).toBe(0)
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('moves the group onto a new page where it was', async () => {
    const s = await make()
    s.moveTilesToNewPage(['a', 'c'])
    expect(s.state.pageIndex).toBe(3)
    expect(rect(s, 'c')).toEqual({ x: 0, y: 8, w: 8, h: 4 })
    expect(s.page.value!.items.find((p) => p.instanceId === 'c')!.locked).toBe(true)
  })

  it('locks, unlocks and restyles the group in one step each', async () => {
    const s = await make()
    s.setLockedTiles(['a', 'b'], true)
    expect(s.page.value!.items.filter((p) => p.locked).map((p) => p.instanceId)).toEqual(['a', 'b', 'c'])
    s.updateWidgets(['a', 'b'], { opacity: 0.4, showTitle: false })
    expect(s.state.config!.widgets.a).toMatchObject({ opacity: 0.4, showTitle: false })
    expect(s.state.config!.widgets.b).toMatchObject({ opacity: 0.4, showTitle: false })
    s.updateWidgets(['a', 'b'], { opacity: undefined })
    expect('opacity' in s.state.config!.widgets.a).toBe(false)
    s.undo()
    s.undo()
    expect(s.state.config!.widgets.a.opacity).toBeUndefined()
    expect(s.state.config!.widgets.a.showTitle).toBe(true)
    s.undo()
    expect(s.page.value!.items.filter((p) => p.locked).map((p) => p.instanceId)).toEqual(['c'])
  })
})

describe('block geometry', () => {
  const grid = { cols: 20, rows: 10 }
  it('clamps a group step at the edges', () => {
    const rects = [{ x: 2, y: 1, w: 4, h: 2 }, { x: 10, y: 5, w: 4, h: 3 }]
    expect(groupDelta(rects, -5, -5, grid)).toEqual({ dx: -2, dy: -1 })
    expect(groupDelta(rects, 10, 10, grid)).toEqual({ dx: 6, dy: 2 })
  })
  it('finds the first place a block fits, or none', () => {
    const rects = [{ x: 5, y: 5, w: 2, h: 2 }, { x: 8, y: 5, w: 2, h: 2 }]
    expect(firstFreeBlock(rects, grid, [])).toEqual({ dx: -5, dy: -5 })
    // A tile at 0..3 on row 0–1 pushes it right of it.
    expect(firstFreeBlock(rects, grid, [{ x: 0, y: 0, w: 3, h: 2 }])).toEqual({ dx: -2, dy: -5 })
    expect(firstFreeBlock(rects, grid, [{ x: 0, y: 0, w: 20, h: 10 }])).toBeNull()
  })
})
