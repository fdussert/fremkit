/**
 * Applying a shared layout to the config: the pure half of "Import a layout…".
 *
 * The server has already read the file (`server/src/share/import.ts`): every widget it keeps is
 * one this Mac has, every placement fits its own screen's grid, and nothing names one of the
 * user's connections. What is left is to turn its keys into fresh ids and put it somewhere —
 * beside what is there, or in place of it when the user chose "replace". It runs inside the admin
 * store's `apply()`, so the whole import is one undo step.
 */
import {
  DEFAULT_NAV_HEIGHT, MAX_NAV_WIDGETS, ROWS_BY_NAV_HEIGHT, compactWidth, mergeSettings, navHasRoom,
  type Background, type Config, type LayoutFile, type NavItem, type Page, type Screen, type ScreenDisplay,
  type SharedBackground, type SharedScreen, type Widget, type WidgetManifest,
} from '../shared/types'
import { arrangeInto } from './arrange'
import { freeInstanceId, freePageId, freeScreenId } from './store'
import { labsDevices } from './labs'

export type ImportMode = 'add' | 'replace'

export interface ImportChoices {
  mode: ImportMode
  /** Image key in the file → the name it was stored under in this Mac's background library. */
  images: Record<string, string>
  /** `<widget key>:<setting>` → the connection id (or ids) the user chose for it. */
  connections: Record<string, string | string[]>
  /** Also switch to the file's theme. Only offered when this Mac has it. */
  theme: boolean
}

/**
 * Where the import landed, for the editor to show it, what had no room, and how many of the
 * file's device screens were skipped because iPad screens are an experimental feature that is off.
 */
export interface ImportOutcome { screenId: string; pageIndex: number; leftOut: number; skippedDevices: number }

/**
 * The file's device screens this import leaves out: all of them while `labs.devices` is off, for a
 * screen or setup file (a page file lands on the screen being edited, whatever it came from).
 * Their widgets go with them. Edge screens import as they always have.
 */
export function skippedDeviceScreens(cfg: Config, layout: LayoutFile): number {
  if (labsDevices(cfg) || layout.scope === 'page') return 0
  return layout.screens.filter((x) => x.kind === 'device').length
}

/** The display keys a screen takes from a file it is replaced by: its look, not its geometry. */
const LOOK_KEYS = ['autoCycleSeconds', 'navStyle', 'navOpacity', 'tileOpacity', 'adminGesture'] as const

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function dropUnplaced(cfg: Config, ids: string[]): void {
  const placed = new Set(cfg.screens.flatMap((s) => [...s.nav.map((n) => n.instanceId), ...s.pages.flatMap((p) => p.items.map((i) => i.instanceId))]))
  for (const id of ids) if (!placed.has(id)) delete cfg.widgets[id]
}

/** Every widget a screen shows, its bar included. */
const shownOn = (screen: Screen): string[] => [...screen.nav.map((n) => n.instanceId), ...screen.pages.flatMap((p) => p.items.map((i) => i.instanceId))]

/**
 * Applies `layout` to `cfg` in place. `at` is the screen and page being edited: where a page
 * lands, and which screen a screen file replaces.
 */
