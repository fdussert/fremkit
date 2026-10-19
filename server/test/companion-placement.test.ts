import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Config, type Screen } from '../src/config/schema.js'
import { FREMPLAY_WIDGET_ID, placeFremplay } from '../src/companion/placement.js'

function screen(id: string, kind: Screen['kind'], pages: string[][], nav: string[] = []): Screen {
  return {
    ...DEFAULT_CONFIG.screens[0],
    id,
    name: id,
    kind,
    nav: nav.map((instanceId) => ({ instanceId, slot: 'left' as const })),
    pages: pages.map((ids, i) => ({
      id: `p${i}`,
      name: `Page ${i}`,
      items: ids.map((instanceId, n) => ({ instanceId, x: n * 8, y: 0, w: 8, h: 4 })),
    })),
  }
}

function config(screens: Screen[]): Config {
  return {
    ...DEFAULT_CONFIG,
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
      'play-1': { widgetId: FREMPLAY_WIDGET_ID, showTitle: false, settings: {} },
      'play-2': { widgetId: FREMPLAY_WIDGET_ID, showTitle: false, settings: {} },
    },
    screens,
  }
}

describe('placeFremplay', () => {
  it('names the fremplay widget id', () => {
    expect(FREMPLAY_WIDGET_ID).toBe('fremplay')
  })

  it('finds the first page in order', () => {
    const c = config([screen('edge', 'edge', [['clock-1'], ['play-2'], ['play-1']])])
    expect(placeFremplay(c)).toEqual({ screenId: 'edge', pageIndex: 1 })
  })

  it('returns pageIndex null for the bar', () => {
    const c = config([screen('edge', 'edge', [['clock-1'], ['play-2']], ['play-1'])])
    expect(placeFremplay(c)).toEqual({ screenId: 'edge', pageIndex: null })
  })

  it('returns null when only a device screen holds it', () => {
    const c = config([
      screen('ipad', 'device', [['play-1']]),
      screen('edge', 'edge', [['clock-1']]),
    ])
    expect(placeFremplay(c)).toBeNull()
  })

  it('reads the first Edge screen, not the first screen', () => {
    const c = config([
      screen('ipad', 'device', [['clock-1']]),
      screen('edge', 'edge', [['clock-1'], ['play-1']]),
    ])
    expect(placeFremplay(c)).toEqual({ screenId: 'edge', pageIndex: 1 })
  })

  it('falls back to the first screen when there is no Edge, as the dashboard does', () => {
    const c = config([screen('ipad', 'device', [['play-1']])])
    expect(placeFremplay(c)).toEqual({ screenId: 'ipad', pageIndex: 0 })
  })

  it('returns null when nothing holds it', () => {
    expect(placeFremplay(config([screen('edge', 'edge', [['clock-1']])]))).toBeNull()
  })
})
