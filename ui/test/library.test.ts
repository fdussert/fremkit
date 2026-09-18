import { describe, it, expect } from 'vitest'
import { categoryOf, groupByCategory } from '../src/admin/library'
import type { WidgetManifest } from '../src/shared/types'

const widget = (id: string, category?: string): WidgetManifest => ({
  id,
  name: id,
  version: '1.0.0',
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
    const groups = groupByCategory([widget('weather', 'info'), widget('cpu', 'system'), widget('claude-usage', 'claude')], byName)
    expect(groups.map((g) => g.id)).toEqual(['claude', 'system', 'info'])
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
