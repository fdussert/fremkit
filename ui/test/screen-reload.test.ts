import { describe, expect, it, vi } from 'vitest'
import { createAdminStore, type AdminApi } from '../src/admin/store'
import { canvasMenu, type MenuUi } from '../src/admin/canvasMenu'
import { screenMenu } from '../src/admin/menus'
import { onScreenReload, reloadTarget, SCREEN_RELOAD_CHANNEL } from '../src/shared/screenReload'
import { setLocale } from '../src/shared/i18n'
import { isSeparator, type MenuEntry, type MenuItem } from '../src/shared/ui/contextMenu'
import type { Config } from '../src/shared/types'

const screen = (id: string, name: string): Config['screens'][number] => ({
  id, name, kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
  pages: [{ id: `${id}-p`, name: 'Home', items: [] }],
})
const config = (): Config => ({
  version: 4, locale: 'en', connections: [], secrets: { backend: 'file' },
  privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
  widgets: {},
  screens: [screen('edge', 'Edge'), screen('pad', 'iPad')],
})

async function make(reloadScreen: AdminApi['reloadScreen'] = vi.fn(async () => {})) {
  setLocale('en')
  const store = createAdminStore({
    api: {
      getConfig: async () => config(), getStatus: async () => ({ degraded: false }),
      getWidgets: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
      putConfig: async (c) => c, rescan: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
      reloadScreen,
    },
    subscribeConfig: () => () => {},
    debounceMs: 0,
  })
  await store.load()
  return { store, reloadScreen }
}
const ui = (): MenuUi => ({ revealSection: vi.fn(), focusLibrarySearch: vi.fn() })
const find = (menu: MenuEntry[], label: string): MenuItem => {
  const hit = menu.filter((e): e is MenuItem => !isSeparator(e)).find((e) => e.label === label)
  if (!hit) throw new Error(`no "${label}"`)
  return hit
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('Reload the dashboard, in the admin', () => {
  it('reloads the screen being edited from the canvas menu, and says so', async () => {
    const { store, reloadScreen } = await make()
    store.selectScreen('pad')
    find(canvasMenu(store, ui()), 'Reload the dashboard').run!()
    await settle()
    expect(reloadScreen).toHaveBeenCalledWith('pad')
    expect(store.state.info).toBe('Dashboard reloaded on iPad')
    store.dismissInfo()
    expect(store.state.info).toBe('')
  })

  it('reloads the screen whose selector menu it is, whichever is being edited', async () => {
    const { store, reloadScreen } = await make()
    expect(store.screen.value!.id).toBe('edge')
    find(screenMenu(store, 'pad', { rename: vi.fn() }), 'Reload the dashboard').run!()
    await settle()
    expect(reloadScreen).toHaveBeenCalledWith('pad')
    expect(store.screen.value!.id).toBe('edge')
  })

  it('shows the error when the server refuses, and touches nothing', async () => {
    const { store } = await make(vi.fn(async () => { throw new Error('HTTP 404') }))
    const before = JSON.stringify(store.state.config)
    await store.reloadScreen('edge')
    expect(store.state.toast).toBe('HTTP 404')
    expect(store.state.info).toBe('')
    expect(store.canUndo.value).toBe(false)
    expect(JSON.stringify(store.state.config)).toBe(before)
  })

  it('asks nothing for a screen that is not in the config', async () => {
    const { store, reloadScreen } = await make()
    await store.reloadScreen('gone')
    expect(reloadScreen).not.toHaveBeenCalled()
  })
})

describe('onScreenReload, on the dashboard', () => {
  function fakeSocket() {
    const subs = new Map<string, (data: unknown) => void>()
    return {
      subscribe: vi.fn((channel: string, cb: (data: unknown) => void) => { subs.set(channel, cb); return () => subs.delete(channel) }),
      emit: (channel: string, data: unknown) => subs.get(channel)?.(data),
      subs,
    }
  }

  it('reloads only for the screen this page shows, read when the message comes', () => {
    const socket = fakeSocket()
    const reload = vi.fn()
    let shown: string | undefined = 'edge'
    const off = onScreenReload(socket, () => shown, reload)
    expect(socket.subscribe).toHaveBeenCalledWith(SCREEN_RELOAD_CHANNEL, expect.any(Function))
    socket.emit(SCREEN_RELOAD_CHANNEL, { screenId: 'pad', at: 1 })
    expect(reload).not.toHaveBeenCalled()
    socket.emit(SCREEN_RELOAD_CHANNEL, { screenId: 'edge', at: 2 })
    expect(reload).toHaveBeenCalledTimes(1)
    shown = 'pad'
    socket.emit(SCREEN_RELOAD_CHANNEL, { screenId: 'edge', at: 3 })
    expect(reload).toHaveBeenCalledTimes(1)
    // A page showing no screen (a device with none assigned) reloads for none.
    shown = undefined
    socket.emit(SCREEN_RELOAD_CHANNEL, { screenId: 'pad', at: 4 })
    expect(reload).toHaveBeenCalledTimes(1)
    off()
    expect(socket.subs.size).toBe(0)
  })

  it('reads a screen id and nothing else', () => {
    expect(reloadTarget({ screenId: 'a', at: 1 })).toBe('a')
    for (const bad of [null, undefined, 'a', {}, { screenId: 3 }]) expect(reloadTarget(bad)).toBeNull()
  })
})
