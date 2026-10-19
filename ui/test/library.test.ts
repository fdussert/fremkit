import { describe, it, expect } from 'vitest'
import { categoryOf, groupByCategory, otherScreenWidgets, fold, matchesQuery, widgetKindsOnScreen } from '../src/admin/library'
import type { Config, WidgetManifest } from '../src/shared/types'

const widget = (id: string, category?: string): WidgetManifest => ({
  id,
  name: id,
  version: '1.0.0',
  sdk: 1,
  description: '',
  icon: 'layout-grid',
  minSize: [8, 4],
  defaultSize: [8, 4],
  subscriptions: [],
  commands: [],
  settingsSchema: {},
  permissions: { network: [] },
  ...(category ? { category } : {}),
} as WidgetManifest)

describe('categoryOf', () => {
  it('keeps a category it knows and files the rest under other', () => {
    expect(categoryOf(widget('clock', 'info'))).toBe('info')
    expect(categoryOf(widget('clock'))).toBe('other')
    expect(categoryOf(widget('clock', 'weather-and-tides'))).toBe('other')
  })
})

describe('groupByCategory', () => {
  const byName = (a: WidgetManifest, b: WidgetManifest) => String(a.name).localeCompare(String(b.name))

  it('returns the shelves in reading order, empty ones left out', () => {
    const groups = groupByCategory([widget('weather', 'info'), widget('cpu', 'system'), widget('claude-usage', 'ai')], byName)
    expect(groups.map((g) => g.id)).toEqual(['ai', 'system', 'info'])
  })

  it('sorts each shelf with the comparator it is given', () => {
    const groups = groupByCategory([widget('weather', 'info'), widget('clock', 'info'), widget('pomodoro', 'info')], byName)
    expect(groups[0].widgets.map((w) => w.id)).toEqual(['clock', 'pomodoro', 'weather'])
  })

  it('shows a widget whose category is unknown rather than dropping it', () => {
    const groups = groupByCategory([widget('mystery', 'nope')], byName)
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('other')
    expect(groups[0].widgets.map((w) => w.id)).toEqual(['mystery'])
  })
})

describe('otherScreenWidgets', () => {
  const place = (instanceId: string) => ({ instanceId, x: 0, y: 0, w: 1, h: 1 })
  const config = {
    widgets: Object.fromEntries(['clock-1', 'cpu-1', 'note-1', 'mail-1', 'bar-1', 'bar-2'].map((id) => [id, { widgetId: id.split('-')[0], showTitle: false, settings: {} }])),
    screens: [
      { id: 'edge', kind: 'edge', nav: [{ instanceId: 'bar-1' }], pages: [{ items: [place('clock-1'), place('cpu-1')] }] },
      { id: 'tablet', kind: 'device', nav: [{ instanceId: 'bar-2' }], pages: [{ items: [place('cpu-1')] }, { items: [place('note-1'), place('clock-1')] }] },
      { id: 'phone', kind: 'device', nav: [{ instanceId: 'bar-1' }], pages: [{ items: [place('note-1'), place('mail-1')] }] },
    ],
  } as unknown as Config

  it('excludes widgets already on this screen and lists each once', () => {
    expect(otherScreenWidgets(config, 'edge')).toEqual(['note-1', 'bar-2', 'mail-1'])
    expect(otherScreenWidgets(config, 'tablet')).toEqual(['bar-1', 'mail-1'])
  })

  it('names the kinds of widget a screen shows, its bar included', () => {
    expect([...widgetKindsOnScreen(config, 'edge')].sort()).toEqual(['bar', 'clock', 'cpu'])
    expect([...widgetKindsOnScreen(config, 'phone')].sort()).toEqual(['bar', 'mail', 'note'])
    expect(widgetKindsOnScreen(config, 'nowhere').size).toBe(0)
  })

  it('is empty with a single screen or an unknown screen id', () => {
    expect(otherScreenWidgets({ ...config, screens: [config.screens[0]] } as Config, 'edge')).toEqual([])
    expect(otherScreenWidgets(config, 'nope')).toEqual(['clock-1', 'cpu-1', 'bar-1', 'note-1', 'bar-2', 'mail-1'])
  })
})

describe('matchesQuery', () => {
  it('matches everything when the box is empty or blank', () => {
    expect(matchesQuery(['Clock'], '')).toBe(true)
    expect(matchesQuery(['Clock'], '   ')).toBe(true)
  })

  it('needs every word typed, anywhere in the card', () => {
    expect(matchesQuery(['weather', 'Weather', 'Forecast for the day'], 'day weather')).toBe(true)
    expect(matchesQuery(['weather', 'Weather', 'Forecast for the day'], 'day clock')).toBe(false)
  })

  it('ignores case and accents on both sides', () => {
    expect(matchesQuery(['Météo'], 'meteo')).toBe(true)
    expect(matchesQuery(['Meteo'], 'MÉTÉO')).toBe(true)
    expect(fold('Écran Luminosité')).toBe('ecran luminosite')
  })
})
