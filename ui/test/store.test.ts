import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAdminStore, SAVE_DEBOUNCE_MS, UNDO_LIMIT, type StoreDeps } from '../src/admin/store'
import type { Config, WidgetManifest, WidgetsResponse } from '../src/shared/types'
import { navWidgetsOf } from '../src/shared/types'

/** A promise this test controls: resolve()/reject() it whenever the scenario needs the "server" to answer. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Flush pending microtask chains (promise resolutions triggered outside of fake-timer ticks). */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const clockManifest: WidgetManifest = {
  id: 'clock', name: 'Horloge', version: '1.0.0', sdk: 1, description: '', icon: 'clock',
  minSize: [8, 4], defaultSize: [16, 4], subscriptions: [], commands: [],
  settingsSchema: {}, permissions: { network: [] },
}

function config(): Config {
  return {
    version: 2,
    display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
    connections: [],
    secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false },
    pages: [{ id: 'home', name: 'Accueil', widgets: [
      { instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, showTitle: true, settings: {} },
    ] }],
  }
}

/** The bar only takes widgets whose manifest declares a compact rendering. */
const compactClock: WidgetManifest = { ...clockManifest, compact: { width: 5 } }
const barWidgets: WidgetsResponse = {
  widgets: { clock: compactClock, cpu: { ...compactClock, id: 'cpu' }, plain: clockManifest },
  errors: [], sources: {}, asks: {}, sdk: 1,
}

