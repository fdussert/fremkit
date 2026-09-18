import { describe, expect, it, vi } from 'vitest'
import { createMarketplaceStore, matches, type MarketplaceApi } from '../src/admin/marketplace'
import { ConsentRequiredError } from '../src/shared/api'
import type { MarketplaceResponse, MarketplaceWidget, WidgetPermissionSet } from '../src/shared/types'

const NONE: WidgetPermissionSet = { subscriptions: [], commands: [], network: [] }
const set = (over: Partial<WidgetPermissionSet> = {}): WidgetPermissionSet => ({ ...NONE, ...over })

function widget(over: Partial<MarketplaceWidget> = {}): MarketplaceWidget {
  return {
    id: 'demo', version: '1.0.0', sdk: 1,
    name: { fr: 'Démo', en: 'Demo' }, description: { fr: 'Un widget', en: 'A widget' },
    icon: 'layout-grid', author: 'A. Author', license: 'MIT',
    permissions: { subscriptions: [], commands: [], network: [] },
    connections: [], size: 2048, publishedAt: '2026-09-18T12:00:00.000Z',
    installed: false, installedVersion: null, updateAvailable: false,
    sdkTooNew: false, consentNeeded: false,
    newPermissions: { subscriptions: [], commands: [], network: [] },
    shadowsBuiltin: false, placedOn: [],
    ...over,
  }
}

function answer(widgets: MarketplaceWidget[], over: Partial<MarketplaceResponse> = {}): MarketplaceResponse {
  return { registry: 'fremkit-sietch', generatedAt: '2026-09-18T12:00:00.000Z', widgets, offline: false, sdk: 1, ...over }
}

function make(widgets: MarketplaceWidget[], over: Partial<MarketplaceApi> = {}, onChanged?: () => void) {
  const api: MarketplaceApi = {
    getMarketplace: vi.fn(async () => answer(widgets)),
    refreshMarketplace: vi.fn(async () => answer(widgets)),
    installWidget: vi.fn(async (id: string) => ({ ok: true as const, id, version: '1.0.0' })),
    uninstallWidget: vi.fn(async (id: string) => ({ ok: true as const, id })),
    updateAllWidgets: vi.fn(async () => ({ results: [] })),
    installMissingWidgets: vi.fn(async () => ({ results: [] })),
    ...over,
  }
  return { api, store: createMarketplaceStore({ api, onChanged }) }
}

describe('matches', () => {
  it('searches what the card actually shows, in either language', () => {
    const w = widget({ author: 'Jane Dev', connections: ['synology'] })
    expect(matches(w, '')).toBe(true)
    expect(matches(w, 'démo')).toBe(true)
    expect(matches(w, 'widget')).toBe(true)
    expect(matches(w, 'jane')).toBe(true)
    expect(matches(w, 'synology')).toBe(true)
    expect(matches(w, 'nothing')).toBe(false)
  })
  it('requires every word, so two words narrow instead of widening', () => {
    const w = widget({ author: 'Jane Dev' })
    expect(matches(w, 'demo jane')).toBe(true)
    expect(matches(w, 'demo nothing')).toBe(false)
  })
})

describe('load', () => {
  it('reads the registry once and remembers it', async () => {
    const { api, store } = make([widget()])
    await store.load()
    await store.load()
    expect(api.getMarketplace).toHaveBeenCalledTimes(1)
    expect(store.state.loaded).toBe(true)
    expect(store.shown.value).toHaveLength(1)
  })

  it('shows an offline registry as offline rather than as an empty one', async () => {
    const { store } = make([], { getMarketplace: vi.fn(async () => answer([], { offline: true })) })
    await store.load()
    expect(store.state.offline).toBe(true)
  })

  it('survives a request that throws', async () => {
    const { store } = make([], { getMarketplace: vi.fn(async () => { throw new Error('boom') }) })
    await store.load()
    expect(store.state.error).toBe('boom')
    expect(store.state.offline).toBe(true)
    expect(store.state.loaded).toBe(true)
  })
})

