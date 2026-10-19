import { ref } from 'vue'
import { setSectionsOpen } from '../shared/ui/BaseSection.vue'
import type { HistoryEntry, HistorySummary } from '../shared/api'
import type { Locale, Params } from '../shared/i18n'
import { openSettings } from './settingsWindow'

/** Set by the top bar's history button; the History section scrolls itself into view and clears it. */
export const revealHistory = ref(false)

/**
 * Opens the settings window on its History pane: the top bar's button and the command palette.
 * Undo reaches back one session; the history reaches back a month.
 */
export function openHistory(s: { openModal(name: 'settings'): void }): void {
  setSectionsOpen(['screen.history'], true)
  revealHistory.value = true
  openSettings(s, 'history')
}

type T = (key: string, params?: Params) => string

/** How many phrases a row shows before "and N more". */
export const MAX_PHRASES = 4

/** "A, B and C" in the language in force. */
function listOf(names: string[], locale: Locale): string {
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names)
}

/**
 * The summary the server recorded, in words. `names` turns a widget or theme id into what the
 * catalogue calls it; one no longer installed keeps its id.
 */
export function summaryPhrases(s: HistorySummary, t: T, locale: Locale,
  names: { widget: (id: string) => string; theme: (id: string) => string }): string[] {
  const widgetName = names.widget
  if (s.first) return [t('admin.history.first')]
  const out: string[] = []
  for (const x of s.screensAdded) out.push(t('admin.history.screenAdded', { name: x }))
  for (const x of s.screensRemoved) out.push(t('admin.history.screenRemoved', { name: x }))
  for (const x of s.screensRenamed) out.push(t('admin.history.screenRenamed', { from: x.from, to: x.to }))
  for (const x of s.pagesAdded) out.push(t('admin.history.pageAdded', { name: x.name }))
  for (const x of s.pagesRemoved) out.push(t('admin.history.pageRemoved', { name: x.name }))
  for (const x of s.pagesRenamed) out.push(t('admin.history.pageRenamed', { from: x.from, to: x.to }))
  const named = (ids: string[]) => listOf([...new Set(ids.map(widgetName))], locale)
  if (s.widgetsAdded.length === 1) out.push(t('admin.history.widgetAdded', { name: widgetName(s.widgetsAdded[0]) }))
  else if (s.widgetsAdded.length) out.push(t('admin.history.widgetsAdded', { count: s.widgetsAdded.length, names: named(s.widgetsAdded) }))
  if (s.widgetsRemoved.length === 1) out.push(t('admin.history.widgetRemoved', { name: widgetName(s.widgetsRemoved[0]) }))
  else if (s.widgetsRemoved.length) out.push(t('admin.history.widgetsRemoved', { count: s.widgetsRemoved.length, names: named(s.widgetsRemoved) }))
  if (s.widgetsMoved) out.push(t(s.widgetsMoved === 1 ? 'admin.history.widgetMoved' : 'admin.history.widgetsMoved', { count: s.widgetsMoved }))
  if (s.widgetsEdited) out.push(t(s.widgetsEdited === 1 ? 'admin.history.widgetEdited' : 'admin.history.widgetsEdited', { count: s.widgetsEdited }))
  if (s.theme) out.push(t('admin.history.theme', { name: names.theme(s.theme.to) }))
  if (s.screensEdited.length) out.push(t('admin.history.screensEdited', { names: listOf(s.screensEdited, locale) }))
  if (s.other) out.push(t('admin.history.other'))
  if (!out.length) out.push(t('admin.history.noChange'))
  if (out.length > MAX_PHRASES) {
    const rest = out.length - (MAX_PHRASES - 1)
    return [...out.slice(0, MAX_PHRASES - 1), t('admin.history.more', { count: rest })]
  }
  return out
}

/** Midnight of `ms`'s day, local time: the key a day group is filed under. */
function dayOf(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export interface DayGroup { day: number; label: string; entries: HistoryEntry[] }

/** Entries (newest first) grouped by the day they were last saved, labelled "Today", "Yesterday" or the date. */
export function groupByDay(entries: HistoryEntry[], t: T, locale: Locale, now: number = Date.now()): DayGroup[] {
  const today = dayOf(now)
  const yesterday = dayOf(today - 12 * 3600_000)
  const date = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' })
  const groups: DayGroup[] = []
  for (const entry of entries) {
    const day = dayOf(entry.savedAt)
    let group = groups.at(-1)
    if (!group || group.day !== day) {
      const label = day === today ? t('admin.history.today') : day === yesterday ? t('admin.history.yesterday') : date.format(day)
      group = { day, label, entries: [] }
      groups.push(group)
    }
    group.entries.push(entry)
  }
  return groups
}

/** "14:32", in the language in force. */
export function timeOf(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(ms)
}

/** "18 Oct, 14:32", for a reference to another version that may be on another day. */
export function stampOf(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms)
}
