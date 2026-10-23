import { reactive, computed, watch, type ComputedRef } from 'vue'
import { api as realApi } from '../shared/api'
import { pick, setLocale, t } from '../shared/i18n'
import { useSocket } from '../shared/socket'
import type { Background, Config, NavHeight, NavItem, Page, Placement, Screen, ScreenDisplay, Widget, WidgetInstance, WidgetManifest, WidgetPermissionSet, WidgetSource, WidgetsResponse } from '../shared/types'
import { DEFAULT_NAV_HEIGHT, MAX_NAV_WIDGETS, ROWS_BY_NAV_HEIGHT, compactWidth, mergeSettings, navHasRoom, navWiderClusterWidth } from '../shared/types'
import { DEVICE_CELL, DEVICE_NAV_HEIGHT, deviceGrid, pickScreen, screensShowing, tileOf } from '../shared/screens'
import { firstFreeBlock, fits, groupDelta, largestFreeSpot, moveRect, resizeRect, shiftAll, type Grid, type Rect } from './layout'
import { arrangeInto } from './arrange'

export type Mode = 'edit' | 'test'
/** The modal dialogs opened from the top bar. Kept in the store so a widget setting can open one. */
export type ModalName = 'settings' | 'connections' | 'marketplace' | 'about' | 'export' | 'import' | 'shortcuts'
export type Status = 'saved' | 'saving' | 'error'

/** Edits are grouped this long before one PUT of the whole config. */
export const SAVE_DEBOUNCE_MS = 300
/** Snapshots kept for undo; older ones fall off the bottom. */
export const UNDO_LIMIT = 50
/** Drag-and-drop mime type set by the widget library's drag source. */
export const DND_TYPE = 'application/x-fremkit-widget'
/** A drag of a widget that already exists on another screen: the payload is its instance id. */
export const DND_EXISTING_TYPE = 'application/x-fremkit-existing-widget'
/** Mirrors the server's 409 body: saving is impossible until the file on disk is fixed. */
export const degradedMessage = (): string => t('admin.store.degraded')

/** The keys "Copy style" carries from one tile to another: its look, never its settings. */
export const STYLE_KEYS = ['bgColor', 'accentColor', 'accentMode', 'background', 'opacity'] as const
export type WidgetStyle = Pick<Widget, typeof STYLE_KEYS[number]>

/**
 * What "Copy" holds, one per copied tile: a widget as it is set up, the size of the tile it was
 * copied from, and — for a group — where that tile sat relative to the group's top-left corner.
 */
export interface CopiedWidget { widget: Widget; size: [number, number]; at: [number, number] }

export interface AdminState {
  config: Config | null
  manifests: Record<string, WidgetManifest>
  /** Where each widget came from, so the library can mark the ones the user installed. */
  sources: Record<string, WidgetSource>
  /** What each manifest asks for, beside what it was granted. See `WidgetsResponse.asks`. */
  asks: Record<string, WidgetPermissionSet>
  /** The platform the server runs on, and the widget ids it cannot run (`WidgetsResponse`). */
  platform: WidgetsResponse['platform']
  unavailable: string[]
  catalogErrors: { id: string; error: string }[]
  /**
   * The screen being edited. Empty until a config is loaded, and whenever the screen it named
   * went away: `screen` then reads the Edge's, and the next mutation writes that id back.
   */
  screenId: string
  /** Within the selected screen. */
  pageIndex: number
  /**
   * The selected tiles of the page, by instance id, in the order they were picked. Empty for none.
   * Every list the store keeps here names tiles of the page shown: `clampSelection` sees to it.
   */
  selection: string[]
  /**
   * The one selected tile, or null when none is or several are: what single-tile editing (the
   * widget inspector, the arrow keys' resize, the handles) reads. Setting it selects that tile
   * alone — or nothing — so callers written before multiple selection keep working unchanged.
   */
  selectedId: string | null
  dragWidgetId: string | null
  mode: Mode
  /** The dialog currently open above the editor, or null. */
  modal: ModalName | null
  /**
   * The connection type the Connections dialog should open a *new* connection on, or ''.
   *
   * Cleared by `openModal`, so it only ever survives the one open it was set for: a stale value
   * would put somebody back on a form they had already left.
   */
  newConnectionType: string
  /**
   * The connection the Connections dialog should open on, or ''. Like `newConnectionType`, it
   * only survives the one open it was set for.
   */
  editConnectionId: string
  /** The widget the "About this widget" dialog describes, by instance id. */
  aboutId: string
  /**
   * The editor's own clipboard for widgets — not the system one, which a WKWebView may not
   * share and which would hand someone's settings to any other app. Kept for the visit.
   */
  clipboard: CopiedWidget[] | null
  /** What "Copy style" took, for "Paste style". */
  styleClipboard: WidgetStyle | null
  /**
   * Bumped by "Reload widget": the preview keys a tile's frame on it, so a new value reloads that
   * one iframe and nothing else.
   */
  reloads: Record<string, number>
  status: Status
  toast: string
  /**
   * Said after a widget leaves this screen while another screen still shows it: where it still is,
   * with a way there. Not an error, so not the toast.
   */
  notice: StillShown | null
  /** A short confirmation with nothing to act on ("Dashboard reloaded on …"); goes by itself. */
  info: string
  /** The server cannot read data/fremkit.json: nothing may be saved until it is fixed. */
  degraded: boolean
}

/** A widget taken off this screen that another screen still shows, and where. */
export interface StillShown {
  /** The widget named when it is one; `count` when several went at once. */
  name: string
  count: number
  instanceId: string
  screenId: string
  screenName: string
  pageIndex: number | null
  pageName: string | null
}

export interface AdminApi {
  getConfig(): Promise<Config>
  getStatus(): Promise<{ degraded: boolean }>
  getWidgets(): Promise<WidgetsResponse>
  putConfig(cfg: Config): Promise<Config>
  rescan(): Promise<WidgetsResponse>
  /** Optional so a test's fake API need not have it; the real one does. */
  reloadScreen?(screenId: string): Promise<void>
}

/** What `addScreen` takes: the new screen's name and kind, and what to fill it with. */
export interface NewScreen {
  name: string
  kind: 'edge' | 'device'
  /**
   * A device's viewport in its orientation, in CSS px; ignored for an Edge screen. Required for a
   * device, and large enough for at least one 40 px column and one row under the bar.
   */
  viewport?: { width: number; height: number }
  orientation?: 'landscape' | 'portrait'
  /**
   * Pages and bar to start from, placing existing widgets; `from` is the screen they come from.
   * They must already be arranged for the new screen's grid — `arrangeInto` (`./arrange`) is what
   * produces them, and what the preview shows. `addScreen` does not re-check that they fit.
   */
  prefill: { from: string; pages: Page[]; nav: NavItem[] } | null
}

/** What `updateNavWidget` takes: the bar entry's own keys, and the shared widget's settings. */
export type NavWidgetPatch = Partial<Pick<NavItem, 'slot' | 'popup'>> & { settings?: Record<string, unknown> }

export interface StoreDeps {
  api: AdminApi
  subscribeConfig: (cb: (cfg: Config) => void) => () => void
  debounceMs?: number
}

