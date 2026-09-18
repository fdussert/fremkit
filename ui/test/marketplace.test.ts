import { describe, expect, it, vi } from 'vitest'
import { createMarketplaceStore, matches, type MarketplaceApi } from '../src/admin/marketplace'
import type { MarketplaceResponse, MarketplaceWidget } from '../src/shared/types'

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
    shadowsBuiltin: false,
    ...over,
  }
}

function answer(widgets: MarketplaceWidget[], over: Partial<MarketplaceResponse> = {}): MarketplaceResponse {
  return { registry: 'fremkit-widgets', generatedAt: '2026-09-18T12:00:00.000Z', widgets, offline: false, sdk: 1, ...over }
}

function make(widgets: MarketplaceWidget[], over: Partial<MarketplaceApi> = {}, onChanged?: () => void) {
  const api: MarketplaceApi = {
    getMarketplace: vi.fn(async () => answer(widgets)),
    refreshMarketplace: vi.fn(async () => answer(widgets)),
    installWidget: vi.fn(async (id: string) => ({ ok: true as const, id, version: '1.0.0' })),
    uninstallWidget: vi.fn(async (id: string) => ({ ok: true as const, id })),
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
    expect(api.installWidget).toHaveBeenCalledWith('demo', { update: false })
  })

  it('opens the dialog first when something is, and installs nothing until it is answered', async () => {
    const asking = widget({ consentNeeded: true, newPermissions: { subscriptions: ['system'], commands: [], network: [] } })
    const { api, store } = make([asking])
    await store.load()
    await store.start(store.state.widgets[0])
    expect(store.state.consent?.added.subscriptions).toEqual(['system'])
    expect(api.installWidget).not.toHaveBeenCalled()

    await store.accept()
    expect(store.state.consent).toBeNull()
    expect(api.installWidget).toHaveBeenCalledWith('demo', { consent: true, update: false })
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
    expect(api.installWidget).toHaveBeenCalledWith('demo', { update: true })
  })

  it('carries the update flag through the dialog', async () => {
    const { api, store } = make([widget({ installed: true, updateAvailable: true, consentNeeded: true })])
    await store.load()
    await store.start(store.state.widgets[0], true)
    expect(store.state.consent?.update).toBe(true)
    await store.accept()
    expect(api.installWidget).toHaveBeenCalledWith('demo', { consent: true, update: true })
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
