import { reactive, computed, watch, type ComputedRef } from 'vue'
import { api as realApi } from '../shared/api'
import { pick, setLocale, t } from '../shared/i18n'
import { useSocket } from '../shared/socket'
import type { Config, NavHeight, NavWidget, Page, WidgetInstance, WidgetManifest, WidgetPermissionSet, WidgetSource, WidgetsResponse } from '../shared/types'
import { DEFAULT_NAV_HEIGHT, MAX_NAV_WIDGETS, ROWS_BY_NAV_HEIGHT, compactWidth, mergeSettings, navHasRoom, navWidgetsOf } from '../shared/types'
import { fits, largestFreeSpot, type Grid, type Rect } from './layout'

export type Mode = 'edit' | 'test'
/** The modal dialogs opened from the top bar. Kept in the store so a widget setting can open one. */
export type ModalName = 'screen' | 'connections' | 'marketplace'
export type Status = 'saved' | 'saving' | 'error'

/** Edits are grouped this long before one PUT of the whole config. */
export const SAVE_DEBOUNCE_MS = 300
/** Snapshots kept for undo; older ones fall off the bottom. */
export const UNDO_LIMIT = 50
/** Drag-and-drop mime type set by the widget library's drag source. */
export const DND_TYPE = 'application/x-fremkit-widget'
/** Mirrors the server's 409 body: saving is impossible until the file on disk is fixed. */
export const degradedMessage = (): string => t('admin.store.degraded')

export interface AdminState {
  config: Config | null
  manifests: Record<string, WidgetManifest>
  /** Where each widget came from, so the library can mark the ones the user installed. */
  sources: Record<string, WidgetSource>
  /** What each manifest asks for, beside what it was granted. See `WidgetsResponse.asks`. */
  asks: Record<string, WidgetPermissionSet>
  catalogErrors: { id: string; error: string }[]
  pageIndex: number
  selectedId: string | null
  dragWidgetId: string | null
  mode: Mode
  /** The dialog currently open above the editor, or null. */
  modal: ModalName | null
  status: Status
  toast: string
  /** The server cannot read data/fremkit.json: nothing may be saved until it is fixed. */
  degraded: boolean
}

export interface AdminApi {
  getConfig(): Promise<Config>
  getStatus(): Promise<{ degraded: boolean }>
  getWidgets(): Promise<WidgetsResponse>
  putConfig(cfg: Config): Promise<Config>
  rescan(): Promise<WidgetsResponse>
}

export interface StoreDeps {
  api: AdminApi
  subscribeConfig: (cb: (cfg: Config) => void) => () => void
  debounceMs?: number
}

export interface AdminStore {
  state: AdminState
  page: ComputedRef<Page | null>
  selected: ComputedRef<WidgetInstance | null>
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
  selectPage(i: number): void
  setMode(mode: Mode): void
  openModal(name: ModalName): void
  closeModal(): void
  setDragWidget(id: string | null): void
  dismissToast(): void
  setNavHeight(height: NavHeight): void
  addPage(): void
  renamePage(i: number, name: string): void
  duplicatePage(i: number): void
  removePage(i: number): void
  movePage(i: number, delta: number): void
  placeWidget(widgetId: string, rect: Rect): void
  addWidget(widgetId: string): void
  updateInstance(instanceId: string, patch: Partial<WidgetInstance>): void
  duplicateWidget(instanceId: string): void
  moveWidget(instanceId: string, targetPageIndex: number): void
  removeWidget(instanceId: string): void
  addNavWidget(widgetId: string): void
  removeNavWidget(instanceId: string): void
  moveNavWidget(instanceId: string, delta: number): void
  updateNavWidget(instanceId: string, patch: Partial<NavWidget>): void
}

