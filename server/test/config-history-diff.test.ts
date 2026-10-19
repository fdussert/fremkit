import { describe, expect, it } from 'vitest'
import { ConfigSchema, type Config } from '../src/config/schema.js'
import { isEmptySummary, summarizeChange } from '../src/config/history-diff.js'

const base = (): Config => ConfigSchema.parse({
  version: 4,
  theme: 'fremkit',
  widgets: {
    'clock-1': { widgetId: 'clock', settings: { hour12: false } },
    'weather-1': { widgetId: 'weather', settings: {} },
  },
  screens: [{
    id: 'edge', name: 'Xeneon Edge', kind: 'edge',
    pages: [
      { id: 'home', name: 'Home', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 4, h: 4 }] },
      { id: 'work', name: 'Work', items: [{ instanceId: 'weather-1', x: 0, y: 0, w: 4, h: 4 }] },
    ],
  }],
})

describe('summarizeChange', () => {
  it('marks the first version as such', () => {
    expect(summarizeChange(null, base()).first).toBe(true)
  })

  it('reports nothing between two equal configs', () => {
    expect(isEmptySummary(summarizeChange(base(), base()))).toBe(true)
  })

  it('names pages added, removed and renamed, with their screen', () => {
    const after = base()
    after.screens[0].pages[0].name = 'Desk'
    after.screens[0].pages.splice(1, 1)
    after.screens[0].pages.push({ id: 'music', name: 'Music', items: [] })
    const s = summarizeChange(base(), after)
    expect(s.pagesRenamed).toEqual([{ screen: 'Xeneon Edge', from: 'Home', to: 'Desk' }])
    expect(s.pagesRemoved).toEqual([{ screen: 'Xeneon Edge', name: 'Work' }])
    expect(s.pagesAdded).toEqual([{ screen: 'Xeneon Edge', name: 'Music' }])
  })

  it('counts widgets added, removed, moved and edited', () => {
    const after = base()
    delete after.widgets['weather-1']
    after.screens[0].pages[1].items = []
    after.widgets['notes-1'] = { widgetId: 'notes', showTitle: true, settings: {} }
    after.screens[0].pages[1].items.push({ instanceId: 'notes-1', x: 0, y: 0, w: 4, h: 4 })
    after.screens[0].pages[0].items[0].x = 8
    after.widgets['clock-1'].settings = { hour12: true }
    const s = summarizeChange(base(), after)
    expect(s.widgetsAdded).toEqual(['notes'])
    expect(s.widgetsRemoved).toEqual(['weather'])
    expect(s.widgetsMoved).toBe(1)
    expect(s.widgetsEdited).toBe(1)
  })

  it('names screens added, removed, renamed and edited, and the theme', () => {
    const before = base()
    before.screens.push({ ...structuredClone(before.screens[0]), id: 'ipad', name: 'iPad', kind: 'device' })
    const after = structuredClone(before)
    after.screens = [after.screens[0]]
    after.screens[0].name = 'Edge'
    after.screens[0].display.autoCycleSeconds = 30
    after.screens.push({ ...structuredClone(after.screens[0]), id: 'mac', name: 'Mac', kind: 'device' })
    after.theme = 'edge'
    const s = summarizeChange(before, after)
    expect(s.screensRemoved).toEqual(['iPad'])
    expect(s.screensAdded).toEqual(['Mac'])
    expect(s.screensRenamed).toEqual([{ from: 'Xeneon Edge', to: 'Edge' }])
    expect(s.screensEdited).toEqual(['Edge'])
    expect(s.theme).toEqual({ from: 'fremkit', to: 'edge' })
  })

  it('folds the rest into `other`', () => {
    const after = base()
    after.locale = after.locale === 'fr' ? 'en' : 'fr'
    const s = summarizeChange(base(), after)
    expect(s.other).toBe(true)
    expect(isEmptySummary(s)).toBe(false)
  })

  it('counts either experimental features switch as a change', () => {
    for (const key of ['devices', 'companion'] as const) {
      const after = base()
      after.labs = { ...after.labs, [key]: !after.labs[key] }
      expect(summarizeChange(base(), after).other, key).toBe(true)
    }
  })
})
