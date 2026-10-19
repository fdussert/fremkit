/**
 * The editor's live widget health: `computeHealth` (`./health`) fed by the stores the editor
 * already holds and by the server's `config:health` channel, plus what each problem's button
 * does. One instance for the whole editor, like the stores it reads.
 */
import { computed, nextTick, ref, type ComputedRef } from 'vue'
import { useSocket } from '../shared/socket'
import { navItemsOf } from '../shared/types'
import { actionLabel, computeHealth, HEALTHY, healthEntries, type HealthAction, type HealthEntry, type InstanceHealth, type MarketEntry } from './health'
import { useAdminStore, type AdminStore } from './store'
import { useConnectionsStore, type ConnectionsStore } from './connections'
import { useMarketplaceStore, type MarketplaceStore } from './marketplace'
import { NAV_WIDGETS_SECTION, toggleNavSettings } from './menus'
import type { MenuUi } from './canvasMenu'
import { t } from '../shared/i18n'
import { editorFocus } from './editorFocus'
import { openSettings as openSettingsWindow } from './settingsWindow'

/** The server's channel; see `server/src/providers/health.ts`. */
export const HEALTH_CHANNEL = 'config:health'

export interface Health {
  /** Every widget of the config, by instance id. */
  all: ComputedRef<Record<string, InstanceHealth>>
  /** Every unhealthy widget placed somewhere, errors first: the top bar's list. */
  entries: ComputedRef<HealthEntry[]>
  of(instanceId: string): InstanceHealth
  /** Runs the button of a problem of this widget. */
  run(instanceId: string, action: HealthAction): void
  /** The menus' first item: the widget's first problem's fix, or null when it has none. */
  fix(instanceId: string): { label: string; run: () => void } | null
  /** A plain menu item for a widget with a newer version in the registry, or null. Not a fix. */
  update(instanceId: string): { label: string; run: () => void } | null
}

export interface HealthDeps {
  store: AdminStore
  connections: ConnectionsStore
  market: MarketplaceStore
  /** `config:health`, as the socket delivers it. */
  subscribe: (cb: (data: unknown) => void) => () => void
  ui: Pick<MenuUi, 'revealSection'>
}

/** Where to find a widget for its settings: a page of a screen, else a screen's bar. */
function locate(s: AdminStore, instanceId: string): { screenId: string; pageIndex: number | null } | null {
  const cfg = s.state.config
  if (!cfg) return null
  const screens = [...cfg.screens].sort((a, b) => Number(b.id === s.screen.value?.id) - Number(a.id === s.screen.value?.id))
  for (const screen of screens) {
    const pageIndex = screen.pages.findIndex((p) => p.items.some((i) => i.instanceId === instanceId))
    if (pageIndex >= 0) return { screenId: screen.id, pageIndex }
    if (navItemsOf(screen).some((n) => n.instanceId === instanceId)) return { screenId: screen.id, pageIndex: null }
  }
  return null
}

export function createHealth(deps: HealthDeps): Health {
  const { store: s, connections, market } = deps
  const channels = ref<Record<string, string | null>>({})
  deps.subscribe((data) => {
    const next = (data as { channels?: unknown } | null)?.channels
    channels.value = next && typeof next === 'object' ? next as Record<string, string | null> : {}
  })
  // Settings forms load the connections when they need them; health needs them from the start.
  if (!connections.state.loaded) void connections.load().catch(() => { /* the connections dialog shows the error */ })

  const marketEntries = computed<MarketEntry[]>(() => market.state.widgets.map((w) => ({
    id: w.id,
    updateAvailable: w.updateAvailable,
    version: w.version,
    installable: !w.installed && !w.sdkTooNew && !w.shadowsBuiltin,
  })))

  const all = computed(() => {
    const config = s.state.config
    if (!config) return {}
    return computeHealth({
      config,
      manifests: s.state.manifests,
      connections: connections.state.loaded ? connections.state.connections : null,
      connectionTypes: connections.state.types,
      channels: channels.value,
      market: marketEntries.value,
    })
  })
  const entries = computed(() => (s.state.config ? healthEntries(s.state.config, all.value, s.screen.value?.id) : []))
  const of = (instanceId: string): InstanceHealth => all.value[instanceId] ?? HEALTHY

  function openSettings(instanceId: string, field: string): void {
    const where = locate(s, instanceId)
    if (!where) return
    if (where.screenId !== s.screen.value?.id) s.selectScreen(where.screenId)
    if (where.pageIndex === null) {
      // A bar widget's settings are in the settings window's screen pane, under its entry.
      toggleNavSettings(instanceId, true)
      if (s.state.modal !== 'settings') s.openModal('settings')
      deps.ui.revealSection(NAV_WIDGETS_SECTION)
      return
    }
    s.selectPage(where.pageIndex)
    s.select(instanceId)
    deps.ui.revealSection('widget.settings')
    void nextTick(() => {
      const el = document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(field)}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el?.querySelector<HTMLElement>('select, input')?.focus()
    })
  }

  function run(instanceId: string, action: HealthAction): void {
    switch (action.kind) {
      case 'connection': s.openConnection(action.id); return
      case 'newConnection': s.openNewConnection(action.type); return
      case 'settings': openSettings(instanceId, action.field); return
      case 'screen': openSettingsWindow(s, 'screen'); return
      case 'reload': s.reloadWidget(instanceId); return
      case 'rescan': void s.rescan(); return
      case 'install':
      case 'update': {
        const entry = market.state.widgets.find((w) => w.id === action.widgetId)
        s.openModal('marketplace')
        market.setView(action.kind === 'update' ? 'updates' : 'available')
        // The panel renders the consent dialog, when the widget asks for one.
        if (entry) void market.start(entry, action.kind === 'update')
        return
      }
    }
  }

  function fix(instanceId: string): { label: string; run: () => void } | null {
    const first = of(instanceId).problems[0]
    const action = first?.action
    if (!action) return null
    return { label: t('admin.health.fix', { action: actionLabel(action) }), run: () => run(instanceId, action) }
  }

  function update(instanceId: string): { label: string; run: () => void } | null {
    const u = of(instanceId).update
    if (!u) return null
    return {
      label: u.version ? t('admin.health.update.to', { version: u.version }) : actionLabel({ kind: 'update', widgetId: u.widgetId }),
      run: () => run(instanceId, { kind: 'update', widgetId: u.widgetId }),
    }
  }

  return { all, entries, of, run, fix, update }
}

let singleton: Health | null = null

export function useHealth(): Health {
  if (!singleton) {
    singleton = createHealth({
      store: useAdminStore(),
      connections: useConnectionsStore(),
      market: useMarketplaceStore(),
      subscribe: (cb) => useSocket().subscribe(HEALTH_CHANNEL, cb),
      ui: editorFocus,
    })
  }
  return singleton
}
