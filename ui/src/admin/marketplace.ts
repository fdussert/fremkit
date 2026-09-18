/**
 * The Browse tab's state: the registry index, and the four things a person can do with it.
 *
 * Kept apart from the admin store because it is not part of the dashboard. Nothing here edits
 * the config — installing writes files and a consent record on the server, and the admin then
 * rescans, so the only thing that crosses back is "the widget library changed".
 *
 * The rules a card is drawn from all come from the server, which is where they can be enforced;
 * this file arranges them and remembers which button is spinning.
 */

import { computed, reactive, type ComputedRef } from 'vue'
import { ConsentRequiredError, api as realApi } from '../shared/api'
import { pick, t } from '../shared/i18n'
import { useAdminStore } from './store'
import type { MarketplaceResponse, MarketplaceWidget, WidgetPermissionSet } from '../shared/types'

export interface MarketplaceApi {
  getMarketplace(): Promise<MarketplaceResponse>
  refreshMarketplace(): Promise<MarketplaceResponse>
  installWidget(id: string, opts?: { consent?: WidgetPermissionSet | false; version?: string; update?: boolean }): Promise<{ ok: true; id: string; version: string }>
  uninstallWidget(id: string): Promise<{ ok: true; id: string }>
  updateAllWidgets(consent: Record<string, WidgetPermissionSet | false>): Promise<{ results: ({ id: string } & UpdateResult)[] }>
}

const NONE: WidgetPermissionSet = { subscriptions: [], commands: [], network: [] }

function union(a: WidgetPermissionSet, b: WidgetPermissionSet): WidgetPermissionSet {
  const merge = (x: string[], y: string[]): string[] => [...new Set([...x, ...y])]
  return {
    subscriptions: merge(a.subscriptions, b.subscriptions),
    commands: merge(a.commands, b.commands),
    network: merge(a.network, b.network),
  }
}

function empty(p: WidgetPermissionSet): boolean {
  return p.subscriptions.length === 0 && p.commands.length === 0 && p.network.length === 0
}

/**
 * Which of the modal's three lists is showing.
 *
 * `available` is the shop, `installed` is what this machine has, `updates` is the short list
 * somebody came here to act on. They are views of one index rather than three requests.
 */
export type MarketView = 'available' | 'installed' | 'updates'

/**
 * What kind of thing the list is showing.
 *
 * One value today. It exists so that themes — already carried by the index — and wallpapers
 * after them are one more entry rather than a second list and a second filter.
 */
export type MarketKind = 'widget'

/** What the consent dialog is open about. `added` is what is new, `all` what the widget asks. */
export interface ConsentPrompt {
  widget: MarketplaceWidget
  update: boolean
  added: WidgetPermissionSet
  all: WidgetPermissionSet
  /**
   * The set sent to the server as `consent` if this is accepted: exactly what the dialog put in
   * front of the user. The server checks the package's ask against it, so a package asking for
   * more than was rendered here is refused rather than granted.
   */
  send: WidgetPermissionSet
}

export interface MarketplaceState {
  widgets: MarketplaceWidget[]
  registry: string | null
  /** Never loaded yet; distinct from "loaded and empty", which is a registry with no widgets. */
  loaded: boolean
  loading: boolean
  offline: boolean
  /**
   * The id of the widget being worked on, or null.
   *
   * One at a time on purpose — an install writes files and re-reads the index — but only that
   * row says so; the others are simply disabled, which is a different message from "waiting".
   */
  busy: string | null
  error: string
  search: string
  /** Which of the three lists is showing; `updates` is where the top bar's badge sends you. */
  view: MarketView
  kind: MarketKind
  consent: ConsentPrompt | null
  /**
   * The outcome of the last "update all", by widget id, so each row can say what happened to it
   * rather than the whole run collapsing into one toast.
   */
  results: Record<string, UpdateResult>
  /** True while the series is running: the button says so and nothing else may start. */
  updatingAll: boolean
  /** The "update all" dialog is open, listing what each waiting widget newly asks for. */
  updateAllOpen: boolean
}

/** What one widget's update came to. `newPermissions` means it was never attempted. */
export interface UpdateResult {
  ok: boolean
  version?: string
  error?: string
  newPermissions?: WidgetPermissionSet
}

