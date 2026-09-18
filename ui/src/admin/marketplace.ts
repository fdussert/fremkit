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
import { api as realApi } from '../shared/api'
import { pick, t } from '../shared/i18n'
import type { MarketplaceResponse, MarketplaceWidget, WidgetPermissionSet } from '../shared/types'

export interface MarketplaceApi {
  getMarketplace(): Promise<MarketplaceResponse>
  refreshMarketplace(): Promise<MarketplaceResponse>
  installWidget(id: string, opts?: { consent?: boolean; version?: string; update?: boolean }): Promise<{ ok: true; id: string; version: string }>
  uninstallWidget(id: string): Promise<{ ok: true; id: string }>
}

/** What the consent dialog is open about. `added` is what is new, `all` what the widget asks. */
export interface ConsentPrompt {
  widget: MarketplaceWidget
  update: boolean
  added: WidgetPermissionSet
  all: WidgetPermissionSet
}

export interface MarketplaceState {
  widgets: MarketplaceWidget[]
  registry: string | null
  /** Never loaded yet; distinct from "loaded and empty", which is a registry with no widgets. */
  loaded: boolean
  loading: boolean
  offline: boolean
  /** The id of the widget whose button is working, so only that one spins. */
  busy: string | null
  error: string
  search: string
  consent: ConsentPrompt | null
}

export interface MarketplaceStore {
  state: MarketplaceState
  shown: ComputedRef<MarketplaceWidget[]>
  /** How many installed widgets have a newer version: the badge on the tab. */
  updates: ComputedRef<number>
  load(force?: boolean): Promise<void>
  refresh(): Promise<void>
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
    busy: null, error: '', search: '', consent: null,
  })

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

  const store: MarketplaceStore = {
    state,
    shown: computed(() => state.widgets.filter((w) => matches(w, state.search))),
    updates: computed(() => state.widgets.filter((w) => w.updateAvailable).length),

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
      if (!widget.consentNeeded) { await run(widget.id, () => api.installWidget(widget.id, { update })); return }
      state.consent = { widget, update, added: widget.newPermissions, all: widget.permissions }
    },

    async accept(): Promise<void> {
      const prompt = state.consent
      if (!prompt) return
      state.consent = null
      await run(prompt.widget.id, () => api.installWidget(prompt.widget.id, { consent: true, update: prompt.update }))
    },

    cancel(): void { state.consent = null },

    async uninstall(id: string): Promise<void> {
      await run(id, () => api.uninstallWidget(id))
    },
  }
  return store
}