describe('updates', () => {
  it('counts the installed widgets with something newer waiting', async () => {
    const { store } = make([
      widget({ id: 'a', installed: true, updateAvailable: true }),
      widget({ id: 'b', installed: true }),
      widget({ id: 'c' }),
    ])
    await store.load()
    expect(store.updates.value).toBe(1)
  })
})

describe('install', () => {
  it('installs straight away when nothing new is being asked for', async () => {
    const { api, store } = make([widget()])
    await store.load()
    await store.start(store.state.widgets[0])
    expect(store.state.consent).toBeNull()
    // Nothing new according to the index, so nothing was shown: `false`, not an empty set.
    expect(api.installWidget).toHaveBeenCalledWith('demo', { consent: false, update: false })
  })

  it('opens the dialog first when something is, and installs nothing until it is answered', async () => {
    const asking = widget({
      consentNeeded: true,
      permissions: set({ subscriptions: ['system'] }),
      newPermissions: set({ subscriptions: ['system'] }),
    })
    const { api, store } = make([asking])
    await store.load()
    await store.start(store.state.widgets[0])
    expect(store.state.consent?.added.subscriptions).toEqual(['system'])
    expect(api.installWidget).not.toHaveBeenCalled()

    await store.accept()
    expect(store.state.consent).toBeNull()
    // What is sent is the set the dialog rendered, not "yes": the server checks the package's
    // ask against it, so a package asking for more than was shown is refused.
    expect(api.installWidget).toHaveBeenCalledWith('demo', { consent: set({ subscriptions: ['system'] }), update: false })
  })

  it('reopens the dialog when the package asks for more than the index advertised', async () => {
    // The entry is free text on the registry's side; the zip is what was hashed. The server
    // refuses and hands back the real ask, and the user is asked again on that.
    const refused = new ConsentRequiredError('this version asks for new permissions', set({ subscriptions: ['system', 'homey:*'] }))
    const { api, store } = make([widget()], { installWidget: vi.fn(async () => { throw refused }) })
    await store.load()
    await store.start(store.state.widgets[0])
    expect(store.state.consent?.added.subscriptions).toEqual(['system', 'homey:*'])
    expect(store.state.consent?.send.subscriptions).toEqual(['system', 'homey:*'])
    expect(store.state.error).toBe('')
  })

  it('shows the refusal rather than looping when the same set is refused twice', async () => {
    const refused = new ConsentRequiredError('this version asks for new permissions', set({ subscriptions: ['homey:*'] }))
    const { api, store } = make([widget({ consentNeeded: true, permissions: set({ subscriptions: ['system'] }), newPermissions: set({ subscriptions: ['system'] }) })], {
      installWidget: vi.fn(async () => { throw refused }),
    })
    await store.load()
    await store.start(store.state.widgets[0])
    await store.accept()
    expect(store.state.consent).toBeNull()
    expect(store.state.error).toMatch(/new permissions/)
    expect(api.installWidget).toHaveBeenCalledTimes(1)
  })

  it('installs nothing when the dialog is dismissed', async () => {
    const { api, store } = make([widget({ consentNeeded: true })])
    await store.load()
    await store.start(store.state.widgets[0])
    store.cancel()
    expect(store.state.consent).toBeNull()
    expect(api.installWidget).not.toHaveBeenCalled()
  })

  it('does nothing at all for a widget the server already refused', async () => {
    const { api, store } = make([widget({ id: 'a', sdkTooNew: true }), widget({ id: 'b', shadowsBuiltin: true })])
    await store.load()
    await store.start(store.state.widgets[0])
    await store.start(store.state.widgets[1])
    expect(api.installWidget).not.toHaveBeenCalled()
    expect(store.state.consent).toBeNull()
  })

  it('re-reads the index afterwards rather than guessing the new state', async () => {
    // `updateAvailable` and `consentNeeded` are the server's answers; patching them here is how
    // the two drift apart.
    const { api, store } = make([widget()])
    await store.load()
    await store.start(store.state.widgets[0])
    expect(api.getMarketplace).toHaveBeenCalledTimes(2)
  })

  it('tells the library to look again, so the widget appears without a reload', async () => {
    const onChanged = vi.fn()
    const { store } = make([widget()], {}, onChanged)
    await store.load()
    await store.start(store.state.widgets[0])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('shows what went wrong and stops spinning', async () => {
    const { store } = make([widget()], { installWidget: vi.fn(async () => { throw new Error('the registry could not be reached') }) })
    await store.load()
    await store.start(store.state.widgets[0])
    expect(store.state.error).toBe('the registry could not be reached')
    expect(store.state.busy).toBeNull()
  })

  it('runs one action at a time', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { api, store } = make([widget({ id: 'a' }), widget({ id: 'b' })], {
      installWidget: vi.fn(async (id: string) => { await gate; return { ok: true as const, id, version: '1.0.0' } }),
    })
    await store.load()
    const first = store.start(store.state.widgets[0])
    await store.start(store.state.widgets[1])
    expect(api.installWidget).toHaveBeenCalledTimes(1)
    release()
    await first
  })
})

describe('update and uninstall', () => {
  it('asks the update endpoint, not the install one', async () => {
    const { api, store } = make([widget({ installed: true, installedVersion: '1.0.0', version: '1.1.0', updateAvailable: true })])
    await store.load()
    await store.start(store.state.widgets[0], true)
    expect(api.installWidget).toHaveBeenCalledWith('demo', { consent: false, update: true })
  })

  it('carries the update flag through the dialog', async () => {
    const asking = widget({
      installed: true, updateAvailable: true, consentNeeded: true,
      permissions: set({ commands: ['synology'] }), newPermissions: set({ commands: ['synology'] }),
    })
    const { api, store } = make([asking])
    await store.load()
    await store.start(store.state.widgets[0], true)
    expect(store.state.consent?.update).toBe(true)
    await store.accept()
    expect(api.installWidget).toHaveBeenCalledWith('demo', { consent: set({ commands: ['synology'] }), update: true })
  })

  it('removes a widget and refreshes both the index and the library', async () => {
    const onChanged = vi.fn()
    const { api, store } = make([widget({ installed: true })], {}, onChanged)
    await store.load()
    await store.uninstall('demo')
    expect(api.uninstallWidget).toHaveBeenCalledWith('demo')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('shows the server\'s refusal when the widget is still placed', async () => {
    const { store } = make([widget({ installed: true })], {
      uninstallWidget: vi.fn(async () => { throw new Error('the widget is still placed: Home') }),
    })
    await store.load()
    await store.uninstall('demo')
    expect(store.state.error).toMatch(/still placed/)
  })
})

describe('refresh', () => {
  it('goes back out and says so when it cannot', async () => {
    const { api, store } = make([widget()], { refreshMarketplace: vi.fn(async () => { throw new Error('the registry could not be reached') }) })
    await store.load()
    await store.refresh()
    expect(api.refreshMarketplace).toHaveBeenCalledTimes(1)
    expect(store.state.offline).toBe(true)
    expect(store.state.error).toMatch(/could not be reached/)
    // The list it already had is still on screen.
    expect(store.shown.value).toHaveLength(1)
  })
})

describe('the three views', () => {
  const rows = (store: ReturnType<typeof createMarketplaceStore>): string[] => store.shown.value.map((w) => w.id)

  const three = () => [
    widget({ id: 'fresh' }),
    widget({ id: 'here', installed: true, installedVersion: '1.0.0' }),
    widget({ id: 'stale', installed: true, installedVersion: '1.0.0', version: '2.0.0', updateAvailable: true }),
  ]

  it('shows everything, what is installed, and what is waiting', async () => {
    const { store } = make(three())
    await store.load()
    expect(rows(store).sort()).toEqual(['fresh', 'here', 'stale'])
    store.setView('installed')
    expect(rows(store).sort()).toEqual(['here', 'stale'])
    store.setView('updates')
    expect(rows(store)).toEqual(['stale'])
  })

  it('narrows the view it is on, not the whole index', async () => {
    const { store } = make(three())
    await store.load()
    store.setView('updates')
    store.state.search = 'fresh'
    expect(rows(store)).toEqual([])
    store.setView('available')
    expect(rows(store)).toEqual(['fresh'])
  })

  it('drops the results of a finished run when leaving Updates', async () => {
    const { store } = make(three(), {
      updateAllWidgets: vi.fn(async () => ({ results: [{ id: 'stale', ok: true, version: '2.0.0' }] })),
    })
    await store.load()
    store.setView('updates')
    await store.updateAll()
    expect(store.state.results.stale.ok).toBe(true)
    store.setView('available')
    expect(store.state.results).toEqual({})
  })
})

describe('update all', () => {
  const waiting = (over: Partial<MarketplaceWidget> = {}) =>
    widget({ installed: true, installedVersion: '1.0.0', version: '2.0.0', updateAvailable: true, ...over })

  it('lists every waiting widget in one dialog, including the ones asking nothing new', async () => {
    const { store } = make([
      waiting({ id: 'a' }),
      waiting({ id: 'b', newPermissions: set({ subscriptions: ['system'] }) }),
      widget({ id: 'c' }),
    ])
    await store.load()
    store.askUpdateAll()
    expect(store.state.updateAllOpen).toBe(true)
    expect(store.updateAllPrompt.value.map((e) => e.widget.id)).toEqual(['a', 'b'])
    expect(store.updateAllPrompt.value[0].added.subscriptions).toEqual([])
  })

  it('opens nothing when nothing is waiting', async () => {
    const { store } = make([widget()])
    await store.load()
    store.askUpdateAll()
    expect(store.state.updateAllOpen).toBe(false)
  })

  it('sends the set each card showed, and `false` for a widget that asks nothing', async () => {
    const { api, store } = make([
      waiting({ id: 'a' }),
      waiting({ id: 'b', permissions: set({ subscriptions: ['system'] }) }),
    ])
    await store.load()
    await store.updateAll()
    expect(api.updateAllWidgets).toHaveBeenCalledWith({
      a: false,
      b: set({ subscriptions: ['system'] }),
    })
  })

  it('keeps one result per widget, so a row says what happened to it', async () => {
    const { api, store } = make([waiting({ id: 'a' }), waiting({ id: 'b' })], {
      updateAllWidgets: vi.fn(async () => ({
        results: [
          { id: 'a', ok: true, version: '2.0.0' },
          { id: 'b', ok: false, error: 'the downloaded package does not match the index' },
        ],
      })),
    })
    await store.load()
    await store.updateAll()
    expect(store.state.results.a).toEqual({ ok: true, version: '2.0.0' })
    expect(store.state.results.b.error).toMatch(/does not match/)
    // The index is re-read once, at the end, rather than per widget.
    expect(api.getMarketplace).toHaveBeenCalledTimes(2)
    expect(store.state.updatingAll).toBe(false)
  })

  it('tells the library to look again once', async () => {
    const onChanged = vi.fn()
    const { store } = make([waiting()], {}, onChanged)
    await store.load()
    await store.updateAll()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('shows what went wrong when the whole request fails', async () => {
    const { store } = make([waiting()], {
      updateAllWidgets: vi.fn(async () => { throw new Error('the registry could not be reached') }),
    })
    await store.load()
    await store.updateAll()
    expect(store.state.error).toMatch(/could not be reached/)
    expect(store.state.updatingAll).toBe(false)
  })

  it('does nothing while a single install is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { api, store } = make([waiting()], {
      installWidget: vi.fn(async (id: string) => { await gate; return { ok: true as const, id, version: '2.0.0' } }),
    })
    await store.load()
    const running = store.start(store.state.widgets[0], true)
    await store.updateAll()
    expect(api.updateAllWidgets).not.toHaveBeenCalled()
    release()
    await running
  })
})

describe('one row at a time', () => {
  it('names the row that is working, so the others are only disabled', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { store } = make([widget({ id: 'a' }), widget({ id: 'b' })], {
      installWidget: vi.fn(async (id: string) => { await gate; return { ok: true as const, id, version: '1.0.0' } }),
    })
    await store.load()
    const running = store.start(store.state.widgets[0])
    expect(store.state.busy).toBe('a')
    release()
    await running
    expect(store.state.busy).toBeNull()
  })

  it('can be told to read again after a load that failed', async () => {
    // Without the force, `loaded` stays true and `offline` stays true for the life of the page:
    // the Browse tab would keep showing an error nobody could clear.
    let down = true
    const { api, store } = make([widget()], {
      getMarketplace: vi.fn(async () => {
        if (down) throw new Error('offline')
        return answer([widget()])
      }),
    })
    await store.load()
    expect(store.state.offline).toBe(true)
    await store.load()
    expect(api.getMarketplace).toHaveBeenCalledTimes(1)

    down = false
    await store.load(true)
    expect(store.state.offline).toBe(false)
    expect(store.shown.value).toHaveLength(1)
  })
})

describe('after a series', () => {
  const waiting = (over: Partial<MarketplaceWidget> = {}) =>
    widget({ installed: true, installedVersion: '1.0.0', version: '2.0.0', updateAvailable: true, ...over })
  const done = (id: string) => widget({ id, installed: true, installedVersion: '2.0.0', version: '2.0.0' })

  /** The index the server gives back once both widgets have been updated: nothing waits any more. */
  const updated = (ids: string[], results: { id: string; ok: boolean; version?: string; newPermissions?: WidgetPermissionSet }[]) => {
    let calls = 0
    const api: Partial<MarketplaceApi> = {
      getMarketplace: vi.fn(async () => {
        calls += 1
        return answer(calls === 1
          ? ids.map((id) => waiting({ id }))
          : ids.map((id) => (results.find((r) => r.id === id)?.ok ? done(id) : waiting({ id }))))
      }),
      updateAllWidgets: vi.fn(async () => ({ results })),
    }
    return api
  }

  it('keeps a widget it just updated in the Updates view, with its result', async () => {
    const { store } = make([], updated(['a', 'b'], [
      { id: 'a', ok: true, version: '2.0.0' },
      { id: 'b', ok: true, version: '2.0.0' },
    ]))
    await store.load()
    store.setView('updates')
    await store.updateAll()
    // Without this the view is empty: both succeeded, so neither is waiting, and the only thing
    // the button would have left behind is the rows that failed.
    expect(store.shown.value.map((w) => w.id).sort()).toEqual(['a', 'b'])
    expect(store.state.results.a.ok).toBe(true)
    store.setView('installed')
    store.setView('updates')
    expect(store.shown.value).toHaveLength(0)
  })

  it('hands a consent refusal back to the single dialog, on the set the server named', async () => {
    const added = set({ subscriptions: ['system'] })
    const { store } = make([], updated(['a'], [{ id: 'a', ok: false, newPermissions: added }]))
    await store.load()
    await store.updateAll()
    store.state.widgets[0].permissions = set({ commands: ['shortcuts.run'] })
    store.review(store.state.widgets[0])
    expect(store.state.consent?.update).toBe(true)
    expect(store.state.consent?.added).toEqual(added)
    // What is sent is the whole ask: what the entry advertised plus what the server said was new.
    expect(store.state.consent?.send).toEqual(set({ subscriptions: ['system'], commands: ['shortcuts.run'] }))
  })

  it('drops the refusal line once the reviewed widget has actually been updated', async () => {
    const added = set({ subscriptions: ['system'] })
    const { store } = make([], updated(['a'], [{ id: 'a', ok: false, newPermissions: added }]))
    await store.load()
    store.setView('updates')
    await store.updateAll()
    expect(store.state.results.a?.ok).toBe(false)
    store.review(store.state.widgets[0])
    await store.accept()
    expect(store.state.results.a).toBeUndefined()
  })

  it('has nothing to review when the failure was not about consent', async () => {
    const { store } = make([], updated(['a'], [{ id: 'a', ok: false }]))
    await store.load()
    await store.updateAll()
    store.review(store.state.widgets[0])
    expect(store.state.consent).toBeNull()
  })

  it('forgets the results when the panel closes', async () => {
    const { store } = make([], updated(['a'], [{ id: 'a', ok: true, version: '2.0.0' }]))
    await store.load()
    store.setView('updates')
    await store.updateAll()
    store.clearResults()
    expect(store.state.results).toEqual({})
    expect(store.shown.value).toHaveLength(0)
  })
})

describe('the kind switch', () => {
  it('filters on the row own kind, and reads a row without one as a widget', async () => {
    const { store } = make([
      widget({ id: 'clock' }),
      widget({ id: 'dark', kind: 'theme' }),
    ])
    await store.load()
    expect(store.shown.value.map((w) => w.id)).toEqual(['clock'])
    store.state.kind = 'theme'
    expect(store.shown.value.map((w) => w.id)).toEqual(['dark'])
  })

  it('narrows the badge-bearing views too', async () => {
    const { store } = make([
      widget({ id: 'clock', installed: true, installedVersion: '1.0.0' }),
      widget({ id: 'dark', kind: 'theme', installed: true, installedVersion: '1.0.0' }),
    ])
    await store.load()
    store.setView('installed')
    expect(store.shown.value.map((w) => w.id)).toEqual(['clock'])
  })
})

describe('widgets a screen places and this machine does not have', () => {
  const placed = (over: Partial<MarketplaceWidget> = {}) =>
    widget({ placedOn: ['Home'], permissions: set({ subscriptions: ['homey:*'] }), ...over })

  it('counts only what is placed, missing, and installable', async () => {
    const { store } = make([
      placed({ id: 'a' }),
      placed({ id: 'b', installed: true, installedVersion: '1.0.0' }),
      widget({ id: 'c' }),
      placed({ id: 'd', shadowsBuiltin: true }),
      placed({ id: 'e', sdkTooNew: true }),
    ])
    await store.load()
    expect(store.missing.value.map((w) => w.id)).toEqual(['a'])
  })

  it('lists the whole ask, because nothing is granted to a widget that is not installed', async () => {
    const { store } = make([placed({ id: 'a' })])
    await store.load()
    expect(store.installMissingPrompt.value[0].added).toEqual(set({ subscriptions: ['homey:*'] }))
  })

  it('opens nothing when nothing is missing', async () => {
    const { store } = make([widget()])
    await store.load()
    store.askInstallMissing()
    expect(store.state.installMissingOpen).toBe(false)
  })

  it('sends the set each card showed, and `false` for a widget that asks nothing', async () => {
    const { api, store } = make([placed({ id: 'a' }), placed({ id: 'b', permissions: set() })])
    await store.load()
    await store.installMissing()
    expect(api.installMissingWidgets).toHaveBeenCalledWith({
      a: set({ subscriptions: ['homey:*'] }),
      b: false,
    })
  })

  it('keeps one result per widget and re-reads the index once', async () => {
    const { api, store } = make([placed({ id: 'a' }), placed({ id: 'b' })], {
      installMissingWidgets: vi.fn(async () => ({
        results: [
          { id: 'a', ok: true, version: '1.0.0' },
          { id: 'b', ok: false, error: 'the downloaded package does not match the index' },
        ],
      })),
    })
    await store.load()
    await store.installMissing()
    expect(store.state.results.a).toEqual({ ok: true, version: '1.0.0' })
    expect(store.state.results.b.error).toMatch(/does not match/)
    expect(api.getMarketplace).toHaveBeenCalledTimes(2)
    expect(store.state.updatingAll).toBe(false)
  })

  it('does nothing while a single install is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { api, store } = make([placed({ id: 'a' })], {
      installWidget: vi.fn(async (id: string) => { await gate; return { ok: true as const, id, version: '1.0.0' } }),
    })
    await store.load()
    const running = store.start(store.state.widgets[0])
    await store.installMissing()
    expect(api.installMissingWidgets).not.toHaveBeenCalled()
    release()
    await running
  })

  it('shows what went wrong when the whole request fails', async () => {
    const { store } = make([placed({ id: 'a' })], {
      installMissingWidgets: vi.fn(async () => { throw new Error('the registry could not be reached') }),
    })
    await store.load()
    await store.installMissing()
    expect(store.state.error).toMatch(/could not be reached/)
    expect(store.state.updatingAll).toBe(false)
  })
})