export interface MarketplaceStore {
  state: MarketplaceState
  /** The rows of the view that is showing, filtered by the search box. */
  shown: ComputedRef<MarketplaceWidget[]>
  /** Every installed widget with something newer waiting, whatever the view. */
  waiting: ComputedRef<MarketplaceWidget[]>
  /** How many of those there are: the badge on the top bar. */
  updates: ComputedRef<number>
  /** The consent the dialog for "update all" would have to show, per widget. */
  updateAllPrompt: ComputedRef<{ widget: MarketplaceWidget; added: WidgetPermissionSet }[]>
  setView(view: MarketView): void
  load(force?: boolean): Promise<void>
  refresh(): Promise<void>
  /** Opens the one dialog that covers the whole series. */
  askUpdateAll(): void
  cancelUpdateAll(): void
  updateAll(): Promise<void>
  /** Reopens the single-update dialog for a widget the series refused on consent. */
  review(widget: MarketplaceWidget): void
  /** Forgets what the last series came to; the panel closing ends that run's story. */
  clearResults(): void
  /** Opens the dialog when something new is being asked for, installs straight away otherwise. */
  start(widget: MarketplaceWidget, update?: boolean): Promise<void>
  accept(): Promise<void>
  cancel(): void
  uninstall(id: string): Promise<void>
}

export interface MarketplaceDeps {
  api?: MarketplaceApi
  /** Called after anything that changes what is installed, so the library picks it up. */
  onChanged?: () => void | Promise<void>
}

/** Matches a search box against what a person can actually see on the card. */
export function matches(widget: MarketplaceWidget, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    widget.id, pick(widget.name), pick(widget.description), widget.author ?? '',
    ...widget.connections,
  ].join(' ').toLowerCase()
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

