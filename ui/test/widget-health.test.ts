/**
 * @vitest-environment jsdom
 *
 * Widget health: what the editor says about a widget that cannot work, and where it sends
 * somebody to fix it. The pieces that draw it are in `widget-health-ui.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { reactive } from 'vue'
import { setLocale } from '../src/shared/i18n'
import {
  computeHealth, describeProblem, healthEntries, pageLevel, screenLevel, widgetHealth, worst,
  type HealthInput,
} from '../src/admin/health'
import { createHealth } from '../src/admin/useHealth'
import { createAdminStore } from '../src/admin/store'
import type { Config, ConnectionSummary, ConnectionTypeInfo, WidgetManifest } from '../src/shared/types'

const base: WidgetManifest = {
  id: 'clock', name: 'Clock', version: '1.0.0', sdk: 1, description: '', icon: 'clock',
  minSize: [8, 4], defaultSize: [16, 4], subscriptions: [], commands: [],
  settingsSchema: {}, permissions: { network: [] },
}
const gh: WidgetManifest = {
  ...base, id: 'gh', name: { fr: 'Actions GitHub', en: 'GitHub Actions' }, subscriptions: ['github:*'],
  settingsSchema: { connection: { type: 'connection', label: { fr: 'Compte', en: 'Account' }, connectionType: 'github' } },
}
const cal: WidgetManifest = {
  ...base, id: 'cal', name: 'Calendar', subscriptions: ['calendar:*'],
  settingsSchema: { calendars: { type: 'connections', label: { fr: 'Calendriers', en: 'Calendars' }, connectionType: 'ics', default: [] } },
}
const usage: WidgetManifest = { ...base, id: 'usage', name: 'Usage', subscriptions: ['claude-usage', 'claude-account'] }

const ghType: ConnectionTypeInfo = {
  id: 'github', name: 'GitHub', description: '', icon: 'github',
  fields: [
    { key: 'host', label: 'Host', required: true },
    { key: 'token', label: 'Token', secret: true, required: true },
  ],
}
const work: ConnectionSummary = { id: 'gh-work', type: 'github', name: 'Work', fields: { host: 'github.com' }, secrets: { token: true } }
const cal1: ConnectionSummary = { id: 'cal-1', type: 'ics', name: 'Holidays', fields: {}, secrets: { url: true } }

function config(widgets: Config['widgets']): Config {
  return {
    version: 4, locale: 'en', connections: [], secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets,
    screens: [
      {
        id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
        nav: [{ instanceId: 'bar-1', slot: 'left' }],
        pages: [
          { id: 'a', name: 'Home', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }] },
          { id: 'b', name: 'Work', items: [{ instanceId: 'gh-1', x: 0, y: 0, w: 16, h: 4 }] },
        ],
      },
      {
        id: 'ipad', name: 'iPad', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
        pages: [{ id: 'c', name: 'Main', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }] }],
      },
    ],
  }
}

function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    config: config({
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
      'gh-1': { widgetId: 'gh', showTitle: false, settings: { connection: 'gh-work' } },
      'bar-1': { widgetId: 'clock', showTitle: false, settings: {} },
    }),
    manifests: { clock: base, gh, cal, usage },
    connections: [work, cal1],
    connectionTypes: [ghType],
    channels: {},
    market: [],
    ...over,
  }
}
const one = (widget: Config['widgets'][string], over: Partial<HealthInput> = {}) => widgetHealth(widget, input(over))

beforeEach(() => setLocale('en'))

describe('a widget’s health', () => {
  it('is well when nothing says otherwise, including a channel never polled', () => {
    expect(one({ widgetId: 'gh', showTitle: false, settings: { connection: 'gh-work' } })).toEqual({ level: 'ok', problems: [], update: null })
  })

  it('is an error when the widget is not installed, offering the registry when it has it', () => {
    const h = one({ widgetId: 'homey', showTitle: false, settings: {} }, { market: [{ id: 'homey', updateAvailable: false, installable: true }] })
    expect(h.level).toBe('error')
    expect(h.problems[0]).toMatchObject({ code: 'missing', action: { kind: 'install', widgetId: 'homey' } })
    // Nobody has it: reading the folders again is all there is.
    expect(one({ widgetId: 'homey', showTitle: false, settings: {} }).problems[0].action).toEqual({ kind: 'rescan' })
  })

  it('points at the connection when its provider says the credentials are refused', () => {
    const h = one({ widgetId: 'gh', showTitle: false, settings: { connection: 'gh-work' } }, { channels: { 'github:gh-work': 'unauthorized' } })
    expect(h.level).toBe('error')
    expect(h.problems[0]).toMatchObject({ code: 'unauthorized', action: { kind: 'connection', id: 'gh-work' } })
    expect(describeProblem(h.problems[0])).toBe('Its data source refuses the credentials.')
  })

  it('only reads the channel of the connection its settings name', () => {
    const h = one({ widgetId: 'gh', showTitle: false, settings: { connection: 'gh-work' } }, {
      channels: { 'github:gh-other': 'unauthorized', 'calendar:gh-work': 'offline' },
    })
    expect(h.level).toBe('ok')
  })

  it('is a warning, not an error, when the source is only out of reach', () => {
    const h = one({ widgetId: 'gh', showTitle: false, settings: { connection: 'gh-work' } }, { channels: { 'github:gh-work': 'offline' } })
    expect(h).toMatchObject({ level: 'warning', problems: [{ code: 'offline' }] })
  })

  it('names an unknown code without guessing what it means', () => {
    const h = one({ widgetId: 'usage', showTitle: false, settings: {} }, { channels: { 'claude-usage': 'exception' } })
    expect(h.problems[0]).toMatchObject({ level: 'error', code: 'failing', error: 'exception', action: { kind: 'reload' } })
    expect(describeProblem(h.problems[0])).toContain('exception')
  })

  it('leaves alone a reading the user has not turned on', () => {
    expect(one({ widgetId: 'usage', showTitle: false, settings: {} }, { channels: { 'claude-account': 'disabled' } }).level).toBe('ok')
    // Unconfigured on a provider of this Mac's own is something to turn on in the Screen panel.
    expect(one({ widgetId: 'usage', showTitle: false, settings: {} }, { channels: { 'claude-account': 'unconfigured' } }).problems[0])
      .toMatchObject({ level: 'warning', action: { kind: 'screen' } })
  })

  it('says a connection field left empty, and offers to create one when none exists', () => {
    const empty = { widgetId: 'gh', showTitle: false, settings: {} }
    expect(one(empty).problems[0]).toMatchObject({ level: 'warning', code: 'connectionUnset', detail: 'Account', action: { kind: 'settings', field: 'connection' } })
    expect(one(empty, { connections: [] }).problems[0].action).toEqual({ kind: 'newConnection', type: 'github' })
    // A `connections` field with nothing ticked is just as idle.
    expect(one({ widgetId: 'cal', showTitle: false, settings: {} }).problems[0]).toMatchObject({ code: 'connectionUnset', detail: 'Calendars' })
  })

  it('says when the connection chosen was deleted', () => {
    const h = one({ widgetId: 'gh', showTitle: false, settings: { connection: 'gone' } })
    expect(h.problems[0]).toMatchObject({ level: 'error', code: 'connectionGone', action: { kind: 'settings', field: 'connection' } })
  })

  it('says nothing about connections before they are loaded', () => {
    expect(one({ widgetId: 'gh', showTitle: false, settings: { connection: 'gone' } }, { connections: null }).level).toBe('ok')
  })

  it('flags a connection missing a required secret, once, even when its provider says so too', () => {
    const noToken = { ...work, secrets: { token: false } }
    const h = one({ widgetId: 'gh', showTitle: false, settings: { connection: 'gh-work' } }, {
      connections: [noToken], channels: { 'github:gh-work': 'unconfigured' },
    })
    expect(h.problems.map((p) => p.code)).toEqual(['connectionIncomplete'])
    expect(h.problems[0]).toMatchObject({ detail: 'Work', action: { kind: 'connection', id: 'gh-work' } })
  })

  it('says an update is news, not a problem', () => {
    const market = [{ id: 'gh', updateAvailable: true, version: '1.2.0', installable: false }]
    const h = one({ widgetId: 'gh', showTitle: false, settings: { connection: 'gh-work' } }, { market })
    expect(h).toEqual({ level: 'update', problems: [], update: { widgetId: 'gh', version: '1.2.0' } })
  })

  it('keeps a problem’s level when an update waits too', () => {
    const h = one({ widgetId: 'gh', showTitle: false, settings: { connection: 'gh-work' } }, {
      channels: { 'github:gh-work': 'offline' }, market: [{ id: 'gh', updateAvailable: true, installable: false }],
    })
    expect(h.problems.map((p) => p.code)).toEqual(['offline'])
    expect(h.level).toBe('warning')
    expect(h.update).toEqual({ widgetId: 'gh', version: null })
  })

  it('never puts a value of a setting or a provider message in its sentence', () => {
    // A thrown message never reaches the editor (the server sends codes), and the sentence names
    // the field's label rather than what is in it.
    const h = one({ widgetId: 'gh', showTitle: false, settings: { connection: 'someone@example.com' } })
    expect(h.problems.map(describeProblem).join(' ')).not.toContain('example.com')
  })
})

describe('health across the dashboard', () => {
  const all = computeHealth(input({ channels: { 'github:gh-work': 'unauthorized' } }))
  const cfg = input().config

  it('marks the page and the screen holding the widget, and no other', () => {
    expect(pageLevel(all, cfg.screens[0].pages[0])).toBe('ok')
    expect(pageLevel(all, cfg.screens[0].pages[1])).toBe('error')
    expect(screenLevel(all, cfg.screens[0])).toBe('error')
    expect(screenLevel(all, cfg.screens[1])).toBe('ok')
  })

  it('counts a bar widget on its screen', () => {
    const h = computeHealth(input({ config: config({
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
      'gh-1': { widgetId: 'gh', showTitle: false, settings: { connection: 'gh-work' } },
      'bar-1': { widgetId: 'missing-one', showTitle: false, settings: {} },
    }) }))
    expect(screenLevel(h, cfg.screens[0])).toBe('error')
    const entries = healthEntries(cfg, h, 'edge')
    expect(entries.map((e) => [e.instanceId, e.place.pageIndex])).toEqual([['bar-1', null]])
  })

  it('lists every widget that is not well, with where it is', () => {
    const entries = healthEntries(cfg, all, 'edge')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ instanceId: 'gh-1', place: { screenId: 'edge', pageIndex: 1, pageName: 'Work' } })
  })

  it('takes the worst level, an update below a warning', () => {
    expect(worst(['ok', 'warning', 'ok'])).toBe('warning')
    expect(worst(['warning', 'error'])).toBe('error')
    expect(worst(['update', 'ok'])).toBe('update')
    expect(worst(['update', 'warning', 'update'])).toBe('warning')
    expect(worst(['error', 'update'])).toBe('error')
    expect(worst([])).toBe('ok')
  })

  it('leaves an update out of the dots and the list of what to fix', () => {
    const h = computeHealth(input({ market: [{ id: 'clock', updateAvailable: true, version: '2.0.0', installable: false }] }))
    expect(h['clock-1'].level).toBe('update')
    expect(pageLevel(h, cfg.screens[0].pages[0])).toBe('ok')
    expect(screenLevel(h, cfg.screens[0])).toBe('ok')
    expect(screenLevel(h, cfg.screens[1])).toBe('ok')
    expect(healthEntries(cfg, h, 'edge')).toEqual([])
    // A problem elsewhere on the screen still marks it.
    const both = computeHealth(input({
      channels: { 'github:gh-work': 'offline' },
      market: [{ id: 'clock', updateAvailable: true, installable: false }],
    }))
    expect(screenLevel(both, cfg.screens[0])).toBe('warning')
    expect(healthEntries(cfg, both, 'edge').map((e) => e.instanceId)).toEqual(['gh-1'])
  })
})

describe('fixing from the editor', () => {
  async function setup() {
    const store = createAdminStore({
      api: {
        getConfig: async () => input().config, getStatus: async () => ({ degraded: false }),
        getWidgets: async () => ({ widgets: { clock: base, gh }, errors: [], sources: {}, asks: {}, sdk: 1 }),
        putConfig: async (c) => c, rescan: async () => ({ widgets: { clock: base, gh }, errors: [], sources: {}, asks: {}, sdk: 1 }),
      },
      subscribeConfig: () => () => {},
      debounceMs: 0,
    })
    await store.load()
    let push: (data: unknown) => void = () => {}
    const connections = {
      state: { types: [ghType], connections: [work], loaded: true, busy: false, error: '' },
      load: vi.fn(async () => {}),
    }
    const market = { state: reactive({ widgets: [] as { id: string; version: string; updateAvailable: boolean; installed: boolean }[] }), setView: vi.fn(), start: vi.fn(async () => {}) }
    const ui = { revealSection: vi.fn() }
    const health = createHealth({
      store, connections: connections as never, market: market as never, ui,
      subscribe: (cb) => { push = cb; return () => {} },
    })
    return { store, health, push: (d: unknown) => push(d), ui, market }
  }

  it('follows the channel live', async () => {
    const { health, push } = await setup()
    expect(health.of('gh-1').level).toBe('ok')
    push({ channels: { 'github:gh-work': 'offline' } })
    expect(health.of('gh-1').level).toBe('warning')
    push({ channels: { 'github:gh-work': null } })
    expect(health.of('gh-1').level).toBe('ok')
    // Something that is not a snapshot is read as "nothing known".
    push(null)
    expect(health.of('gh-1').level).toBe('ok')
  })

  it('opens the connection, the settings on the widget’s page, or the registry', async () => {
    const { store, health, ui, market } = await setup()
    health.run('gh-1', { kind: 'connection', id: 'gh-work' })
    expect(store.state.modal).toBe('connections')
    expect(store.state.editConnectionId).toBe('gh-work')
    store.closeModal()

    health.run('gh-1', { kind: 'settings', field: 'connection' })
    expect(store.state.pageIndex).toBe(1)
    expect(store.state.selectedId).toBe('gh-1')
    expect(ui.revealSection).toHaveBeenCalledWith('widget.settings')

    health.run('gh-1', { kind: 'update', widgetId: 'gh' })
    expect(store.state.modal).toBe('marketplace')
    expect(market.setView).toHaveBeenCalledWith('updates')
  })

  it('names the first problem’s fix for the menus, and nothing for a widget that is well', async () => {
    const { health, push } = await setup()
    expect(health.fix('gh-1')).toBeNull()
    push({ channels: { 'github:gh-work': 'unauthorized' } })
    expect(health.fix('gh-1')?.label).toBe('Fix: Open the connection')
  })

  it('offers an update as a plain item, never as a fix', async () => {
    const { health, market } = await setup()
    expect(health.update('gh-1')).toBeNull()
    market.state.widgets = [{ id: 'gh', version: '1.2.0', updateAvailable: true, installed: true }]
    expect(health.of('gh-1').level).toBe('update')
    expect(health.fix('gh-1')).toBeNull()
    expect(health.update('gh-1')?.label).toBe('Update to v1.2.0')
    expect(health.entries.value).toEqual([])
  })
})
