/**
 * What changed between two saved versions of the dashboard, as data.
 *
 * Machine-readable on purpose: the server does not know which language the admin is shown in when
 * a version is read back, so it records *what* changed and the admin words it. Names are the ones
 * the user gave (page and screen names); widgets are named by their widget id, which the admin
 * turns into the manifest's name.
 *
 * Pure: no file, no clock. `history.ts` stores what this returns next to each snapshot.
 */

import type { Config, Screen } from './schema.js'

export interface PageRef { screen: string; name: string }
export interface Rename { from: string; to: string }

export interface ChangeSummary {
  /** No earlier version to compare with: the oldest entry kept, or the first one ever. */
  first?: true
  screensAdded: string[]
  screensRemoved: string[]
  screensRenamed: Rename[]
  pagesAdded: PageRef[]
  pagesRemoved: PageRef[]
  pagesRenamed: (Rename & { screen: string })[]
  /** Widget ids (`clock`, `weather`…) of the instances that appeared, one per instance. */
  widgetsAdded: string[]
  widgetsRemoved: string[]
  /** Instances present before and after whose placement changed on some page or bar. */
  widgetsMoved: number
  /** Instances present before and after whose settings or appearance changed. */
  widgetsEdited: number
  theme?: Rename
  /** Screens (by name) whose display settings, bar or brightness changed. */
  screensEdited: string[]
  /** Anything else: language, night theme, privacy switches, experimental features, connections, marketplace records. */
  other: boolean
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Every place an instance sits, as one comparable string per screen it is on. */
function placementsOf(config: Config): Map<string, string> {
  const out = new Map<string, string[]>()
  const add = (id: string, where: string) => {
    const list = out.get(id) ?? []
    list.push(where)
    out.set(id, list)
  }
  for (const screen of config.screens) {
    screen.nav.forEach((n, i) => add(n.instanceId, `${screen.id}:nav:${i}:${JSON.stringify(n)}`))
    for (const page of screen.pages) {
      for (const p of page.items) add(p.instanceId, `${screen.id}:${page.id}:${p.x},${p.y},${p.w},${p.h},${p.locked ? 1 : 0}`)
    }
  }
  return new Map([...out].map(([id, list]) => [id, list.sort().join('|')]))
}

/** A screen minus its pages: what "this screen's settings changed" compares. */
const screenSettings = (s: Screen) => ({ display: s.display, brightness: s.brightness, kind: s.kind, navCount: s.nav.length })

export function summarizeChange(before: Config | null, after: Config): ChangeSummary {
  const summary: ChangeSummary = {
    screensAdded: [], screensRemoved: [], screensRenamed: [],
    pagesAdded: [], pagesRemoved: [], pagesRenamed: [],
    widgetsAdded: [], widgetsRemoved: [], widgetsMoved: 0, widgetsEdited: 0,
    screensEdited: [], other: false,
  }
  if (!before) return { ...summary, first: true }

  const oldScreens = new Map(before.screens.map((s) => [s.id, s]))
  const newScreens = new Map(after.screens.map((s) => [s.id, s]))
  for (const s of after.screens) {
    const was = oldScreens.get(s.id)
    if (!was) {
      summary.screensAdded.push(s.name)
      continue
    }
    if (was.name !== s.name) summary.screensRenamed.push({ from: was.name, to: s.name })
    if (!same(screenSettings(was), screenSettings(s))) summary.screensEdited.push(s.name)
    const oldPages = new Map(was.pages.map((p) => [p.id, p]))
    const newPageIds = new Set(s.pages.map((p) => p.id))
    for (const p of s.pages) {
      const old = oldPages.get(p.id)
      if (!old) summary.pagesAdded.push({ screen: s.name, name: p.name })
      else if (old.name !== p.name) summary.pagesRenamed.push({ screen: s.name, from: old.name, to: p.name })
    }
    for (const p of was.pages) if (!newPageIds.has(p.id)) summary.pagesRemoved.push({ screen: s.name, name: p.name })
  }
  for (const s of before.screens) if (!newScreens.has(s.id)) summary.screensRemoved.push(s.name)

  const oldPlaces = placementsOf(before)
  const newPlaces = placementsOf(after)
  for (const [id, w] of Object.entries(after.widgets)) {
    const was = before.widgets[id]
    if (!was) {
      summary.widgetsAdded.push(w.widgetId)
      continue
    }
    if (!same(was, w)) summary.widgetsEdited++
    if ((oldPlaces.get(id) ?? '') !== (newPlaces.get(id) ?? '')) summary.widgetsMoved++
  }
  for (const [id, w] of Object.entries(before.widgets)) if (!(id in after.widgets)) summary.widgetsRemoved.push(w.widgetId)

  if (before.theme !== after.theme) summary.theme = { from: before.theme, to: after.theme }
  summary.other = !same(before.locale, after.locale)
    || !same(before.themeSchedule, after.themeSchedule)
    || !same(before.privacy, after.privacy)
    || !same(before.labs, after.labs)
    || !same(before.connections, after.connections)
    || !same(before.marketplace, after.marketplace)
    || !same(before.secrets, after.secrets)
  return summary
}

/** True when the summary names nothing at all: two versions that differ in no way it reports. */
export function isEmptySummary(s: ChangeSummary): boolean {
  return !s.first && !s.theme && !s.other && !s.widgetsMoved && !s.widgetsEdited
    && [s.screensAdded, s.screensRemoved, s.screensRenamed, s.pagesAdded, s.pagesRemoved, s.pagesRenamed,
      s.widgetsAdded, s.widgetsRemoved, s.screensEdited].every((list) => list.length === 0)
}