export function createMarketplaceStore(deps: MarketplaceDeps = {}): MarketplaceStore {
  const api = deps.api ?? realApi
  const state = reactive<MarketplaceState>({
    widgets: [], registry: null, loaded: false, loading: false, offline: false,
    busy: null, error: '', search: '', view: 'available', kind: 'widget',
    consent: null, results: {}, updatingAll: false, updateAllOpen: false,
  })

  /** The rows one view is made of, before the search box narrows them. */
  const inView = (): MarketplaceWidget[] => {
    const rows = state.widgets
    if (state.view === 'installed') return rows.filter((w) => w.installed)
    // A widget that has just been updated is no longer waiting, and dropping it here would take
    // its "updated to vX" line with it — the whole answer to "what did that button do" would be
    // the failures. So the rows a finished run reported stay until the view changes.
    if (state.view === 'updates') return rows.filter((w) => w.updateAvailable || state.results[w.id])
    return rows
  }

  const take = (answer: MarketplaceResponse): void => {
    state.widgets = answer.widgets
    state.registry = answer.registry
    state.offline = answer.offline
    state.loaded = true
  }

  const run = async (id: string, work: () => Promise<unknown>): Promise<void> => {
    if (state.busy) return
    state.busy = id
    state.error = ''
    try {
      await work()
      // The index is re-read rather than patched: `updateAvailable` and `consentNeeded` are the
      // server's answers, and guessing them here is how the two drift apart.
      take(await api.getMarketplace())
      await deps.onChanged?.()
    } catch (err) {
      state.error = (err as Error).message
    } finally {
      state.busy = null
    }
  }

  /**
   * Installs, and reopens the dialog if the server says the package asks for more than was shown.
   *
   * That happens when the index entry and the manifest inside the zip disagree — the entry is
   * free text on the registry's side, the zip is the thing that was hashed. The user is then
   * asked again on the real ask instead of being handed a grant they never saw.
   */
  const attempt = async (widget: MarketplaceWidget, update: boolean, consent: WidgetPermissionSet | false): Promise<void> => {
    await run(widget.id, async () => {
      try {
        await api.installWidget(widget.id, { consent, update })
      } catch (err) {
        if (!(err instanceof ConsentRequiredError)) throw err
        const shown = consent === false ? NONE : consent
        const all = union(shown, err.newPermissions)
        state.consent = { widget, update, added: err.newPermissions, all, send: all }
      }
    })
  }

  const store: MarketplaceStore = {
    state,
    shown: computed(() => inView().filter((w) => matches(w, state.search))),
    waiting: computed(() => state.widgets.filter((w) => w.updateAvailable)),
    updates: computed(() => state.widgets.filter((w) => w.updateAvailable).length),
    /**
     * What a single dialog would have to list before updating everything.
     *
     * Every waiting widget is named, including the ones that ask for nothing new — "no new
     * permission" beside a name is information, and a dialog that silently omitted those would
     * leave the user guessing which of the five it was actually about.
     */
    updateAllPrompt: computed(() => state.widgets
      .filter((w) => w.updateAvailable)
      .map((w) => ({ widget: w, added: w.newPermissions }))),

    setView(view: MarketView): void {
      state.view = view
      // The results of a finished run belong to the run, not to the list.
      if (view !== 'updates') state.results = {}
    },

    /**
     * Reads the index once, and again only when asked.
     *
     * `force` is what the caller uses to retry: a first load that failed leaves `loaded` true
     * and `offline` true, and without it that failure would be permanent for the life of the
     * page — the Browse tab would keep showing an error nobody could clear.
     */
    async load(force = false): Promise<void> {
      if (state.loading || (state.loaded && !force)) return
      state.loading = true
      state.error = ''
      try { take(await api.getMarketplace()) }
      catch (err) { state.error = (err as Error).message; state.offline = true; state.loaded = true }
      finally { state.loading = false }
    },

    async refresh(): Promise<void> {
      state.loading = true
      state.error = ''
      try { take(await api.refreshMarketplace()) }
      catch (err) { state.error = (err as Error).message || t('admin.market.offline'); state.offline = true }
      finally { state.loading = false }
    },

    async start(widget: MarketplaceWidget, update = false): Promise<void> {
      if (widget.sdkTooNew || widget.shadowsBuiltin) return
      // Nothing new according to the index: try it, and let the server reopen the dialog if the
      // package turns out to ask for more than the entry advertised.
      if (!widget.consentNeeded) { await attempt(widget, update, false); return }
      state.consent = {
        widget, update, added: widget.newPermissions, all: widget.permissions,
        // What the dialog renders is the widget's whole ask — the difference on top, the rest as
        // context — so that whole set is what is being consented to.
        send: widget.permissions,
      }
    },

    async accept(): Promise<void> {
      const prompt = state.consent
      if (!prompt) return
      state.consent = null
      // Deliberately not `attempt`: a second 409 on the very set the user just accepted means
      // the package changed under us, and reopening the same dialog in a loop is worse than
      // showing the refusal.
      await run(prompt.widget.id, () => api.installWidget(prompt.widget.id, {
        consent: empty(prompt.send) ? false : prompt.send,
        update: prompt.update,
      }))
    },

    cancel(): void { state.consent = null },

    /**
     * Updates every waiting widget in one request.
     *
     * The consent sent is what the dialog listed, per widget, exactly as a single update sends
     * its own — the server checks each package against its own entry and refuses the ones it was
     * not given, so this cannot grant in bulk what was not shown. A widget that comes back with
     * `newPermissions` was never touched.
     */
    askUpdateAll(): void {
      if (!state.widgets.some((w) => w.updateAvailable)) return
      state.updateAllOpen = true
    },

    cancelUpdateAll(): void { state.updateAllOpen = false },

    async updateAll(): Promise<void> {
      state.updateAllOpen = false
      if (state.updatingAll || state.busy) return
      const waiting = state.widgets.filter((w) => w.updateAvailable)
      if (!waiting.length) return
      state.updatingAll = true
      state.error = ''
      state.results = {}
      try {
        const consent: Record<string, WidgetPermissionSet | false> = {}
        for (const w of waiting) consent[w.id] = empty(w.permissions) ? false : w.permissions
        const answer = await api.updateAllWidgets(consent)
        const results: Record<string, UpdateResult> = {}
        for (const { id, ...rest } of answer.results) results[id] = rest
        state.results = results
        // Once, at the end: the index is the server's answer about what is installed now.
        take(await api.getMarketplace())
        await deps.onChanged?.()
      } catch (err) {
        state.error = (err as Error).message
      } finally {
        state.updatingAll = false
      }
    },

    /**
     * Picks one refusal out of the series and asks about it properly.
     *
     * A widget the server refused for consent is the one case a bulk run cannot finish by itself:
     * it asks for something the dialog never listed. Without this the row is a sentence with no
     * button — the user is told what went wrong and given nowhere to go. The set offered is what
     * the server reported as missing, on top of what the entry advertises, which is exactly what
     * the single-update dialog would have shown.
     */
    review(widget: MarketplaceWidget): void {
      const added = state.results[widget.id]?.newPermissions
      if (!added || empty(added)) return
      const all = union(widget.permissions, added)
      state.consent = { widget, update: true, added, all, send: all }
    },

    clearResults(): void { state.results = {} },

    async uninstall(id: string): Promise<void> {
      await run(id, () => api.uninstallWidget(id))
    },
  }
  return store
}

let singleton: MarketplaceStore | null = null

/**
 * The one marketplace store.
 *
 * Three places read it now — the top bar's badge, the widget column's update chip, and the modal
 * itself — so it cannot live inside a component the way it did when Browse was a tab. The index
 * is still read once, when the column mounts, which is what makes the badge right on the first
 * paint.
 */
export function useMarketplaceStore(): MarketplaceStore {
  if (!singleton) {
    // Installing writes files on the server; the widget library is what reads them, so a rescan
    // is how an installed widget appears in the column without a reload.
    singleton = createMarketplaceStore({ onChanged: () => useAdminStore().rescan() })
  }
  return singleton
}