const uid = (): string => Math.random().toString(36).slice(2, 8)
const rectOf = (w: WidgetInstance): Rect => ({ x: w.x, y: w.y, w: w.w, h: w.h })

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
    config: null, manifests: {}, sources: {}, asks: {}, catalogErrors: [],
    pageIndex: 0, selectedId: null, dragWidgetId: null,
    mode: 'edit', modal: null, status: 'saved', toast: '', degraded: false,
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

  const page = computed<Page | null>(() => state.config?.pages[state.pageIndex] ?? null)
  const selected = computed<WidgetInstance | null>(() => page.value?.widgets.find((w) => w.instanceId === state.selectedId) ?? null)
  const grid = computed<Grid>(() => ({ cols: state.config?.display.cols ?? 64, rows: state.config?.display.rows ?? 16 }))
  const canUndo = computed(() => undoStack.length > 0)
  const canRedo = computed(() => redoStack.length > 0)

  const snapshot = (): Config => JSON.parse(JSON.stringify(state.config)) as Config
  const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  function clampSelection(): void {
    if (!state.config) return
    state.pageIndex = Math.max(0, Math.min(state.pageIndex, state.config.pages.length - 1))
    if (state.selectedId && !page.value?.widgets.some((w) => w.instanceId === state.selectedId)) state.selectedId = null
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

  function apply(mutate: (cfg: Config) => void): void {
    if (!state.config) return
    undoStack.push(snapshot())
    if (undoStack.length > UNDO_LIMIT) undoStack.shift()
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

  const store: AdminStore = {
    state, page, selected, grid, canUndo, canRedo,

    async load(): Promise<void> {
      const [cfg, widgets, status] = await Promise.all([deps.api.getConfig(), deps.api.getWidgets(), deps.api.getStatus()])
      state.config = cfg
      state.degraded = status.degraded
      lastSent = stable(cfg)
      state.manifests = widgets.widgets
      state.sources = widgets.sources
      state.asks = widgets.asks
      state.catalogErrors = widgets.errors
      undoStack.length = 0
      redoStack.length = 0
      state.status = 'saved'
    },

    async rescan(): Promise<void> {
      const widgets = await deps.api.rescan()
      state.manifests = widgets.widgets
      state.sources = widgets.sources
      state.asks = widgets.asks
      state.catalogErrors = widgets.errors
    },

    apply,

    undo(): void {
      const prev = undoStack.pop()
      if (!prev) return
      redoStack.push(snapshot())
      state.config = prev
      clampSelection()
      schedule()
    },

    redo(): void {
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
      return (page.value?.widgets ?? []).filter((w) => w.instanceId !== ignoreId).map(rectOf)
    },

    select(id: string | null): void { state.selectedId = id },
    selectPage(i: number): void { state.pageIndex = i; state.selectedId = null },
    setMode(mode: Mode): void { state.mode = mode; if (mode === 'test') state.selectedId = null },
    openModal(name: ModalName): void { state.modal = name },
    closeModal(): void { state.modal = null },
    setDragWidget(id: string | null): void { state.dragWidgetId = id },
    dismissToast(): void { state.toast = '' },

    /**
     * The nav bar and the board share the screen: a shorter bar gives the grid one more row, a
     * taller one takes it back. Taking it back is only possible while that last row is empty —
     * widgets are never pushed out of the grid, the change is refused instead.
     */
    setNavHeight(height: NavHeight): void {
      const cfg = state.config
      if (!cfg) return
      const rows = ROWS_BY_NAV_HEIGHT[height]
      if (rows < cfg.display.rows && cfg.pages.some((p) => p.widgets.some((w) => w.y + w.h > rows))) {
        state.toast = t('admin.store.lastRowOccupied')
        return
      }
      apply((c) => {
        // The default is stored as an absent key, so switching back leaves no trace in the file.
        c.display.navHeight = height === DEFAULT_NAV_HEIGHT ? undefined : height
        c.display.rows = rows
      })
    },

    addPage(): void {
      apply((c) => {
        c.pages.push({ id: 'page-' + uid(), name: t('admin.store.newPage'), widgets: [] })
        state.pageIndex = c.pages.length - 1
        state.selectedId = null
      })
    },

    renamePage(i: number, name: string): void {
      apply((c) => { c.pages[i].name = name })
    },

    duplicatePage(i: number): void {
      apply((c) => {
        const src = c.pages[i]
        c.pages.splice(i + 1, 0, {
          id: 'page-' + uid(),
          name: t('admin.store.pageCopy', { name: src.name }),
          widgets: src.widgets.map((w) => ({ ...w, instanceId: `${w.widgetId}-${uid()}`, settings: { ...w.settings } })),
        })
        state.pageIndex = i + 1
        state.selectedId = null
      })
    },

    removePage(i: number): void {
      if ((state.config?.pages.length ?? 0) <= 1) { state.toast = t('admin.store.lastPage'); return }
      apply((c) => {
        c.pages.splice(i, 1)
        if (state.pageIndex >= i) state.pageIndex = Math.max(0, state.pageIndex - 1)
        state.selectedId = null
      })
    },

    movePage(i: number, delta: number): void {
      const pages = state.config?.pages
      const j = i + delta
      if (!pages || j < 0 || j >= pages.length) return
      apply((c) => {
        const [moved] = c.pages.splice(i, 1)
        c.pages.splice(j, 0, moved)
        if (state.pageIndex === i) state.pageIndex = j
        else if (state.pageIndex === j) state.pageIndex = i
      })
    },

    placeWidget(widgetId: string, rect: Rect): void {
      if (!fits(rect, grid.value, store.others())) { state.toast = t('admin.store.occupied'); return }
      const instanceId = `${widgetId}-${uid()}`
      apply((c) => {
        c.pages[state.pageIndex].widgets.push({
          instanceId, widgetId,
          x: rect.x, y: rect.y, w: rect.w, h: rect.h,
          showTitle: true, settings: {},
        })
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

    updateInstance(instanceId: string, patch: Partial<WidgetInstance>): void {
      apply((c) => {
        const w = c.pages[state.pageIndex].widgets.find((x) => x.instanceId === instanceId)
        if (w) Object.assign(w, patch)
      })
    },

    duplicateWidget(instanceId: string): void {
      const src = page.value?.widgets.find((w) => w.instanceId === instanceId)
      if (!src) return
      const min = state.manifests[src.widgetId]?.minSize ?? [1, 1]
      const spot = largestFreeSpot([src.w, src.h], min, grid.value, store.others())
      if (!spot) { state.toast = t('admin.store.noRoom'); return }
      const copy: WidgetInstance = { ...src, ...spot, instanceId: `${src.widgetId}-${uid()}`, settings: { ...src.settings } }
      apply((c) => {
        c.pages[state.pageIndex].widgets.push(copy)
        state.selectedId = copy.instanceId
      })
    },

    /**
     * The same instance on another page: everything it carries — settings, appearance, title,
     * instanceId — is kept, only its rectangle is recomputed, since the target page has its own
     * occupied cells. A page with no room refuses the move rather than stacking tiles, and the
     * editor follows the widget so the user sees where it landed.
     */
    moveWidget(instanceId: string, targetPageIndex: number): void {
      const cfg = state.config
      const src = page.value?.widgets.find((w) => w.instanceId === instanceId)
      const target = cfg?.pages[targetPageIndex]
      if (!cfg || !src || !target || targetPageIndex === state.pageIndex) return
      const manifest = state.manifests[src.widgetId]
      const spot = largestFreeSpot([src.w, src.h], manifest?.minSize ?? [1, 1], grid.value, target.widgets.map(rectOf))
      if (!spot) {
        state.toast = t('admin.store.noRoomOnPage', { page: target.name, id: pick(manifest?.name) || src.widgetId })
        return
      }
      apply((c) => {
        const widgets = c.pages[state.pageIndex].widgets
        const i = widgets.findIndex((w) => w.instanceId === instanceId)
        if (i < 0) return
        const [moved] = widgets.splice(i, 1)
        c.pages[targetPageIndex].widgets.push({ ...moved, ...spot })
        state.pageIndex = targetPageIndex
        state.selectedId = instanceId
      })
    },

    removeWidget(instanceId: string): void {
      apply((c) => {
        const widgets = c.pages[state.pageIndex].widgets
        const i = widgets.findIndex((w) => w.instanceId === instanceId)
        if (i >= 0) widgets.splice(i, 1)
        if (state.selectedId === instanceId) state.selectedId = null
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
      // Room is measured in cells, not in widgets: the clusters must not reach the dots.
      const display = state.config!.display
      const width = compactWidth(manifest, mergeSettings(manifest, {}))
      if (navWidgetsOf(display).length >= MAX_NAV_WIDGETS || !navHasRoom(display, state.manifests, width)) {
        state.toast = t('admin.store.navFull', { id: pick(manifest.name) || widgetId })
        return
      }
      apply((c) => {
        // Absent is how an empty bar is stored, so the list is created on the first widget.
        c.display.navWidgets = [...navWidgetsOf(c.display), { instanceId: `${widgetId}-${uid()}`, widgetId, slot: 'left', settings: {} }]
      })
    },

    removeNavWidget(instanceId: string): void {
      apply((c) => {
        const rest = navWidgetsOf(c.display).filter((w) => w.instanceId !== instanceId)
        // Emptying the bar restores the default exactly as it was: a missing key, not an
        // empty array — which is what makes undo round-trip cleanly.
        c.display.navWidgets = rest.length ? rest : undefined
      })
    },

    /**
     * Reordering happens within a cluster: a widget swaps places with its neighbour on the same
     * side, whatever sits between them in the stored list. At either end of its own side it is
     * a no-op rather than a jump across the dots.
     */
    moveNavWidget(instanceId: string, delta: number): void {
      const list = navWidgetsOf(state.config!.display)
      const current = list.find((w) => w.instanceId === instanceId)
      if (!current) return
      const sameSide = list.filter((w) => w.slot === current.slot)
      const at = sameSide.indexOf(current)
      const to = at + delta
      if (to < 0 || to >= sameSide.length) return
      const i = list.indexOf(current)
      const j = list.indexOf(sameSide[to])
      apply((c) => {
        const next = navWidgetsOf(c.display)
        const moved = next[i]
        next[i] = next[j]
        next[j] = moved
        c.display.navWidgets = next
      })
    },

    updateNavWidget(instanceId: string, patch: Partial<NavWidget>): void {
      apply((c) => {
        const w = navWidgetsOf(c.display).find((x) => x.instanceId === instanceId)
        if (w) Object.assign(w, patch)
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
