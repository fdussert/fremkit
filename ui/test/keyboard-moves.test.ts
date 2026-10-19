import { describe, expect, it } from 'vitest'
import { createAdminStore } from '../src/admin/store'
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
    },
    screens: [{
      id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
      pages: [
        {
          id: 'p', name: 'Home', items: [
            // Listed out of reading order on purpose: c sits first on the page.
            { instanceId: 'a', x: 10, y: 0, w: 8, h: 4 },
            { instanceId: 'b', x: 0, y: 8, w: 8, h: 4 },
            { instanceId: 'c', x: 0, y: 0, w: 8, h: 4, locked: true },
          ],
        },
        { id: 'q', name: 'Empty', items: [] },
      ],
    }],
  }
}

async function make() {
  setLocale('en')
  const store = createAdminStore({
    api: {
      getConfig: async () => config(), getStatus: async () => ({ degraded: false }),
      getWidgets: async () => ({ widgets: { clock }, errors: [], sources: {}, asks: {}, sdk: 1 }),
      putConfig: async (c) => c, rescan: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
    },
    subscribeConfig: () => () => {},
    debounceMs: 0,
  })
  await store.load()
  return store
}
const rect = (s: Awaited<ReturnType<typeof make>>, id: string) => {
  const p = s.page.value!.items.find((x) => x.instanceId === id)!
  return { x: p.x, y: p.y, w: p.w, h: p.h }
}

describe('nudgeWidget', () => {
  it('moves a tile by one cell, one undo step per press', async () => {
    const s = await make()
    expect(s.nudgeWidget('a', 1, 0)).toBe(true)
    expect(s.nudgeWidget('a', 0, 1)).toBe(true)
    expect(rect(s, 'a')).toEqual({ x: 11, y: 1, w: 8, h: 4 })
    s.undo()
    expect(rect(s, 'a')).toEqual({ x: 11, y: 0, w: 8, h: 4 })
  })

  it('joins the steps of a held key into the press that started it', async () => {
    const s = await make()
    s.nudgeWidget('a', 1, 0)
    s.nudgeWidget('a', 1, 0, { repeat: true })
    s.nudgeWidget('a', 1, 0, { repeat: true })
    expect(rect(s, 'a').x).toBe(13)
    s.undo()
    expect(rect(s, 'a').x).toBe(10)
    expect(s.canUndo.value).toBe(false)
  })

  it('starts a new step when the held key moves another tile, or after an undo', async () => {
    const s = await make()
    s.nudgeWidget('a', 1, 0)
    s.nudgeWidget('b', 1, 0, { repeat: true })
    s.undo()
    expect(rect(s, 'a').x).toBe(11)
    expect(rect(s, 'b').x).toBe(0)
    s.nudgeWidget('a', 1, 0, { repeat: true })
    s.undo()
    expect(rect(s, 'a').x).toBe(11)
  })

  it('stops at the grid edge and at another tile, as a drag does', async () => {
    const s = await make()
    // b sits at the left edge.
    expect(s.nudgeWidget('b', -1, 0)).toBe(false)
    // a is two cells right of the locked c (which ends at x 8): one cell left fits, two do not.
    expect(s.nudgeWidget('a', -1, 0)).toBe(true)
    expect(s.nudgeWidget('a', -1, 0)).toBe(true)
    expect(s.nudgeWidget('a', -1, 0)).toBe(false)
    expect(rect(s, 'a').x).toBe(8)
  })

  it('leaves a locked tile where it is', async () => {
    const s = await make()
    expect(s.nudgeWidget('c', 0, 1)).toBe(false)
    expect(s.nudgeWidget('c', 1, 1, { resize: true })).toBe(false)
    expect(rect(s, 'c')).toEqual({ x: 0, y: 0, w: 8, h: 4 })
    expect(s.canUndo.value).toBe(false)
  })

  it('resizes from the south-east corner, never under the minimum size', async () => {
    const s = await make()
    expect(s.nudgeWidget('b', 1, 1, { resize: true })).toBe(true)
    expect(rect(s, 'b')).toEqual({ x: 0, y: 8, w: 9, h: 5 })
    for (let i = 0; i < 10; i++) s.nudgeWidget('b', -1, 0, { resize: true, repeat: true })
    expect(rect(s, 'b').w).toBe(4)
    // Growing into the bottom of the grid stops at its last row.
    for (let i = 0; i < 10; i++) s.nudgeWidget('b', 0, 1, { resize: true, repeat: true })
    expect(rect(s, 'b').h).toBe(8)
  })

  it('refuses a resize that would cover another tile', async () => {
    const s = await make()
    // b slides under a's columns (b: x 4–12, y 8–12; a: x 10–18, y 0–4).
    for (let i = 0; i < 4; i++) s.nudgeWidget('b', 1, 0)
    for (let i = 0; i < 4; i++) expect(s.nudgeWidget('a', 0, 1, { resize: true })).toBe(true)
    expect(rect(s, 'a').h).toBe(8)
    expect(s.nudgeWidget('a', 0, 1, { resize: true })).toBe(false)
    expect(rect(s, 'a').h).toBe(8)
  })
})

describe('cycleSelection', () => {
  it('walks the page in reading order and wraps', async () => {
    const s = await make()
    expect(s.cycleSelection(1)).toBe('c')
    expect(s.cycleSelection(1)).toBe('a')
    expect(s.cycleSelection(1)).toBe('b')
    expect(s.cycleSelection(1)).toBe('c')
    expect(s.cycleSelection(-1)).toBe('b')
  })

  it('starts from the last tile backwards, and does nothing on an empty page', async () => {
    const s = await make()
    expect(s.cycleSelection(-1)).toBe('b')
    s.selectPage(1)
    expect(s.cycleSelection(1)).toBeNull()
    expect(s.state.selectedId).toBeNull()
  })
})