function make(apiOverrides: Partial<StoreDeps['api']> = {}) {
  const api: StoreDeps['api'] = {
    getConfig: vi.fn(async () => config()),
    getStatus: vi.fn(async () => ({ degraded: false })),
    getWidgets: vi.fn(async (): Promise<WidgetsResponse> => ({ widgets: { clock: clockManifest }, errors: [], sources: {}, asks: {}, sdk: 1 })),
    putConfig: vi.fn(async (c: Config) => c),
    rescan: vi.fn(async (): Promise<WidgetsResponse> => ({ widgets: { clock: clockManifest }, errors: [], sources: {}, asks: {}, sdk: 1 })),
    ...apiOverrides,
  }
  let push: ((c: Config) => void) | null = null
  const store = createAdminStore({ api, subscribeConfig: (cb) => { push = cb; return () => { push = null } } })
  return { store, api, emit: (c: Config) => push?.(c) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('saving', () => {
  it('groups several mutations into a single PUT after the debounce', async () => {
    const { store, api } = make()
    await store.load()
    store.apply((c) => { c.pages[0].widgets[0].x = 4 })
    store.apply((c) => { c.pages[0].widgets[0].x = 8 })
    store.apply((c) => { c.pages[0].widgets[0].x = 12 })
    expect(store.state.status).toBe('saving')
    expect(api.putConfig).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(api.putConfig).toHaveBeenCalledTimes(1)
    expect((api.putConfig as ReturnType<typeof vi.fn>).mock.calls[0][0].pages[0].widgets[0].x).toBe(12)
    expect(store.state.status).toBe('saved')
  })

  it('flush sends the pending change immediately', async () => {
    const { store, api } = make()
    await store.load()
    store.apply((c) => { c.pages[0].name = 'Deux' })
    await store.flush()
    expect(api.putConfig).toHaveBeenCalledTimes(1)
    expect(store.state.status).toBe('saved')
  })
})

describe('single-flight', () => {
  it('a mutation that arrives while a PUT is in flight is sent once more, with the latest config, once it settles', async () => {
    const first = deferred<Config>()
    let calls = 0
    const putConfig = vi.fn(async (c: Config) => { calls++; return calls === 1 ? first.promise : c })
    const { store, api } = make({ putConfig })
    await store.load()

    store.apply((c) => { c.pages[0].widgets[0].x = 4 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(api.putConfig).toHaveBeenCalledTimes(1) // first PUT started, still unresolved

    store.apply((c) => { c.pages[0].widgets[0].x = 8 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    // the debounce for the newer edit elapsed, but the first PUT is still in flight:
    // no second, concurrent PUT may start yet
    expect(api.putConfig).toHaveBeenCalledTimes(1)

    first.resolve(config())
    await tick()
    expect(api.putConfig).toHaveBeenCalledTimes(2)
    expect((api.putConfig as ReturnType<typeof vi.fn>).mock.calls[1][0].pages[0].widgets[0].x).toBe(8)
    await tick()
    expect(store.state.status).toBe('saved')
  })

  it('an older PUT that fails after a newer edit does not reload over it, and retries with the latest config', async () => {
    const first = deferred<Config>()
    const second = deferred<Config>()
    let calls = 0
    const putConfig = vi.fn(async (c: Config) => {
      calls++
      if (calls === 1) return first.promise
      if (calls === 2) return second.promise
      return c
    })
    const getConfig = vi.fn(async () => config())
    const { store, api } = make({ putConfig, getConfig })
    await store.load()
    const getConfigCallsAfterLoad = (api.getConfig as ReturnType<typeof vi.fn>).mock.calls.length

    store.apply((c) => { c.pages[0].widgets[0].x = 4 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    store.apply((c) => { c.pages[0].widgets[0].x = 8 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(api.putConfig).toHaveBeenCalledTimes(1)

    first.reject(new Error('conflit'))
    await tick()

    // the newer edit (x=8) must survive: no reload clobbers it
    expect(store.state.config!.pages[0].widgets[0].x).toBe(8)
    expect(store.state.status).toBe('error')
    expect(store.state.toast).toBe('conflit')
    expect((api.getConfig as ReturnType<typeof vi.fn>).mock.calls.length).toBe(getConfigCallsAfterLoad) // no recovery reload
    expect(api.putConfig).toHaveBeenCalledTimes(2) // one retry already in flight, carrying the latest config
    expect((api.putConfig as ReturnType<typeof vi.fn>).mock.calls[1][0].pages[0].widgets[0].x).toBe(8)

    second.resolve(config())
    await tick()
    expect(store.state.status).toBe('saved')
  })

  it('two rapid mutations during a slow PUT coalesce into a single trailing PUT, sent in order', async () => {
    const first = deferred<Config>()
    const order: number[] = []
    let calls = 0
    const putConfig = vi.fn(async (c: Config) => {
      calls++
      order.push(c.pages[0].widgets[0].x)
      return calls === 1 ? first.promise : c
    })
    const { store, api } = make({ putConfig })
    await store.load()

    store.apply((c) => { c.pages[0].widgets[0].x = 4 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    store.apply((c) => { c.pages[0].widgets[0].x = 8 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    store.apply((c) => { c.pages[0].widgets[0].x = 12 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    // the second PUT only ever starts once the first settles: still just the original call
    expect(api.putConfig).toHaveBeenCalledTimes(1)

    first.resolve(config())
    await tick()
    expect(api.putConfig).toHaveBeenCalledTimes(2)
    expect(order).toEqual([4, 12]) // the intermediate x=8 never went out on its own, and bodies arrived in order
    await tick()
    expect(store.state.status).toBe('saved')
  })

  it('an edit made during the recovery GET is kept, and the GET result is discarded', async () => {
    const fresh = deferred<Config>()
    const getConfig = vi.fn(async () => fresh.promise)
    const putConfig = vi.fn(async () => { throw new Error('boum') })
    const { store } = make({ getConfig, putConfig })
    // load() must resolve before the failing PUT: answer its own getConfig() first.
    fresh.resolve(config())
    await store.load()

    const second = deferred<Config>()
    ;(getConfig as ReturnType<typeof vi.fn>).mockImplementation(async () => second.promise)

    store.apply((c) => { c.pages[0].widgets[0].x = 4 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    await tick()
    // the PUT failed and the recovery GET is in flight; the user keeps editing meanwhile
    store.apply((c) => { c.pages[0].widgets[0].x = 24 })
    second.resolve(config()) // the server still has x = 0
    await tick()

    expect(store.state.config!.pages[0].widgets[0].x).toBe(24)
    expect(store.state.status).toBe('error')
    expect(store.state.toast).toBe('boum')
    // the edit's own debounce still fires, so the pending change is retried
    const before = (putConfig as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    await tick()
    expect((putConfig as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before)
  })
})

describe('degraded server', () => {
  it('raises the banner on load and stops saving', async () => {
    const { store, api } = make({ getStatus: vi.fn(async () => ({ degraded: true })) })
    await store.load()
    expect(store.state.degraded).toBe(true)

    store.apply((c) => { c.pages[0].widgets[0].x = 8 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4)
    expect(api.putConfig).not.toHaveBeenCalled()
    expect(store.state.status).toBe('error')
    expect(store.state.toast).toMatch(/illisible/)
    expect(store.state.config!.pages[0].widgets[0].x).toBe(8) // the local edit is kept
  })

  it('a refused save raises the banner and never reloads over the local config', async () => {
    const putConfig = vi.fn(async () => { throw new Error('configuration sur disque illisible') })
    // Healthy at load time; the file becomes unreadable under the server afterwards.
    let degraded = false
    const getStatus = vi.fn(async () => ({ degraded }))
    const { store, api } = make({ putConfig, getStatus })
    await store.load()
    const getConfigCalls = (api.getConfig as ReturnType<typeof vi.fn>).mock.calls.length
    degraded = true

    store.apply((c) => { c.pages[0].widgets[0].x = 12 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    await tick()

    expect(store.state.degraded).toBe(true)
    expect(store.state.status).toBe('error')
    expect(store.state.config!.pages[0].widgets[0].x).toBe(12)
    expect((api.getConfig as ReturnType<typeof vi.fn>).mock.calls.length).toBe(getConfigCalls)
  })
})

describe('undo / redo', () => {
  it('walks back and forward through the snapshots', async () => {
    const { store } = make()
    await store.load()
    store.apply((c) => { c.pages[0].widgets[0].x = 8 })
    store.apply((c) => { c.pages[0].widgets[0].x = 16 })
    expect(store.canUndo.value).toBe(true)
    store.undo()
    expect(store.state.config!.pages[0].widgets[0].x).toBe(8)
    store.undo()
    expect(store.state.config!.pages[0].widgets[0].x).toBe(0)
    expect(store.canUndo.value).toBe(false)
    store.redo()
    expect(store.state.config!.pages[0].widgets[0].x).toBe(8)
    store.redo()
    expect(store.state.config!.pages[0].widgets[0].x).toBe(16)
    expect(store.canRedo.value).toBe(false)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('a new mutation clears the redo stack and the stack is capped', async () => {
    const { store } = make()
    await store.load()
    store.apply((c) => { c.pages[0].widgets[0].x = 8 })
    store.undo()
    expect(store.canRedo.value).toBe(true)
    store.apply((c) => { c.pages[0].widgets[0].y = 4 })
    expect(store.canRedo.value).toBe(false)
    for (let i = 0; i < UNDO_LIMIT + 10; i++) store.apply((c) => { c.pages[0].widgets[0].x = i % 8 })
    let undone = 0
    while (store.canUndo.value) { store.undo(); undone++ }
    expect(undone).toBe(UNDO_LIMIT)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('drops a selection that no longer exists after an undo', async () => {
    const { store } = make()
    await store.load()
    store.addWidget('clock')
    const added = store.state.config!.pages[0].widgets[1].instanceId
    expect(store.state.selectedId).toBe(added)
    store.undo()
    expect(store.state.selectedId).toBeNull()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('server errors', () => {
  it('shows the message, clears the undo stack and reloads the server config, then settles back to saved', async () => {
    const remote = config()
    remote.pages[0].name = 'Depuis le serveur'
    const { store } = make({
      putConfig: vi.fn(async () => { throw new Error('page home: clock-1 hors grille') }),
      getConfig: vi.fn(async () => remote),
    })
    await store.load()
    store.apply((c) => { c.pages[0].widgets[0].x = 60 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    // The recovery reload succeeded: local now matches the server, so status goes back to
    // 'saved' (an incoming socket push must not be ignored forever because of a past error).
    expect(store.state.status).toBe('saved')
    expect(store.state.toast).toBe('page home: clock-1 hors grille')
    expect(store.state.config!.pages[0].name).toBe('Depuis le serveur')
    expect(store.canUndo.value).toBe(false)
  })

  it('falls back to String(e) for a rejection that is not an Error, never "undefined"', async () => {
    const { store } = make({
      putConfig: vi.fn(async () => { throw 'boom' }), // eslint-disable-line @typescript-eslint/no-throw-literal
      getConfig: vi.fn(async () => config()),
    })
    await store.load()
    store.apply((c) => { c.pages[0].widgets[0].x = 60 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(store.state.toast).toBe('boom')
  })

  it('keeps the error and the local config when the recovery reload also fails', async () => {
    let getConfigCalls = 0
    const { store } = make({
      putConfig: vi.fn(async () => { throw new Error('page home: clock-1 hors grille') }),
      // First call (in load()) succeeds; the recovery call made after the failed save fails too.
      getConfig: vi.fn(async () => {
        getConfigCalls++
        if (getConfigCalls > 1) throw new Error('reseau indisponible')
        return config()
      }),
    })
    await store.load()
    store.apply((c) => { c.pages[0].widgets[0].x = 60 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(store.state.status).toBe('error')
    expect(store.state.toast).toBe('page home: clock-1 hors grille')
    expect(store.state.config!.pages[0].widgets[0].x).toBe(60)
    expect(store.canUndo.value).toBe(false)
  })
})

describe('remote config', () => {
  it('adopts a config pushed on the socket when nothing is pending', async () => {
    const { store, emit } = make()
    await store.load()
    const remote = config()
    remote.pages[0].name = 'Autre onglet'
    emit(remote)
    expect(store.state.config!.pages[0].name).toBe('Autre onglet')
  })

  it('ignores a pushed config while a save is scheduled', async () => {
    const { store, emit } = make()
    await store.load()
    store.apply((c) => { c.pages[0].name = 'Saisie en cours' })
    emit(config())
    expect(store.state.config!.pages[0].name).toBe('Saisie en cours')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('widgets', () => {
  it('addWidget drops the widget in the first free spot and selects it', async () => {
    const { store } = make()
    await store.load()
    store.addWidget('clock')
    expect(store.state.config!.pages[0].widgets[1]).toMatchObject({ widgetId: 'clock', x: 16, y: 0, w: 16, h: 4, showTitle: true })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('addWidget reports when the page is full', async () => {
    const { store } = make()
    await store.load()
    store.apply((c) => { c.pages[0].widgets[0] = { ...c.pages[0].widgets[0], w: 64, h: 16 } })
    store.addWidget('clock')
    expect(store.state.toast).toBe('Pas de place libre sur cette page')
    expect(store.state.config!.pages[0].widgets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('duplicateWidget copies the appearance and settings next to the original', async () => {
    const { store } = make()
    await store.load()
    store.updateInstance('clock-1', { accentMode: 'fill', bgColor: '#123456', title: 'Paris', settings: { seconds: true } })
    store.duplicateWidget('clock-1')
    const copy = store.state.config!.pages[0].widgets[1]
    expect(copy).toMatchObject({ widgetId: 'clock', x: 16, y: 0, w: 16, h: 4, accentMode: 'fill', bgColor: '#123456', title: 'Paris', settings: { seconds: true } })
    expect(copy.instanceId).not.toBe('clock-1')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('others() excludes the given instance', async () => {
    const { store } = make()
    await store.load()
    expect(store.others()).toEqual([{ x: 0, y: 0, w: 16, h: 4 }])
    expect(store.others('clock-1')).toEqual([])
  })
})

describe('moving a tile to another page', () => {
  /** The same fixture with an empty second page to move the clock onto. */
  const twoPages = (): Config => {
    const cfg = config()
    cfg.pages.push({ id: 'two', name: 'Deux', widgets: [] })
    return cfg
  }
  const makeTwo = (mutate: (c: Config) => void = () => {}) => make({
    getConfig: vi.fn(async () => { const c = twoPages(); mutate(c); return c }),
  })

  it('carries the whole instance over and follows it to the target page', async () => {
    const { store } = makeTwo()
    await store.load()
    store.updateInstance('clock-1', { accentMode: 'fill', bgColor: '#123456', title: 'Paris', settings: { seconds: true } })
    store.moveWidget('clock-1', 1)
    expect(store.state.config!.pages[0].widgets).toHaveLength(0)
    expect(store.state.config!.pages[1].widgets[0]).toMatchObject({
      instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4,
      accentMode: 'fill', bgColor: '#123456', title: 'Paris', settings: { seconds: true },
    })
    expect(store.state.pageIndex).toBe(1)
    expect(store.state.selectedId).toBe('clock-1')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('refuses a full target page and changes nothing at all', async () => {
    const { store } = makeTwo((c) => {
      c.pages[1].widgets.push({ instanceId: 'clock-2', widgetId: 'clock', x: 0, y: 0, w: 64, h: 16, showTitle: true, settings: {} })
    })
    await store.load()
    expect(store.canUndo.value).toBe(false)
    store.moveWidget('clock-1', 1)
    expect(store.state.toast).toBe('Pas de place sur Deux pour Horloge')
    expect(store.state.config!.pages[0].widgets).toHaveLength(1)
    expect(store.state.config!.pages[1].widgets).toHaveLength(1)
    expect(store.state.pageIndex).toBe(0)
    // Nothing was applied, so the move left no snapshot behind either.
    expect(store.canUndo.value).toBe(false)
    expect(store.state.status).toBe('saved')
  })

  it('undoes as one step', async () => {
    const { store } = makeTwo()
    await store.load()
    store.moveWidget('clock-1', 1)
    store.undo()
    expect(store.state.config!.pages[0].widgets.map((w) => w.instanceId)).toEqual(['clock-1'])
    expect(store.state.config!.pages[1].widgets).toHaveLength(0)
    expect(store.canUndo.value).toBe(false)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('copying settings from another instance', () => {
  it('copies every key onto another tile, as one undo step', async () => {
    const { store } = make()
    await store.load()
    store.duplicateWidget('clock-1')
    const target = store.state.config!.pages[0].widgets[1].instanceId
    store.updateInstance('clock-1', { settings: { seconds: true, city: 'Paris' } })
    const source = store.state.config!.pages[0].widgets[0]
    // What CopySettingsFrom emits: the whole settings object, through the usual update path.
    store.updateInstance(target, { settings: { ...source.settings } })
    expect(store.state.config!.pages[0].widgets[1].settings).toEqual({ seconds: true, city: 'Paris' })
    store.undo()
    expect(store.state.config!.pages[0].widgets[1].settings).toEqual({})
    expect(store.state.config!.pages[0].widgets[0].settings).toEqual({ seconds: true, city: 'Paris' })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('copies a tile’s settings onto a bar widget, as one undo step', async () => {
    const { store } = make({ getWidgets: vi.fn(async () => barWidgets) })
    await store.load()
    store.addNavWidget('clock')
    const navId = navWidgetsOf(store.state.config!.display)[0].instanceId
    store.updateInstance('clock-1', { settings: { compactDate: true, seconds: true } })
    const source = store.state.config!.pages[0].widgets[0]
    store.updateNavWidget(navId, { settings: { ...source.settings } })
    expect(navWidgetsOf(store.state.config!.display)[0].settings).toEqual({ compactDate: true, seconds: true })
    store.undo()
    expect(navWidgetsOf(store.state.config!.display)[0].settings).toEqual({})
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('nav bar height', () => {
  it('a 40 px bar frees a 17th row, and the default stays an absent key', async () => {
    const { store } = make()
    await store.load()
    store.setNavHeight(40)
    expect(store.state.config!.display).toMatchObject({ navHeight: 40, rows: 17 })
    store.setNavHeight(80)
    expect(store.state.config!.display.navHeight).toBeUndefined()
    expect(store.state.config!.display.rows).toBe(16)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('refuses to give the row back while a widget still occupies it', async () => {
    const { store } = make()
    await store.load()
    store.setNavHeight(40)
    store.updateInstance('clock-1', { y: 13, h: 4 })
    store.setNavHeight(80)
    expect(store.state.toast).toBe('Des widgets occupent la dernière ligne')
    expect(store.state.config!.display).toMatchObject({ navHeight: 40, rows: 17 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('checks every page, not just the one being edited', async () => {
    const { store } = make()
    await store.load()
    store.setNavHeight(40)
    store.duplicatePage(0)
    store.updateInstance(store.state.config!.pages[1].widgets[0].instanceId, { y: 16, h: 1 })
    store.selectPage(0)
    store.setNavHeight(80)
    expect(store.state.toast).toBe('Des widgets occupent la dernière ligne')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('navigation bar widgets', () => {
  const makeBar = () => make({ getWidgets: vi.fn(async () => barWidgets) })
  const bar = (store: ReturnType<typeof make>['store']) => navWidgetsOf(store.state.config!.display)
  const ids = (store: ReturnType<typeof make>['store']) => bar(store).map((w) => w.instanceId)

  it('adds a widget that declares a compact rendering, on the left by default', async () => {
    const { store } = makeBar()
    await store.load()
    // An empty bar is an absent key, not an empty array.
    expect(store.state.config!.display.navWidgets).toBeUndefined()
    store.addNavWidget('clock')
    const [added] = bar(store)
    expect(added).toMatchObject({ widgetId: 'clock', slot: 'left', settings: {} })
    expect(added.instanceId).toMatch(/^clock-/)
    expect(store.canUndo.value).toBe(true)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('refuses a widget without a compact rendering, and an unknown one', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('plain')
    expect(bar(store)).toEqual([])
    expect(store.state.toast).toMatch(/rendu compact/)
    store.addNavWidget('ghost')
    expect(bar(store)).toEqual([])
    expect(store.state.toast).toMatch(/inconnu/)
  })

  it('refuses a widget once the clusters would reach the page dots', async () => {
    // 64 columns, 10 kept for the dots: ten 5-cell clocks fit (50), the eleventh (55) does not.
    const { store } = makeBar()
    await store.load()
    for (let i = 0; i < 11; i++) store.addNavWidget('clock')
    expect(bar(store)).toHaveLength(10)
    expect(store.state.toast).toMatch(/dots|points/)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('moves a widget to the other cluster', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    const [id] = ids(store)
    store.updateNavWidget(id, { slot: 'right' })
    expect(bar(store)[0].slot).toBe('right')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('reorders within a side only, ignoring the widgets of the other one', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    store.addNavWidget('cpu')
    store.addNavWidget('clock')
    const [a, b, c] = ids(store)
    // b sits on the right, between a and c: it must not take part in their ordering.
    store.updateNavWidget(b, { slot: 'right' })

    store.moveNavWidget(c, -1)
    expect(ids(store)).toEqual([c, b, a])
    expect(bar(store).map((w) => w.slot)).toEqual(['left', 'right', 'left'])

    // Each is now at an end of its own side, and b is alone on its side: all no-ops.
    const settled = ids(store)
    store.moveNavWidget(c, -1)
    store.moveNavWidget(a, 1)
    store.moveNavWidget(b, -1)
    store.moveNavWidget(b, 1)
    expect(ids(store)).toEqual(settled)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('patches the settings of one entry', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    const [id] = ids(store)
    store.updateNavWidget(id, { settings: { compactDate: true } })
    expect(bar(store)[0].settings).toEqual({ compactDate: true })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('turns the popover on, and drops the key again when it is turned off', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    const [id] = ids(store)
    store.updateNavWidget(id, { popup: true })
    expect(bar(store)[0].popup).toBe(true)
    expect(store.canUndo.value).toBe(true)
    // Off is stored as a missing key, so an untouched bar keeps the config it had.
    store.updateNavWidget(id, { popup: undefined })
    expect(bar(store)[0].popup).toBeUndefined()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('removes an entry, and drops the key once the bar is empty', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    store.addNavWidget('cpu')
    const [first, second] = ids(store)
    store.removeNavWidget(second)
    expect(ids(store)).toEqual([first])
    store.removeNavWidget(first)
    expect(store.state.config!.display.navWidgets).toBeUndefined()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('undoes an addition back to an absent key', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    store.undo()
    expect(store.state.config!.display.navWidgets).toBeUndefined()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('modals', () => {
  it('starts with no modal open', () => {
    const { store } = make()
    expect(store.state.modal).toBeNull()
  })

  it('opens, switches and closes a modal', () => {
    const { store } = make()
    store.openModal('screen')
    expect(store.state.modal).toBe('screen')
    store.openModal('connections')
    expect(store.state.modal).toBe('connections')
    store.closeModal()
    expect(store.state.modal).toBeNull()
  })

  it('leaves the selection alone: the inspector is no longer a tab', async () => {
    const { store } = make()
    await store.load()
    store.openModal('connections')
    store.select('clock-1')
    expect(store.state.modal).toBe('connections')
    expect(store.state.selectedId).toBe('clock-1')
  })
})
