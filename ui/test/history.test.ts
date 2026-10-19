import { describe, expect, it } from 'vitest'
import { groupByDay, MAX_PHRASES, summaryPhrases } from '../src/admin/history'
import { translate } from '../src/shared/i18n'
import type { HistoryEntry, HistorySummary } from '../src/shared/api'

const t = (key: string, params?: Record<string, string | number>) => translate('en', key, params)
const names = { widget: (id: string) => ({ clock: 'Clock', weather: 'Weather' } as Record<string, string>)[id] ?? id, theme: (id: string) => id }
const empty = (): HistorySummary => ({
  screensAdded: [], screensRemoved: [], screensRenamed: [], pagesAdded: [], pagesRemoved: [], pagesRenamed: [],
  widgetsAdded: [], widgetsRemoved: [], widgetsMoved: 0, widgetsEdited: 0, screensEdited: [], other: false,
})

describe('summaryPhrases', () => {
  it('words pages and widgets by the names the user knows', () => {
    const s = { ...empty(), pagesAdded: [{ screen: 'Edge', name: 'Music' }], widgetsAdded: ['clock'], widgetsMoved: 2 }
    expect(summaryPhrases(s, t, 'en', names)).toEqual(['Page “Music” added', 'Clock added', '2 widgets moved'])
  })

  it('lists several widgets once each, by name', () => {
    const s = { ...empty(), widgetsRemoved: ['clock', 'weather', 'clock'] }
    expect(summaryPhrases(s, t, 'en', names)).toEqual(['3 widgets removed (Clock and Weather)'])
  })

  it('says when nothing visible changed, and when it is the oldest version', () => {
    expect(summaryPhrases(empty(), t, 'en', names)).toEqual(['No visible change'])
    expect(summaryPhrases({ ...empty(), first: true }, t, 'en', names)).toEqual(['Oldest version kept'])
  })

  it('folds a long list into "and N more"', () => {
    const s = { ...empty(), pagesAdded: ['A', 'B', 'C', 'D', 'E'].map((name) => ({ screen: 'Edge', name })) }
    const out = summaryPhrases(s, t, 'en', names)
    expect(out).toHaveLength(MAX_PHRASES)
    expect(out.at(-1)).toBe('and 2 more change(s)')
  })

  it('has every key in French too', () => {
    const fr = (key: string, params?: Record<string, string | number>) => translate('fr', key, params)
    const s = { ...empty(), pagesRenamed: [{ screen: 'Edge', from: 'A', to: 'B' }] }
    expect(summaryPhrases(s, fr, 'fr', names)).toEqual(['Page « A » renommée « B »'])
  })
})

describe('groupByDay', () => {
  const entry = (savedAt: number): HistoryEntry => ({ id: String(savedAt), at: savedAt, savedAt, kind: 'save', summary: empty() })
  it('files entries under today, yesterday and older dates, newest first', () => {
    const now = new Date(2026, 9, 18, 15, 0).getTime()
    const groups = groupByDay([
      entry(new Date(2026, 9, 18, 14, 0).getTime()),
      entry(new Date(2026, 9, 18, 9, 0).getTime()),
      entry(new Date(2026, 9, 17, 22, 0).getTime()),
      entry(new Date(2026, 9, 12, 8, 0).getTime()),
    ], t, 'en', now)
    expect(groups.map((g) => [g.label, g.entries.length])).toEqual([
      ['Today', 2], ['Yesterday', 1], [new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(2026, 9, 12)), 1],
    ])
  })
})