export function mergeLayout(
  cfg: Config,
  layout: LayoutFile,
  at: { screenId: string; pageIndex: number },
  choices: ImportChoices,
  manifests: Record<string, WidgetManifest>,
): ImportOutcome {
  let leftOut = 0
  const skippedDevices = skippedDeviceScreens(cfg, layout)
  // Only what this Mac may show: with iPad screens hidden, a device screen in the file is skipped.
  const fileScreens = skippedDevices ? layout.screens.filter((x) => x.kind !== 'device') : layout.screens
  const bg = (b: SharedBackground | undefined): Background | undefined => {
    if (!b) return undefined
    const out: Background = {}
    if (b.color) out.color = b.color
    const image = b.image ? choices.images[b.image] : undefined
    if (image) { out.image = image; if (b.fit) out.fit = b.fit }
    return Object.keys(out).length ? out : undefined
  }

  // One new widget per key, whatever the number of screens showing it: that is what it was.
  const ids: Record<string, string> = {}
  for (const [key, shared] of Object.entries(layout.widgets)) {
    if (!manifests[shared.widgetId]) continue
    const id = freeInstanceId(cfg, shared.widgetId)
    const widget: Widget = { widgetId: shared.widgetId, showTitle: shared.showTitle, settings: clone(shared.settings) }
    if (shared.title) widget.title = shared.title
    if (shared.bgColor) widget.bgColor = shared.bgColor
    if (shared.accentColor) widget.accentColor = shared.accentColor
    if (shared.accentMode) widget.accentMode = shared.accentMode
    if (shared.opacity !== undefined) widget.opacity = shared.opacity
    const image = shared.background ? choices.images[shared.background.image] : undefined
    if (shared.background && image) {
      widget.background = { image, ...(shared.background.fit ? { fit: shared.background.fit } : {}), ...(shared.background.dim !== undefined ? { dim: shared.background.dim } : {}) }
    }
    for (const [pick, chosen] of Object.entries(choices.connections)) {
      const [k, setting] = pick.split(':')
      if (k === key && setting && (Array.isArray(chosen) ? chosen.length : chosen)) widget.settings[setting] = clone(chosen)
    }
    cfg.widgets[id] = widget
    ids[key] = id
  }
  const made = Object.values(ids)

  /** A file screen with this config's instance ids, pages fresh-id'd, before any re-arranging. */
  const translate = (screen: SharedScreen): { pages: Page[]; nav: NavItem[] } => {
    const pages: Page[] = []
    for (const p of screen.pages) {
      const b = bg(p.background)
      pages.push({
        id: freePageId(pages), name: p.name,
        items: p.items.filter((i) => ids[i.widget]).map((i) => ({ instanceId: ids[i.widget], x: i.x, y: i.y, w: i.w, h: i.h, ...(i.locked ? { locked: true } : {}) })),
        ...(b ? { background: b } : {}),
      })
    }
    const nav = screen.nav.filter((n) => ids[n.widget]).map((n) => ({ instanceId: ids[n.widget], slot: n.slot, ...(n.popup ? { popup: true } : {}) }))
    return { pages, nav }
  }

  /** Pages laid on `target`'s grid: as they are when they fit, re-arranged when they do not. */
  const onGrid = (target: Screen, pages: Page[]): Page[] => {
    const { cols, rows } = target.display
    if (pages.every((p) => p.items.every((i) => i.x + i.w <= cols && i.y + i.h <= rows))) return pages
    const laid = arrangeInto(
      { ...target, nav: [], pages },
      { cols, rows, navCols: cols, navHeight: target.display.navHeight },
      cfg.widgets, manifests,
    )
    leftOut += laid.leftOut.length
    return laid.pages
  }

  /** Bar items while the bar has room, by the rule the editor and the save apply. */
  const fillBar = (target: Screen, nav: NavItem[]): void => {
    const shown = new Set(shownOn(target))
    for (const item of nav) {
      const widget = cfg.widgets[item.instanceId]
      const manifest = widget ? manifests[widget.widgetId] : undefined
      const width = compactWidth(manifest, mergeSettings(manifest, widget?.settings ?? {}))
      if (!widget || shown.has(item.instanceId) || target.nav.length >= MAX_NAV_WIDGETS || !width
        || !navHasRoom(target, cfg.widgets, manifests, width, item.slot)) { leftOut++; continue }
      target.nav.push(item)
      shown.add(item.instanceId)
    }
  }

  /** A new screen made from a file screen, with its own grid. */
  const addScreen = (shared: SharedScreen): Screen => {
    const { background, ...rest } = shared.display
    const display: ScreenDisplay = clone(rest) as ScreenDisplay
    const b = bg(background)
    if (b) display.background = b
    const { pages, nav } = translate(shared)
    const screen: Screen = {
      id: freeScreenId(shared.name, cfg.screens.map((s) => s.id)), name: shared.name, kind: shared.kind,
      display, nav: [], pages: pages.length ? pages : [{ id: 'page-1', name: shared.name, items: [] }],
    }
    cfg.screens.push(screen)
    fillBar(screen, nav)
    return screen
  }

  /** An existing screen takes a file screen's pages, bar and look, and keeps its own grid. */
  const replaceScreen = (target: Screen, shared: SharedScreen): void => {
    const before = shownOn(target)
    // Two Edge screens share a geometry: the bar's height (and so the rows) can follow the file.
    if (target.kind === 'edge' && shared.kind === 'edge') {
      const height = shared.display.navHeight ?? DEFAULT_NAV_HEIGHT
      if (height === DEFAULT_NAV_HEIGHT) delete target.display.navHeight
      else target.display.navHeight = height
      target.display.rows = ROWS_BY_NAV_HEIGHT[height]
    }
    for (const k of LOOK_KEYS) {
      if (shared.display[k] !== undefined) (target.display as unknown as Record<string, unknown>)[k] = clone(shared.display[k])
      else delete target.display[k]
    }
    const b = bg(shared.display.background)
    if (b) target.display.background = b
    else delete target.display.background
    const { pages, nav } = translate(shared)
    target.pages = []
    target.nav = []
    target.pages = onGrid(target, pages)
    if (!target.pages.length) target.pages = [{ id: 'page-1', name: shared.name, items: [] }]
    fillBar(target, nav)
    dropUnplaced(cfg, before)
  }

  const current = cfg.screens.find((s) => s.id === at.screenId) ?? cfg.screens[0]
  let outcome = { screenId: current.id, pageIndex: at.pageIndex }

  if (layout.scope === 'page') {
    const { pages } = translate(layout.screens[0])
    const laid = onGrid(current, pages)
    if (choices.mode === 'replace' && current.pages[at.pageIndex]) {
      const old = current.pages[at.pageIndex]
      const [first, ...more] = laid
      current.pages.splice(at.pageIndex, 1, { ...first, id: old.id }, ...more.map((p) => ({ ...p, id: freePageId(current.pages, p.id) })))
      dropUnplaced(cfg, old.items.map((i) => i.instanceId))
      outcome = { screenId: current.id, pageIndex: at.pageIndex }
    } else {
      const index = current.pages.length
      for (const p of laid) current.pages.push({ ...p, id: freePageId(current.pages, p.id) })
      outcome = { screenId: current.id, pageIndex: index }
    }
  } else if (!fileScreens.length) {
    // A screen or setup file of device screens only, skipped: nothing lands, the editor stays put.
  } else if (layout.scope === 'screen') {
    if (choices.mode === 'replace') { replaceScreen(current, fileScreens[0]); outcome = { screenId: current.id, pageIndex: 0 } }
    else outcome = { screenId: addScreen(fileScreens[0]).id, pageIndex: 0 }
  } else if (choices.mode === 'replace') {
    // Each file screen takes the place of an existing screen of its kind, in order, so the Edge
    // and the paired devices keep showing the screen they were set to; the rest are added, and the
    // existing screens left without a counterpart go.
    const free = [...cfg.screens]
    const kept: Screen[] = []
    const before = cfg.screens.flatMap(shownOn)
    let first: Screen | null = null
    for (const shared of fileScreens) {
      const i = free.findIndex((s) => s.kind === shared.kind)
      let screen: Screen
      if (i >= 0) {
        screen = free.splice(i, 1)[0]
        screen.name = shared.name
        replaceScreen(screen, shared)
      } else {
        screen = addScreen(shared)
      }
      kept.push(screen)
      first ??= screen
    }
    // The device screens already here stay when the file's were skipped: they were not replaced.
    cfg.screens = cfg.screens.filter((s) => kept.includes(s) || (skippedDevices > 0 && s.kind === 'device'))
    dropUnplaced(cfg, before)
    outcome = { screenId: first!.id, pageIndex: 0 }
  } else {
    let first: Screen | null = null
    // Every screen is added; `first ??= addScreen(…)` would have stopped calling it after one.
    for (const shared of fileScreens) {
      const screen = addScreen(shared)
      first ??= screen
    }
    outcome = { screenId: first!.id, pageIndex: 0 }
  }

  if (choices.theme && layout.theme) {
    cfg.theme = layout.theme.day
    if (layout.theme.night && cfg.themeSchedule) cfg.themeSchedule.night = layout.theme.night
  }
  dropUnplaced(cfg, made)
  return { ...outcome, leftOut, skippedDevices }
}
