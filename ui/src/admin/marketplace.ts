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
import type { MarketplaceResponse, MarketplaceWidget, WidgetPermissionSet } from '../shared/types'

export interface MarketplaceApi {
  getMarketplace(): Promise<MarketplaceResponse>
  refreshMarketplace(): Promise<MarketplaceResponse>
  installWidget(id: string, opts?: { consent?: WidgetPermissionSet | false; version?: string; update?: boolean }): Promise<{ ok: true; id: string; version: string }>
  uninstallWidget(id: string): Promise<{ ok: true; id: string }>
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

    async uninstall(id: string): Promise<void> {
      await run(id, () => api.uninstallWidget(id))
    },
  }
  return store
}