export interface AdminStore {
  state: AdminState
  screen: ComputedRef<Screen | null>
  page: ComputedRef<Page | null>
  selected: ComputedRef<WidgetInstance | null>
  /** Every selected tile of the page, joined with its widget: one for a single selection. */
  selectedTiles: ComputedRef<WidgetInstance[]>
  grid: ComputedRef<Grid>
  canUndo: ComputedRef<boolean>
  canRedo: ComputedRef<boolean>
  load(): Promise<void>
  rescan(): Promise<void>
  apply(mutate: (cfg: Config) => void): void
  undo(): void
  redo(): void
  flush(): Promise<void>
  others(ignoreId?: string): Rect[]
  select(id: string | null): void
  /** Adds a tile of the page to the selection, or takes it out when it is in it: Shift/⌘-click. */
  toggleSelect(id: string): void
  /** Selects exactly these tiles of the page (those not on it are ignored): what the marquee draws. */
  selectMany(ids: string[]): void
  /** Every tile of the page: ⌘A. */
  selectAll(): void
  selectScreen(id: string): void
  selectPage(i: number): void
  setMode(mode: Mode): void
  openModal(name: ModalName): void
  /**
   * Opens Connections straight onto a new connection of `typeId`.
   *
   * The reason it exists: a widget that declares a connection is useless until one is created,
   * and its own settings form is where somebody notices. Sending them to a list and asking them
   * to find the right type among nine is where that attempt ends.
   */
  openNewConnection(typeId: string): void
  closeModal(): void
  setDragWidget(id: string | null): void
  dismissToast(): void
  dismissNotice(): void
  dismissInfo(): void
  /** Takes the editor to where the notice says the widget still is, and selects it. */
  goToNotice(): void
  setNavHeight(height: NavHeight): void
  addPage(): void
  renamePage(i: number, name: string): void
  duplicatePage(i: number): void
  removePage(i: number): void
  movePage(i: number, delta: number): void
  /**
   * Changes page `i`'s own background by a patch — a key set to `undefined` is dropped — or, given
   * null, removes it so the page shows the screen's again. A background left empty is removed too.
   */
  setPageBackground(i: number, patch: Partial<Background> | null): void
  /** Moves page `from` so it ends up at index `to`: what dropping a dragged page does. */
  reorderPage(from: number, to: number): void
  /**
   * A copy of page `i` at the end of another screen: its tiles become new widgets set up like
   * the originals — as `duplicatePage` makes them — laid out for that screen's grid, continuing
   * on further pages when they do not fit. Widgets too large for that grid are left out, and a
   * toast says so. The editor stays where it is.
   */
  copyPageToScreen(i: number, screenId: string): void
  /** `addWidget`, onto page `i` of this screen: the editor follows it there. Refused when full. */
  addWidgetToPage(widgetId: string, i: number): void
  /** True when a screen, a page or a widget of the config still shows the stored image `name`. */
  backgroundInUse(name: string): boolean
  placeWidget(widgetId: string, rect: Rect): void
  addWidget(widgetId: string): void
  placeExisting(instanceId: string, rect?: Rect): void
  updateInstance(instanceId: string, patch: Partial<WidgetInstance>): void
  /** How many widgets, across every screen, wear the imported icon `name`. */
  tileIconUsage(name: string): number
  /**
   * Takes the imported icon `name` off every tile that wears it, in one undo step, before the file
   * itself is deleted. Returns how many tiles lost it; 0 records nothing.
   */
  removeTileIconEverywhere(name: string): number
  duplicateWidget(instanceId: string): void
  moveWidget(instanceId: string, targetPageIndex: number): void
  /** A new page at the end of this screen, with the widget moved onto it: one step to undo. */
  moveWidgetToNewPage(instanceId: string): void
  /**
   * The same widget placed on another screen too — its first page with room — as the library's
   * "on your other screens" does. Refused when that screen already shows it or has no room.
   */
  showOnScreen(instanceId: string, screenId: string): void
  /** `showOnScreen`, then off this one: one step to undo. */
  moveToScreen(instanceId: string, screenId: string): void
  /** Resizes the tile in place; refused (a toast) when that size does not fit where it sits. */
  resizeWidget(instanceId: string, size: [number, number]): void
  /** Whether `resizeWidget` would accept that size, for a menu to grey what it would refuse. */
  canResize(instanceId: string, size: [number, number]): boolean
  /** Locks or unlocks this screen's placement: a locked tile is neither dragged nor resized. */
  setLocked(instanceId: string, locked: boolean): void
  /**
   * The keyboard's move: one tile of the page shifted by (dx, dy) cells, or — `resize` — grown or
   * shrunk by that much from its south-east corner, as the arrow keys and Shift+arrows do. The
   * rules are the drag's: kept inside the grid, never under the manifest's minimum size, refused
   * when it would land on another tile, and nothing at all for a locked tile. False when refused.
   *
   * `repeat` is a key held down: its steps join the press that started it in one undo step, so
   * one ⌘Z puts back what one hold moved.
   */
  nudgeWidget(instanceId: string, dx: number, dy: number, opts?: { resize?: boolean; repeat?: boolean }): boolean
  /**
   * Selects the next tile of the page (`delta` 1) or the previous one (-1), in reading order — top
   * to bottom, then left to right — wrapping at both ends. With none selected, the first or the
   * last. Null when the page has no tile.
   */
  cycleSelection(delta: 1 | -1): string | null
  copyWidget(instanceId: string): void
  /**
   * Several tiles moved together by (dx, dy) cells, as one block cut short at the grid's edge.
   * Locked tiles stay where they are and the others move without them; refused (false) when a
   * moved tile would land on one that stays, or when none of them may move. One undo step; with
   * `repeat` (a held arrow) it joins the step its first press started.
   */
  moveTiles(ids: string[], dx: number, dy: number, opts?: { repeat?: boolean }): boolean
  /** New widgets set up like these, placed together in the first spot of the page where the block fits. */
  duplicateTiles(ids: string[]): void
  /** `copyWidget` for several: the paste puts them back in the same arrangement. */
  copyTiles(ids: string[]): void
  /** Takes these tiles off this screen in one step; a widget shown nowhere else is deleted. */
  removeTiles(ids: string[]): void
  /** Moves these tiles together to another page of this screen, arranged as they are; refused when it has no room. */
  moveTilesToPage(ids: string[], targetPageIndex: number): void
  /** A new page at the end of this screen, with these tiles moved onto it where they were. */
  moveTilesToNewPage(ids: string[]): void
  /** `setLocked` for several, in one step. */
  setLockedTiles(ids: string[], locked: boolean): void
  /** The same patch to every one of these widgets — their look, never their place — in one step. */
  updateWidgets(ids: string[], patch: Partial<Widget>): void
  /**
   * A new widget set up like the copied one — settings and look — on the current page, at the
   * copied size or the largest that fits. False when there was nothing to paste or no room.
   */
  pasteWidget(): boolean
  copyStyle(instanceId: string): void
  pasteStyle(instanceId: string): void
  /** Back to the theme's look: no colours, no image, a solid surface. Settings are kept. */
  resetAppearance(instanceId: string): void
  reloadWidget(instanceId: string): void
  /**
   * Asks every page showing screen `screenId` — the Edge, a browser tab, a paired iPad — to reload.
   * Not an edit of the dashboard, so neither undoable nor saved: it says it was done, or why not.
   */
  reloadScreen(screenId: string): Promise<void>
  openAbout(instanceId: string): void
  /** Opens Connections on an existing connection's form. */
  openConnection(connectionId: string): void
  removeFromScreen(instanceId: string): void
  /** True when no other screen shows the widget: removing it from this one deletes it. */
  isLastPlace(instanceId: string): boolean
  addScreen(input: NewScreen): string
  renameScreen(id: string, name: string): void
  removeScreen(id: string): void
  addNavWidget(widgetId: string): void
  removeNavWidget(instanceId: string): void
  moveNavWidget(instanceId: string, delta: number): void
  updateNavWidget(instanceId: string, patch: NavWidgetPatch): void
}

const uid = (): string => Math.random().toString(36).slice(2, 8)
const rectOf = (w: Placement): Rect => ({ x: w.x, y: w.y, w: w.w, h: w.h })
/** A widget wearing the imported file `name`, tinted or not. */
const wearsFile = (w: Widget, name: string): boolean => w.icon?.kind === 'file' && w.icon.name === name
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
/** The keys of a patch that belong to a placement rather than to the shared widget. */
const GEOMETRY: (keyof Rect)[] = ['x', 'y', 'w', 'h']
/** Mirrors the server's limit on a screen name. */
const SCREEN_NAME_MAX = 60
/** The Edge's grid: 64 columns of 40 px cells. */
const EDGE_COLS = 64
const EDGE_CELL = 40
/**
 * What a pre-filled screen takes from the look of the one it came from. Not the bar's height: a
 * device screen keeps its own slim bar whatever its source has, and its rows were counted under it.
 */
const LOOK_KEYS = ['autoCycleSeconds', 'navOpacity', 'tileOpacity', 'adminGesture', 'background'] as const

/** Applies a patch, dropping the keys it sets to `undefined`: defaults are stored as absent keys. */
function patchInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete target[key]
    else target[key] = value
  }
}

/** A fresh instance id for a widget, never one the config already uses. */
/** Longest instance id the server accepts: `INSTANCE_ID_MAX` in server/src/config/schema.ts. */
const MAX_INSTANCE_ID = 64

/**
 * An instance id free in `cfg`: the widget id, cut so the whole stays within the server's 64
 * characters, then a dash and six random ones.
 */
export function freeInstanceId(cfg: Config, widgetId: string): string {
  const stem = widgetId.slice(0, MAX_INSTANCE_ID - 7)
  let id = `${stem}-${uid()}`
  while (Object.hasOwn(cfg.widgets, id)) id = `${stem}-${uid()}`
  return id
}

/** A page id free on that screen: `wanted` when it is, else a random one. */
export function freePageId(pages: Page[], wanted?: string): string {
  if (wanted && !pages.some((p) => p.id === wanted)) return wanted
  let id = 'page-' + uid()
  while (pages.some((p) => p.id === id)) id = 'page-' + uid()
  return id
}

/** A screen id from its name — the slug the server accepts — suffixed until it is free. */
export function freeScreenId(name: string, taken: string[]): string {
  const base = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/, '') || 'screen'
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** Deletes those of `ids` no screen shows any more: a widget lives only while it is placed. */
function dropUnplaced(cfg: Config, ids: string[]): void {
  for (const id of ids) {
    if (cfg.widgets[id] && !screensShowing(cfg, id).length) delete cfg.widgets[id]
  }
}

/** JSON with sorted keys, so two configs differing only in key order compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v)
}

export function createAdminStore(deps: StoreDeps): AdminStore {
  const debounceMs = deps.debounceMs ?? SAVE_DEBOUNCE_MS
  const state = reactive<AdminState>({
    newConnectionType: '', editConnectionId: '', aboutId: '',
    clipboard: null, styleClipboard: null, reloads: {},
    config: null, manifests: {}, sources: {}, asks: {}, platform: 'darwin', unavailable: [], catalogErrors: [],
    screenId: '', pageIndex: 0, selection: [], dragWidgetId: null,
    get selectedId(): string | null { return this.selection.length === 1 ? this.selection[0] : null },
    set selectedId(id: string | null) { this.selection = id ? [id] : [] },
    mode: 'edit', modal: null, status: 'saved', toast: '', notice: null, info: '', degraded: false,
  })
  // Reactive arrays: canUndo/canRedo read their .length, and a plain array here would give
  // those computed refs no tracked dependency, so they'd never invalidate after the first read.
  const undoStack: Config[] = reactive([])
  const redoStack: Config[] = reactive([])
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSent = ''
  // Single-flight guard for putConfig. `inFlight` is true while a PUT is in the air; a mutation
  // that arrives during that window must never start a second, concurrent PUT (their responses
  // could land out of order and a stale one would overwrite a newer edit). Instead it sets
  // `dirty`, and the in-flight request's `finally` starts exactly one follow-up PUT — carrying
  // whatever the config looks like at that moment — once the first has settled. `current` lets
  // flush() wait for that whole in-flight-plus-retry chain, not just the first request.
  let inFlight = false
  let dirty = false
  let current: Promise<void> = Promise.resolve()
  // Bumped by every local mutation, so an await can tell whether the config moved under it.
  let localVersion = 0

  /**
   * The screen being edited: the selected one, or — before one is chosen, or once it is gone —
   * the one the Edge shows. Reading through `pickScreen` means a config set directly (a test, a
   * restore) is editable at once, before anything has synced `screenId`.
   */
  const screen = computed<Screen | null>(() => (state.config ? pickScreen(state.config, state.screenId || null) ?? null : null))
  const page = computed<Page | null>(() => screen.value?.pages[state.pageIndex] ?? null)
  /** The selected tile, joined with its shared widget: what the inspector and the keyboard edit. */
  const selected = computed<WidgetInstance | null>(() => {
    const placement = page.value?.items.find((p) => p.instanceId === state.selectedId)
    return placement && state.config ? tileOf(state.config, placement) : null
  })
  const selectedTiles = computed<WidgetInstance[]>(() => {
    const cfg = state.config
    const items = page.value?.items ?? []
    if (!cfg) return []
    return state.selection.flatMap((id) => {
      const placement = items.find((p) => p.instanceId === id)
      return placement ? [tileOf(cfg, placement)] : []
    })
  })
  const grid = computed<Grid>(() => ({ cols: screen.value?.display.cols ?? 64, rows: screen.value?.display.rows ?? 16 }))
  const canUndo = computed(() => undoStack.length > 0)
  const canRedo = computed(() => redoStack.length > 0)

  const snapshot = (): Config => JSON.parse(JSON.stringify(state.config)) as Config
  const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  /**
   * Keeps the screen, page and selection pointing at things that exist. A screen that went away
   * (an undo, a push from another tab) falls back to the Edge's, on its first page.
   */
  function clampSelection(): void {
    const scr = screen.value
    if (!scr) return
    if (state.screenId !== scr.id) { state.screenId = scr.id; state.pageIndex = 0 }
    state.pageIndex = Math.max(0, Math.min(state.pageIndex, scr.pages.length - 1))
    const onPage = new Set((page.value?.items ?? []).map((p) => p.instanceId))
    if (state.selection.some((id) => !onPage.has(id))) state.selection = state.selection.filter((id) => onPage.has(id))
  }

  /** The edited screen inside the config a mutation is handed. */
  const here = (cfg: Config): Screen => cfg.screens.find((x) => x.id === screen.value!.id)!
  /** What the user calls a widget: its own title, else its manifest's name. */
  const nameOf = (w: Widget): string => w.title?.trim() || pick(state.manifests[w.widgetId]?.name) || w.widgetId
  /**
   * Of the widgets about to leave screen `leaving`, those another screen still shows, as a notice
   * naming the first one's place (a page there, else that screen's bar). Read before the edit.
   */
  const stillShown = (cfg: Config, ids: string[], leaving: string): StillShown | null => {
    const kept = ids.filter((id) => cfg.widgets[id] && screensShowing(cfg, id).some((x) => x.id !== leaving))
    if (!kept.length) return null
    const id = kept[0]
    const where = screensShowing(cfg, id).find((x) => x.id !== leaving)!
    const pageIndex = where.pages.findIndex((p) => p.items.some((x) => x.instanceId === id))
    return {
      name: nameOf(cfg.widgets[id]), count: kept.length, instanceId: id,
      screenId: where.id, screenName: where.name,
      pageIndex: pageIndex >= 0 ? pageIndex : null, pageName: pageIndex >= 0 ? where.pages[pageIndex].name : null,
    }
  }

  async function send(): Promise<void> {
    if (!state.config) return
    const body = snapshot()
    try {
      lastSent = stable(body)
      await deps.api.putConfig(body)
      // Only settle to 'saved' when nothing newer is queued (a debounce timer) or already
      // pending (dirty, about to be retried by kick()'s finally below).
      if (!dirty && !timer) state.status = 'saved'
    } catch (e) {
      state.status = 'error'
      state.toast = errorMessage(e)
      // A refusal may mean the server can no longer read the file: re-read the flag so the
      // banner appears and further edits stop being pushed.
      try { state.degraded = (await deps.api.getStatus()).degraded } catch { /* keep the last known state */ }
      // A newer edit already landed during this PUT (kick() retries it below), or the server is
      // serving defaults it could not read from disk — either way, never reload over the user.
      if (dirty || state.degraded) return
      // No newer edit is pending: the undo history no longer matches the server, and the
      // safest move is to resync with whatever the server actually has. If that resync also
      // fails, keep the original error visible and leave the local config untouched rather
      // than losing the user's in-progress edits.
      undoStack.length = 0
      redoStack.length = 0
      try {
        const before = localVersion
        const fresh = await deps.api.getConfig()
        // The user kept editing while that GET was in the air. Their work is newer than the
        // server's answer, so we keep it, stay in 'error' with the toast, and let the edit's
        // own pending send carry it to the server.
        // The failure is still the latest news until that retry lands, so keep showing it.
        if (localVersion !== before) { state.status = 'error'; return }
        state.config = fresh
        lastSent = stable(fresh)
        state.status = 'saved'
        clampSelection()
      } catch {
        // Recovery failed too: status stays 'error', toast keeps the save error,
        // local config is left as is.
      }
    }
  }

  /** Single-flight dispatcher: starts a PUT, or flags one to retry if one is already in flight. */
  function kick(): void {
    if (inFlight) { dirty = true; return }
    inFlight = true
    dirty = false
    current = send().finally(() => {
      inFlight = false
      if (dirty) kick()
    })
  }

  function schedule(): void {
    localVersion++
    if (state.degraded) {
      // Saving is off until the file on disk is fixed; the banner already says so.
      state.status = 'error'
      state.toast = degradedMessage()
      return
    }
    if (timer) clearTimeout(timer)
    state.status = 'saving'
    timer = setTimeout(() => { timer = undefined; kick() }, debounceMs)
  }

  /**
   * The step the last `apply` belonged to, when it may be continued (a key held down), else null.
   * An apply under the same name joins that undo step instead of starting one; any other apply,
   * an undo or a redo ends it.
   */
  let openStep: string | null = null

  function apply(mutate: (cfg: Config) => void, step: { name: string; join: boolean } | null = null): void {
    if (!state.config) return
    // An emptied history (a reload, a push from another tab) has no step left to join.
    if (!(step?.join && openStep === step.name && undoStack.length)) {
      undoStack.push(snapshot())
      if (undoStack.length > UNDO_LIMIT) undoStack.shift()
    }
    openStep = step?.name ?? null
    redoStack.length = 0
    mutate(state.config)
    clampSelection()
    schedule()
  }

  // The whole admin follows the config's language: loading one, undoing to one, or receiving one
  // over the config channel all go through `state.config`, so one watcher covers every path.
  watch(() => state.config?.locale, (next) => setLocale(next), { immediate: true })

  deps.subscribeConfig((cfg) => {
    // A pending or in-flight local save wins: never clobber what the user is editing.
    if (timer || state.status !== 'saved') return
    const next = stable(cfg)
    if (next === lastSent || (state.config && next === stable(state.config))) return
    state.config = cfg
    lastSent = next
    undoStack.length = 0
    redoStack.length = 0
    clampSelection()
  })

  /**
   * Where `showOnScreen` puts a widget on another screen: the first of its pages with room, at the
   * tile's size here when that screen's grid takes it, else its manifest's default, shrunk towards
   * its minimum. Null (with a toast saying why) when the screen already shows it or is full.
   */
  function spotOnScreen(instanceId: string, screenId: string): { page: number; rect: Rect } | null {
    const cfg = state.config
    const target = cfg?.screens.find((x) => x.id === screenId)
    const widget = cfg?.widgets[instanceId]
    if (!cfg || !target || !widget || target.id === screen.value?.id) return null
    if (screensShowing(cfg, instanceId).some((x) => x.id === screenId)) {
      state.toast = t('admin.store.alreadyOnThatScreen', { name: nameOf(widget), screen: target.name })
      return null
    }
    const manifest = state.manifests[widget.widgetId]
    const min = manifest?.minSize ?? [1, 1]
    const src = page.value?.items.find((p) => p.instanceId === instanceId)
    const targetGrid: Grid = { cols: target.display.cols, rows: target.display.rows }
    const size: [number, number] = src && src.w <= targetGrid.cols && src.h <= targetGrid.rows
      ? [src.w, src.h]
      : manifest?.defaultSize ?? min
    for (let i = 0; i < target.pages.length; i++) {
      const rect = largestFreeSpot(size, min, targetGrid, target.pages[i].items.map(rectOf))
      if (rect) return { page: i, rect }
    }
    state.toast = t('admin.store.noRoomOnScreen', { screen: target.name, name: nameOf(widget) })
    return null
  }

  const store: AdminStore = {
    state, screen, page, selected, selectedTiles, grid, canUndo, canRedo,

    async load(): Promise<void> {
      const [cfg, widgets, status] = await Promise.all([deps.api.getConfig(), deps.api.getWidgets(), deps.api.getStatus()])
      state.config = cfg
      state.degraded = status.degraded
      lastSent = stable(cfg)
      state.manifests = widgets.widgets
      state.sources = widgets.sources
      state.asks = widgets.asks
      state.platform = widgets.platform
      state.unavailable = widgets.unavailable
      state.catalogErrors = widgets.errors
      undoStack.length = 0
      redoStack.length = 0
      state.status = 'saved'
      clampSelection()
    },

    async rescan(): Promise<void> {
      const widgets = await deps.api.rescan()
      state.manifests = widgets.widgets
      state.sources = widgets.sources
      state.asks = widgets.asks
      state.platform = widgets.platform
      state.unavailable = widgets.unavailable
      state.catalogErrors = widgets.errors
    },

    apply: (mutate) => apply(mutate),

    undo(): void {
      openStep = null
      const prev = undoStack.pop()
      if (!prev) return
      redoStack.push(snapshot())
      state.config = prev
      clampSelection()
      schedule()
    },

    redo(): void {
      openStep = null
      const next = redoStack.pop()
      if (!next) return
      undoStack.push(snapshot())
      state.config = next
      clampSelection()
      schedule()
    },

    async flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = undefined; kick() }
      if (!inFlight) return
      while (inFlight) await current
    },

    others(ignoreId?: string): Rect[] {
      return (page.value?.items ?? []).filter((w) => w.instanceId !== ignoreId).map(rectOf)
    },

    select(id: string | null): void { state.selectedId = id },

    toggleSelect(id: string): void {
      if (!page.value?.items.some((p) => p.instanceId === id)) return
      state.selection = state.selection.includes(id) ? state.selection.filter((x) => x !== id) : [...state.selection, id]
    },

    selectMany(ids: string[]): void {
      const onPage = new Set((page.value?.items ?? []).map((p) => p.instanceId))
      const next = [...new Set(ids)].filter((id) => onPage.has(id))
      if (next.length !== state.selection.length || next.some((id, i) => state.selection[i] !== id)) state.selection = next
    },

    selectAll(): void {
      state.selection = (page.value?.items ?? []).map((p) => p.instanceId)
    },
    selectPage(i: number): void { state.pageIndex = i; state.selectedId = null },
    setMode(mode: Mode): void { state.mode = mode; if (mode === 'test') state.selectedId = null },
    openModal(name: ModalName): void { state.modal = name; state.newConnectionType = ''; state.editConnectionId = '' },
    openNewConnection(typeId: string): void { store.openModal('connections'); state.newConnectionType = typeId },
    openConnection(connectionId: string): void { store.openModal('connections'); state.editConnectionId = connectionId },
    openAbout(instanceId: string): void { store.openModal('about'); state.aboutId = instanceId },
    closeModal(): void { state.modal = null },
    setDragWidget(id: string | null): void { state.dragWidgetId = id },
    dismissToast(): void { state.toast = '' },
    dismissNotice(): void { state.notice = null },
    dismissInfo(): void { state.info = '' },
    /** Takes the editor to where a notice says the widget still is, and selects it. */
    goToNotice(): void {
      const n = state.notice
      state.notice = null
      if (!n || !state.config?.widgets[n.instanceId]) return
      store.selectScreen(n.screenId)
      if (n.pageIndex !== null) store.selectPage(n.pageIndex)
      state.selectedId = n.instanceId
    },

    selectScreen(id: string): void {
      if (!state.config?.screens.some((x) => x.id === id)) return
      state.screenId = id
      state.pageIndex = 0
      state.selectedId = null
    },

    /**
     * The nav bar and the board share the screen: a shorter bar gives the grid more rows, a
     * taller one takes them back. On the Edge that is the fixed 16/17; a device screen recomputes
     * them from the viewport it reported. Taking rows back is only possible while they are empty —
     * widgets are never pushed out of the grid, the change is refused instead.
     */
    setNavHeight(height: NavHeight): void {
      const scr = screen.value
      if (!scr) return
      const viewport = scr.display.viewport
      const rows = scr.kind === 'device' && viewport
        ? Math.max(1, deviceGrid(viewport.width, viewport.height, height).rows)
        : ROWS_BY_NAV_HEIGHT[height]
      if (rows < scr.display.rows && scr.pages.some((p) => p.items.some((w) => w.y + w.h > rows))) {
        state.toast = t('admin.store.lastRowOccupied')
        return
      }
      apply((c) => {
        const display = here(c).display
        // The default is stored as an absent key, so switching back leaves no trace in the file.
        if (height === DEFAULT_NAV_HEIGHT) delete display.navHeight
        else display.navHeight = height
        display.rows = rows
      })
    },

    addPage(): void {
      apply((c) => {
        const pages = here(c).pages
        pages.push({ id: freePageId(pages), name: t('admin.store.newPage'), items: [] })
        state.pageIndex = pages.length - 1
        state.selectedId = null
      })
    },

    renamePage(i: number, name: string): void {
      apply((c) => { here(c).pages[i].name = name })
    },

    /** The copy's tiles are new widgets, set up like the originals: editing one leaves the other alone. */
    duplicatePage(i: number): void {
      apply((c) => {
        const pages = here(c).pages
        const src = pages[i]
        const items: Placement[] = []
        for (const p of src.items) {
          const widget = c.widgets[p.instanceId]
          if (!widget) continue
          const id = freeInstanceId(c, widget.widgetId)
          c.widgets[id] = clone(widget)
          items.push({ ...p, instanceId: id })
        }
        pages.splice(i + 1, 0, {
          id: freePageId(pages), name: t('admin.store.pageCopy', { name: src.name }), items,
          ...(src.background ? { background: clone(src.background) } : {}),
        })
        state.pageIndex = i + 1
        state.selectedId = null
      })
    },

    /** The widgets that page alone showed go with it; those shown elsewhere stay. */
    removePage(i: number): void {
      if ((screen.value?.pages.length ?? 0) <= 1) { state.toast = t('admin.store.lastPage'); return }
      apply((c) => {
        const [removed] = here(c).pages.splice(i, 1)
        dropUnplaced(c, removed.items.map((p) => p.instanceId))
        if (state.pageIndex >= i) state.pageIndex = Math.max(0, state.pageIndex - 1)
        state.selectedId = null
      })
    },

    movePage(i: number, delta: number): void {
      const pages = screen.value?.pages
      const j = i + delta
      if (!pages || j < 0 || j >= pages.length) return
      apply((c) => {
        const list = here(c).pages
        const [moved] = list.splice(i, 1)
        list.splice(j, 0, moved)
        if (state.pageIndex === i) state.pageIndex = j
        else if (state.pageIndex === j) state.pageIndex = i
      })
    },

    setPageBackground(i: number, patch: Partial<Background> | null): void {
      if (!screen.value?.pages[i]) return
      apply((c) => {
        const target = here(c).pages[i]
        const next: Record<string, unknown> = patch ? { ...target.background, ...patch } : {}
        for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
        if (Object.keys(next).length) target.background = next as Background
        else delete target.background
      })
    },

    reorderPage(from: number, to: number): void {
      const pages = screen.value?.pages
      if (!pages || from === to || !pages[from] || to < 0 || to >= pages.length) return
      const shown = pages[state.pageIndex]?.id
      apply((c) => {
        const list = here(c).pages
        const [moved] = list.splice(from, 1)
        list.splice(to, 0, moved)
        // The editor keeps showing the page it showed, wherever that page now sits.
        state.pageIndex = Math.max(0, list.findIndex((p) => p.id === shown))
      })
    },

    copyPageToScreen(i: number, screenId: string): void {
      const cfg = state.config
      const src = screen.value?.pages[i]
      const target = cfg?.screens.find((x) => x.id === screenId)
      if (!cfg || !src || !target || target.id === screen.value?.id) return
      let leftOut = 0
      apply((c) => {
        const to = c.screens.find((x) => x.id === screenId)!
        // New widgets first, set up like the originals, so the arrangement can place them.
        const items: Placement[] = []
        const made: string[] = []
        for (const p of src.items) {
          const widget = c.widgets[p.instanceId]
          if (!widget) continue
          const id = freeInstanceId(c, widget.widgetId)
          c.widgets[id] = clone(widget)
          made.push(id)
          items.push({ ...clone(p), instanceId: id })
        }
        const copy: Page = { id: src.id, name: src.name, items, ...(src.background ? { background: clone(src.background) } : {}) }
        const laid = arrangeInto(
          { ...to, nav: [], pages: [copy] },
          { cols: to.display.cols, rows: to.display.rows, navCols: to.display.cols, navHeight: to.display.navHeight },
          c.widgets, state.manifests,
        )
        for (const p of laid.pages) to.pages.push({ ...p, id: freePageId(to.pages, p.id) })
        dropUnplaced(c, made)
        leftOut = laid.leftOut.length
      })
      state.toast = leftOut
        ? t('admin.store.pageCopiedLeftOut', { page: src.name, screen: target.name, n: leftOut })
        : t('admin.store.pageCopied', { page: src.name, screen: target.name })
    },

    addWidgetToPage(widgetId: string, i: number): void {
      const manifest = state.manifests[widgetId]
      const target = screen.value?.pages[i]
      if (!manifest) { state.toast = t('admin.store.unknownWidget', { id: widgetId }); return }
      if (!target) return
      const spot = largestFreeSpot(manifest.defaultSize, manifest.minSize, grid.value, target.items.map(rectOf))
      if (!spot) { state.toast = t('admin.store.noRoomOnPage', { page: target.name, id: pick(manifest.name) || widgetId }); return }
      store.selectPage(i)
      store.placeWidget(widgetId, spot)
    },

    backgroundInUse(name: string): boolean {
      const cfg = state.config
      if (!cfg) return false
      return cfg.screens.some((x) => x.display.background?.image === name || x.pages.some((p) => p.background?.image === name))
        || Object.values(cfg.widgets).some((w) => w.background?.image === name)
    },

    /** A new widget and its placement, in one mutation: the server drops a widget placed nowhere. */
    placeWidget(widgetId: string, rect: Rect): void {
      if (!fits(rect, grid.value, store.others())) { state.toast = t('admin.store.occupied'); return }
      apply((c) => {
        const scr = here(c)
        const instanceId = freeInstanceId(c, widgetId)
        c.widgets[instanceId] = {
          widgetId, showTitle: true, settings: {},
          // The screen's default for new tiles, copied rather than referenced: the widget owns it.
          ...(scr.display.tileOpacity !== undefined ? { opacity: scr.display.tileOpacity } : {}),
        }
        scr.pages[state.pageIndex].items.push({ instanceId, x: rect.x, y: rect.y, w: rect.w, h: rect.h })
        state.selectedId = instanceId
      })
    },

    addWidget(widgetId: string): void {
      const manifest = state.manifests[widgetId]
      if (!manifest) { state.toast = t('admin.store.unknownWidget', { id: widgetId }); return }
      const spot = largestFreeSpot(manifest.defaultSize, manifest.minSize, grid.value, store.others())
      if (!spot) { state.toast = t('admin.store.noRoom'); return }
      store.placeWidget(widgetId, spot)
    },

    /**
     * Places a widget that already exists — shown on another screen — on this screen's current
     * page: the same widget, settings and all. At `rect` when given, else at its manifest's
     * default size in the largest free spot. A screen shows a widget at most once.
     */
    placeExisting(instanceId: string, rect?: Rect): void {
      const cfg = state.config
      const scr = screen.value
      if (!cfg || !scr || !page.value) return
      const widget = cfg.widgets[instanceId]
      if (!widget) { state.toast = t('admin.store.unknownWidget', { id: instanceId }); return }
      if (screensShowing(cfg, instanceId).some((x) => x.id === scr.id)) {
        state.toast = t('admin.store.alreadyOnScreen', { name: nameOf(widget) })
        return
      }
      let spot: Rect | null = rect ?? null
      if (spot) {
        if (!fits(spot, grid.value, store.others())) { state.toast = t('admin.store.occupied'); return }
      } else {
        const manifest = state.manifests[widget.widgetId]
        const min = manifest?.minSize ?? [1, 1]
        spot = largestFreeSpot(manifest?.defaultSize ?? min, min, grid.value, store.others())
        if (!spot) { state.toast = t('admin.store.noRoom'); return }
      }
      const at = spot
      apply((c) => {
        here(c).pages[state.pageIndex].items.push({ instanceId, x: at.x, y: at.y, w: at.w, h: at.h })
        state.selectedId = instanceId
      })
    },

    /**
     * One patch, two homes: `x/y/w/h` move this screen's placement, everything else changes the
     * shared widget — and so every screen showing it. A key set to `undefined` is dropped.
     */
    updateInstance(instanceId: string, patch: Partial<WidgetInstance>): void {
      const geometry: Partial<Rect> = {}
      const rest: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'instanceId') continue
        if (GEOMETRY.includes(key as keyof Rect)) { if (value !== undefined) geometry[key as keyof Rect] = value as number }
        else rest[key] = value
      }
      apply((c) => {
        if (Object.keys(geometry).length) {
          for (const p of here(c).pages) {
            const placement = p.items.find((x) => x.instanceId === instanceId)
            if (placement) Object.assign(placement, geometry)
          }
        }
        const widget = c.widgets[instanceId]
        if (widget && Object.keys(rest).length) patchInto(widget as unknown as Record<string, unknown>, rest)
      })
    },

    tileIconUsage(name: string): number {
      return Object.values(state.config?.widgets ?? {}).filter((w) => wearsFile(w, name)).length
    },

    removeTileIconEverywhere(name: string): number {
      const count = store.tileIconUsage(name)
      if (!count) return 0
      apply((c) => {
        for (const w of Object.values(c.widgets)) if (wearsFile(w, name)) delete w.icon
      })
      return count
    },

    /** A new widget set up like the original, next to it on this page. */
    duplicateWidget(instanceId: string): void {
      const src = page.value?.items.find((p) => p.instanceId === instanceId)
      const widget = src && state.config?.widgets[instanceId]
      if (!src || !widget) return
      const min = state.manifests[widget.widgetId]?.minSize ?? [1, 1]
      const spot = largestFreeSpot([src.w, src.h], min, grid.value, store.others())
      if (!spot) { state.toast = t('admin.store.noRoom'); return }
      apply((c) => {
        const id = freeInstanceId(c, widget.widgetId)
        c.widgets[id] = clone(c.widgets[instanceId])
        here(c).pages[state.pageIndex].items.push({ instanceId: id, ...spot })
        state.selectedId = id
      })
    },

    /**
     * The same placement on another page of this screen: only its rectangle is recomputed, since
     * the target page has its own occupied cells. A page with no room refuses the move rather
     * than stacking tiles, and the editor follows the widget so the user sees where it landed.
     */
    moveWidget(instanceId: string, targetPageIndex: number): void {
      const cfg = state.config
      const src = page.value?.items.find((p) => p.instanceId === instanceId)
      const target = screen.value?.pages[targetPageIndex]
      if (!cfg || !src || !target || targetPageIndex === state.pageIndex) return
      const widgetId = cfg.widgets[instanceId]?.widgetId ?? ''
      const manifest = state.manifests[widgetId]
      const spot = largestFreeSpot([src.w, src.h], manifest?.minSize ?? [1, 1], grid.value, target.items.map(rectOf))
      if (!spot) {
        state.toast = t('admin.store.noRoomOnPage', { page: target.name, id: pick(manifest?.name) || widgetId })
        return
      }
      apply((c) => {
        const pages = here(c).pages
        const items = pages[state.pageIndex].items
        const i = items.findIndex((p) => p.instanceId === instanceId)
        if (i < 0) return
        const [moved] = items.splice(i, 1)
        pages[targetPageIndex].items.push({ instanceId, ...spot, ...(moved.locked ? { locked: true } : {}) })
        state.pageIndex = targetPageIndex
        state.selectedId = instanceId
      })
    },

    moveWidgetToNewPage(instanceId: string): void {
      const src = page.value?.items.find((p) => p.instanceId === instanceId)
      if (!src) return
      apply((c) => {
        const pages = here(c).pages
        const items = pages[state.pageIndex].items
        const i = items.findIndex((p) => p.instanceId === instanceId)
        if (i < 0) return
        const [moved] = items.splice(i, 1)
        // An empty page has room for any tile that fitted the grid already, so it keeps its spot.
        pages.push({ id: freePageId(pages), name: t('admin.store.newPage'), items: [moved] })
        state.pageIndex = pages.length - 1
        state.selectedId = instanceId
      })
    },

    showOnScreen(instanceId: string, screenId: string): void {
      const at = spotOnScreen(instanceId, screenId)
      if (!at) return
      apply((c) => {
        c.screens.find((x) => x.id === screenId)!.pages[at.page].items.push({ instanceId, ...at.rect })
      })
    },

    moveToScreen(instanceId: string, screenId: string): void {
      const at = spotOnScreen(instanceId, screenId)
      if (!at) return
      apply((c) => {
        c.screens.find((x) => x.id === screenId)!.pages[at.page].items.push({ instanceId, ...at.rect })
        const scr = here(c)
        for (const p of scr.pages) {
          const i = p.items.findIndex((x) => x.instanceId === instanceId)
          if (i >= 0) p.items.splice(i, 1)
        }
        const n = scr.nav.findIndex((x) => x.instanceId === instanceId)
        if (n >= 0) scr.nav.splice(n, 1)
        if (state.selectedId === instanceId) state.selectedId = null
      })
    },

    canResize(instanceId: string, size: [number, number]): boolean {
      const src = page.value?.items.find((p) => p.instanceId === instanceId)
      if (!src || src.locked) return false
      return fits({ x: src.x, y: src.y, w: size[0], h: size[1] }, grid.value, store.others(instanceId))
    },

    resizeWidget(instanceId: string, size: [number, number]): void {
      const src = page.value?.items.find((p) => p.instanceId === instanceId)
      if (!src || (src.w === size[0] && src.h === size[1])) return
      if (src.locked) { state.toast = t('admin.store.locked'); return }
      if (!store.canResize(instanceId, size)) { state.toast = t('admin.store.occupied'); return }
      store.updateInstance(instanceId, { w: size[0], h: size[1] })
    },

    setLocked(instanceId: string, locked: boolean): void {
      if (!page.value?.items.some((p) => p.instanceId === instanceId)) return
      apply((c) => {
        for (const p of here(c).pages) {
          const placement = p.items.find((x) => x.instanceId === instanceId)
          // Unlocked is stored as an absent key, the way the file had it before locks existed.
          if (placement) { if (locked) placement.locked = true; else delete placement.locked }
        }
      })
    },

    nudgeWidget(instanceId: string, dx: number, dy: number, opts: { resize?: boolean; repeat?: boolean } = {}): boolean {
      const placement = page.value?.items.find((p) => p.instanceId === instanceId)
      const widget = state.config?.widgets[instanceId]
      if (!placement || !widget || placement.locked) return false
      const start = rectOf(placement)
      const min = state.manifests[widget.widgetId]?.minSize ?? [1, 1]
      const next = opts.resize
        ? resizeRect(start, 'se', dx, dy, min, grid.value)
        : moveRect(start, dx, dy, grid.value)
      if (GEOMETRY.every((k) => next[k] === start[k])) return false
      if (!fits(next, grid.value, store.others(instanceId))) return false
      const pageId = page.value!.id
      apply((c) => {
        const target = here(c).pages.find((p) => p.id === pageId)?.items.find((x) => x.instanceId === instanceId)
        if (target) Object.assign(target, next)
      }, { name: `nudge:${opts.resize ? 'resize' : 'move'}:${instanceId}`, join: !!opts.repeat })
      return true
    },

    cycleSelection(delta: 1 | -1): string | null {
      const items = [...(page.value?.items ?? [])].sort((a, b) => a.y - b.y || a.x - b.x)
      if (!items.length) return null
      const at = items.findIndex((p) => p.instanceId === state.selectedId)
      const i = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length
      state.selectedId = items[i].instanceId
      return state.selectedId
    },

    copyWidget(instanceId: string): void {
      store.copyTiles([instanceId])
    },

    copyTiles(ids: string[]): void {
      const cfg = state.config
      const tiles = (page.value?.items ?? []).filter((p) => ids.includes(p.instanceId) && cfg?.widgets[p.instanceId])
      if (!cfg || !tiles.length) return
      const x0 = Math.min(...tiles.map((p) => p.x))
      const y0 = Math.min(...tiles.map((p) => p.y))
      state.clipboard = tiles.map((p) => ({ widget: clone(cfg.widgets[p.instanceId]), size: [p.w, p.h], at: [p.x - x0, p.y - y0] }))
    },

    pasteWidget(): boolean {
      const copied = state.clipboard
      if (!copied?.length || !state.config || !page.value) return false
      // One tile: the largest spot down to its minimum size, as it has always been.
      if (copied.length === 1) {
        const [one] = copied
        const min = state.manifests[one.widget.widgetId]?.minSize ?? [1, 1]
        const spot = largestFreeSpot(one.size, min, grid.value, store.others())
        if (!spot) { state.toast = t('admin.store.noRoom'); return false }
        apply((c) => {
          const id = freeInstanceId(c, one.widget.widgetId)
          c.widgets[id] = clone(one.widget)
          here(c).pages[state.pageIndex].items.push({ instanceId: id, ...spot })
          state.selectedId = id
        })
        return true
      }
      // A group: as one block, in the arrangement it was copied in, or not at all.
      const rects = copied.map((x) => ({ x: x.at[0], y: x.at[1], w: x.size[0], h: x.size[1] }))
      const shift = firstFreeBlock(rects, grid.value, store.others())
      if (!shift) { state.toast = t('admin.store.noRoomGroup'); return false }
      apply((c) => {
        const items = here(c).pages[state.pageIndex].items
        const made: string[] = []
        copied.forEach((x, i) => {
          const id = freeInstanceId(c, x.widget.widgetId)
          c.widgets[id] = clone(x.widget)
          items.push({ instanceId: id, ...shiftAll([rects[i]], shift.dx, shift.dy)[0] })
          made.push(id)
        })
        state.selection = made
      })
      return true
    },

    moveTiles(ids: string[], dx: number, dy: number, opts: { repeat?: boolean } = {}): boolean {
      const items = page.value?.items ?? []
      const moving = items.filter((p) => ids.includes(p.instanceId) && !p.locked)
      if (!moving.length) return false
      const step = groupDelta(moving.map(rectOf), dx, dy, grid.value)
      if (!step.dx && !step.dy) return false
      const ids2 = new Set(moving.map((p) => p.instanceId))
      const staying = items.filter((p) => !ids2.has(p.instanceId)).map(rectOf)
      if (!shiftAll(moving.map(rectOf), step.dx, step.dy).every((r) => fits(r, grid.value, staying))) return false
      const pageId = page.value!.id
      apply((c) => {
        for (const p of here(c).pages.find((x) => x.id === pageId)?.items ?? []) {
          if (ids2.has(p.instanceId)) { p.x += step.dx; p.y += step.dy }
        }
      }, { name: `nudge:group:${[...ids2].sort().join(',')}`, join: !!opts.repeat })
      return true
    },

    duplicateTiles(ids: string[]): void {
      const cfg = state.config
      const tiles = (page.value?.items ?? []).filter((p) => ids.includes(p.instanceId) && cfg?.widgets[p.instanceId])
      if (!cfg || !tiles.length) return
      if (tiles.length === 1) { store.duplicateWidget(tiles[0].instanceId); return }
      const shift = firstFreeBlock(tiles.map(rectOf), grid.value, store.others())
      if (!shift) { state.toast = t('admin.store.noRoomGroup'); return }
      apply((c) => {
        const items = here(c).pages[state.pageIndex].items
        const made: string[] = []
        for (const p of tiles) {
          const id = freeInstanceId(c, c.widgets[p.instanceId].widgetId)
          c.widgets[id] = clone(c.widgets[p.instanceId])
          items.push({ instanceId: id, ...shiftAll([rectOf(p)], shift.dx, shift.dy)[0] })
          made.push(id)
        }
        state.selection = made
      })
    },

    removeTiles(ids: string[]): void {
      if (!ids.length) return
      const cfg = state.config
      const leaving = screen.value?.id ?? ''
      const notice = cfg ? stillShown(cfg, ids, leaving) : null
      apply((c) => {
        const scr = here(c)
        for (const p of scr.pages) p.items = p.items.filter((x) => !ids.includes(x.instanceId))
        scr.nav = scr.nav.filter((x) => !ids.includes(x.instanceId))
        dropUnplaced(c, ids)
        state.selection = state.selection.filter((id) => !ids.includes(id))
      })
      state.notice = notice
    },

    moveTilesToPage(ids: string[], targetPageIndex: number): void {
      const tiles = (page.value?.items ?? []).filter((p) => ids.includes(p.instanceId))
      const target = screen.value?.pages[targetPageIndex]
      if (!tiles.length || !target || targetPageIndex === state.pageIndex) return
      if (tiles.length === 1) { store.moveWidget(tiles[0].instanceId, targetPageIndex); return }
      const shift = firstFreeBlock(tiles.map(rectOf), grid.value, target.items.map(rectOf))
      if (!shift) { state.toast = t('admin.store.noRoomGroupOnPage', { page: target.name }); return }
      const moved = new Set(tiles.map((p) => p.instanceId))
      apply((c) => {
        const pages = here(c).pages
        const from = pages[state.pageIndex]
        const taken = from.items.filter((p) => moved.has(p.instanceId))
        from.items = from.items.filter((p) => !moved.has(p.instanceId))
        for (const p of taken) pages[targetPageIndex].items.push({ ...p, x: p.x + shift.dx, y: p.y + shift.dy })
        state.pageIndex = targetPageIndex
        state.selection = taken.map((p) => p.instanceId)
      })
    },

    moveTilesToNewPage(ids: string[]): void {
      const moved = new Set((page.value?.items ?? []).filter((p) => ids.includes(p.instanceId)).map((p) => p.instanceId))
      if (!moved.size) return
      apply((c) => {
        const pages = here(c).pages
        const from = pages[state.pageIndex]
        const taken = from.items.filter((p) => moved.has(p.instanceId))
        from.items = from.items.filter((p) => !moved.has(p.instanceId))
        // They fitted together where they were, so an empty page takes them there as they are.
        pages.push({ id: freePageId(pages), name: t('admin.store.newPage'), items: taken })
        state.pageIndex = pages.length - 1
        state.selection = taken.map((p) => p.instanceId)
      })
    },

    setLockedTiles(ids: string[], locked: boolean): void {
      const onPage = (page.value?.items ?? []).filter((p) => ids.includes(p.instanceId))
      if (!onPage.length) return
      apply((c) => {
        for (const p of here(c).pages) {
          for (const placement of p.items) {
            if (!ids.includes(placement.instanceId)) continue
            if (locked) placement.locked = true; else delete placement.locked
          }
        }
      })
    },

    updateWidgets(ids: string[], patch: Partial<Widget>): void {
      const cfg = state.config
      const targets = ids.filter((id) => cfg?.widgets[id])
      if (!targets.length) return
      apply((c) => {
        for (const id of targets) patchInto(c.widgets[id] as unknown as Record<string, unknown>, patch as Record<string, unknown>)
      })
    },

    copyStyle(instanceId: string): void {
      const widget = state.config?.widgets[instanceId]
      if (!widget) return
      const style: WidgetStyle = {}
      for (const key of STYLE_KEYS) if (widget[key] !== undefined) (style as Record<string, unknown>)[key] = clone(widget[key])
      state.styleClipboard = style
    },

    pasteStyle(instanceId: string): void {
      const style = state.styleClipboard
      if (!style || !state.config?.widgets[instanceId]) return
      // Every style key is written, the absent ones as undefined: the target takes the copied
      // look as a whole rather than keeping a colour the source did not have.
      const patch: Partial<Widget> = {}
      for (const key of STYLE_KEYS) (patch as Record<string, unknown>)[key] = style[key] === undefined ? undefined : clone(style[key])
      store.updateInstance(instanceId, patch)
    },

    resetAppearance(instanceId: string): void {
      if (!state.config?.widgets[instanceId]) return
      store.updateInstance(instanceId, Object.fromEntries(STYLE_KEYS.map((k) => [k, undefined])) as Partial<Widget>)
    },

    reloadWidget(instanceId: string): void {
      state.reloads[instanceId] = (state.reloads[instanceId] ?? 0) + 1
    },

    async reloadScreen(screenId: string): Promise<void> {
      const name = state.config?.screens.find((x) => x.id === screenId)?.name
      if (name === undefined || !deps.api.reloadScreen) return
      try {
        await deps.api.reloadScreen(screenId)
        state.info = t('admin.notice.screenReloaded', { screen: name })
      } catch (e) {
        state.toast = errorMessage(e)
      }
    },

    /**
     * Takes the widget off this screen — its tile or its bar entry. When no other screen shows it,
     * that was its last place and the widget itself goes: the editor asks before calling this then.
     */
    removeFromScreen(instanceId: string): void {
      const cfg = state.config
      const notice = cfg ? stillShown(cfg, [instanceId], screen.value?.id ?? '') : null
      apply((c) => {
        const scr = here(c)
        for (const p of scr.pages) {
          const i = p.items.findIndex((x) => x.instanceId === instanceId)
          if (i >= 0) p.items.splice(i, 1)
        }
        const n = scr.nav.findIndex((x) => x.instanceId === instanceId)
        if (n >= 0) scr.nav.splice(n, 1)
        dropUnplaced(c, [instanceId])
        if (state.selectedId === instanceId) state.selectedId = null
      })
      state.notice = notice
    },

    isLastPlace(instanceId: string): boolean {
      const cfg = state.config
      const scr = screen.value
      if (!cfg || !scr) return true
      return !screensShowing(cfg, instanceId).some((x) => x.id !== scr.id)
    },

    /**
     * A new screen, selected at once. A device screen takes its grid from the viewport it reported,
     * under the slim 40 px bar it gets (`DEVICE_NAV_HEIGHT`); an Edge screen takes the Edge's. A pre-fill places existing
     * widgets — shared, not copied — and brings the look of the screen it came from; whatever would
     * break the once-per-screen rule or overflow the bar is left out (an `arrangeInto` result never
     * has any). A device screen with no viewport, or one too small for a single cell, is refused.
     */
    addScreen(input: NewScreen): string {
      const cfg = state.config
      if (!cfg) return ''
      if (input.kind === 'device') {
        const vp = input.viewport
        const g = vp ? deviceGrid(vp.width, vp.height, DEVICE_NAV_HEIGHT) : null
        if (!vp || !g || !(g.cols >= 1) || !(g.rows >= 1)) { state.toast = t('admin.store.badViewport'); return '' }
      }
      const name = input.name.trim().slice(0, SCREEN_NAME_MAX) || t('admin.store.newScreen')
      const id = freeScreenId(name, cfg.screens.map((x) => x.id))
      const display: ScreenDisplay = input.kind === 'device' && input.viewport
        ? {
          ...deviceGrid(input.viewport.width, input.viewport.height, DEVICE_NAV_HEIGHT),
          cell: DEVICE_CELL, navHeight: DEVICE_NAV_HEIGHT, autoCycleSeconds: 0,
          viewport: { ...input.viewport },
          ...(input.orientation ? { orientation: input.orientation } : {}),
        }
        : { cols: EDGE_COLS, rows: ROWS_BY_NAV_HEIGHT[DEFAULT_NAV_HEIGHT], cell: EDGE_CELL, autoCycleSeconds: 0 }
      display.cols = Math.max(1, display.cols)
      display.rows = Math.max(1, display.rows)
      const from = input.prefill ? cfg.screens.find((x) => x.id === input.prefill!.from) : undefined
      if (from) {
        for (const key of LOOK_KEYS) {
          if (from.display[key] !== undefined) (display as unknown as Record<string, unknown>)[key] = clone(from.display[key])
        }
      }
      const seen = new Set<string>()
      const pages: Page[] = []
      for (const p of input.prefill?.pages ?? []) {
        const items = p.items.filter((x) => cfg.widgets[x.instanceId] && !seen.has(x.instanceId))
        for (const x of items) seen.add(x.instanceId)
        pages.push({
          id: freePageId(pages, p.id), name: p.name, items: items.map((x) => ({ ...x })),
          ...(p.background ? { background: clone(p.background) } : {}),
        })
      }
      if (!pages.length) pages.push({ id: freePageId(pages), name: t('admin.store.newPage'), items: [] })
      const added: Screen = { id, name, kind: input.kind, display, nav: [], pages }
      for (const item of input.prefill?.nav ?? []) {
        const widget = cfg.widgets[item.instanceId]
        if (!widget || seen.has(item.instanceId) || added.nav.length >= MAX_NAV_WIDGETS) continue
        const manifest = state.manifests[widget.widgetId]
        const width = compactWidth(manifest, mergeSettings(manifest, widget.settings))
        if (!width || !navHasRoom(added, cfg.widgets, state.manifests, width, item.slot)) continue
        seen.add(item.instanceId)
        added.nav.push({ ...item })
      }
      apply((c) => {
        c.screens.push(added)
        state.screenId = id
        state.pageIndex = 0
        state.selectedId = null
      })
      return id
    },

    renameScreen(id: string, name: string): void {
      const next = name.trim().slice(0, SCREEN_NAME_MAX)
      const scr = state.config?.screens.find((x) => x.id === id)
      if (!scr || !next || next === scr.name) return
      apply((c) => { c.screens.find((x) => x.id === id)!.name = next })
    },

    /** The widgets that screen alone showed are deleted with it. The last screen stays. */
    removeScreen(id: string): void {
      const cfg = state.config
      if (!cfg?.screens.some((x) => x.id === id)) return
      if (cfg.screens.length <= 1) { state.toast = t('admin.store.lastScreen'); return }
      apply((c) => {
        const i = c.screens.findIndex((x) => x.id === id)
        const [removed] = c.screens.splice(i, 1)
        dropUnplaced(c, [...removed.nav.map((x) => x.instanceId), ...removed.pages.flatMap((p) => p.items.map((x) => x.instanceId))])
        if (state.screenId === id) { state.screenId = ''; state.pageIndex = 0; state.selectedId = null }
      })
    },

    /**
     * The navigation bar only draws widgets whose manifest declares a compact rendering, and it
     * holds a handful at most — the server refuses anything else, so both are checked here and
     * reported as a toast rather than as a failed save. A new widget joins the left cluster; the
     * Screen tab moves it to the right one afterwards.
     */
    addNavWidget(widgetId: string): void {
      const manifest = state.manifests[widgetId]
      if (!manifest) { state.toast = t('admin.store.unknownWidget', { id: widgetId }); return }
      if (!manifest.compact) { state.toast = t('admin.store.notCompact', { id: widgetId }); return }
      const scr = screen.value
      if (!scr) return
      // The wider cluster sets both side tracks, keeping the page dots or names centred and visible.
      const width = compactWidth(manifest, mergeSettings(manifest, {}))
      if (scr.nav.length >= MAX_NAV_WIDGETS || !navHasRoom(scr, state.config!.widgets, state.manifests, width)) {
        state.toast = t('admin.store.navFull', { id: pick(manifest.name) || widgetId })
        return
      }
      apply((c) => {
        const instanceId = freeInstanceId(c, widgetId)
        c.widgets[instanceId] = { widgetId, showTitle: true, settings: {} }
        here(c).nav.push({ instanceId, slot: 'left' })
      })
    },

    /** The bar's own trash button: the same as removing a tile from this screen. */
    removeNavWidget(instanceId: string): void {
      store.removeFromScreen(instanceId)
    },

    /**
     * Reordering happens within a cluster: a widget swaps places with its neighbour on the same
     * side, whatever sits between them in the stored list. At either end of its own side it is
     * a no-op rather than a jump across the dots.
     */
    moveNavWidget(instanceId: string, delta: number): void {
      const list = screen.value?.nav ?? []
      const current = list.find((w) => w.instanceId === instanceId)
      if (!current) return
      const sameSide = list.filter((w) => w.slot === current.slot)
      const at = sameSide.indexOf(current)
      const to = at + delta
      if (to < 0 || to >= sameSide.length) return
      const i = list.indexOf(current)
      const j = list.indexOf(sameSide[to])
      apply((c) => {
        const nav = here(c).nav
        const moved = nav[i]
        nav[i] = nav[j]
        nav[j] = moved
      })
    },

    /**
     * `slot` and `popup` belong to this screen's bar entry; `settings` to the shared widget. A
     * change that widens this bar's wider cluster past its room is refused; one that does not is
     * let through even on a bar already over the limit, so an old over-full bar stays editable.
     * Other screens showing the widget are the server's to check, at save.
     */
    updateNavWidget(instanceId: string, patch: NavWidgetPatch): void {
      const { settings, ...itemPatch } = patch
      const cfg = state.config
      const scr = screen.value
      const current = scr?.nav.find((x) => x.instanceId === instanceId)
      if (!cfg || !scr || !current) return
      const widget = cfg.widgets[instanceId]
      const candidate: Screen = {
        ...scr, nav: scr.nav.map((x) => (x.instanceId === instanceId ? { ...x, ...itemPatch } : x)),
      }
      const candidateWidgets = widget && settings !== undefined
        ? { ...cfg.widgets, [instanceId]: { ...widget, settings } }
        : cfg.widgets
      const growsWiderSide = navWiderClusterWidth(candidate, candidateWidgets, state.manifests)
        > navWiderClusterWidth(scr, cfg.widgets, state.manifests)
      if (growsWiderSide && !navHasRoom(candidate, candidateWidgets, state.manifests, 0)) {
        const manifest = widget ? state.manifests[widget.widgetId] : undefined
        state.toast = t('admin.store.navFull', { id: pick(manifest?.name) || widget?.widgetId || instanceId })
        return
      }
      apply((c) => {
        const item = here(c).nav.find((x) => x.instanceId === instanceId)
        if (item && Object.keys(itemPatch).length) patchInto(item as unknown as Record<string, unknown>, itemPatch)
        const widget = c.widgets[instanceId]
        if (widget && settings !== undefined) widget.settings = settings
      })
    },
  }

  return store
}

let singleton: AdminStore | null = null

/** The admin's single store, wired to the real HTTP api and the `config` WebSocket channel. */
export function useAdminStore(): AdminStore {
  if (!singleton) {
    singleton = createAdminStore({
      api: realApi,
      subscribeConfig: (cb) => useSocket().subscribe('config', (data) => cb(data as Config)),
    })
  }
  return singleton
}
