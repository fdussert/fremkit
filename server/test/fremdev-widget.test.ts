import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { COMPANION_DEV_CHANNEL } from '../src/companion/dev.js'
import { COMPANION_SERVERS_CHANNEL } from '../src/companion/servers/provider.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'

/**
 * The Fremdev widget: its manifest as the catalogue reads it, and `widgets/fremdev/logic.js`, the
 * pure half of the page — which state a `companion:dev` snapshot puts on screen, the colour of
 * each row and the order the rows come in.
 */
const SHIPPED = fileURLToPath(new URL('../../widgets', import.meta.url))

type Light = 'red' | 'orange' | 'green'
interface Row { tabId: number; deviceId: string; browser: string; light: Light; seen: boolean; app: string; activity: number; report: boolean; features: string[] }
type EntryState = 'open' | 'seen' | 'resolved'
interface EntryView {
  kind: 'error' | 'request' | 'limited' | 'build' | 'slow' | 'perf'; time: number; text: string; origin: string | null; n: number; state: EntryState; noAnswer: boolean; ms?: number | null
  metric?: string; value?: number; ratio?: number | null
}
interface Logic {
  stateOf(snapshot: unknown): string
  lightOf(tab: unknown): Light
  stateOfTab(tab: unknown): { light: Light; seen: boolean }
  hasUnseen(tab: unknown): boolean
  rowsOf(snapshot: unknown): Row[]
  hasFeature(row: unknown, name: string): boolean
  openable(row: unknown, entry: unknown): boolean
  summaryOf(snapshot: unknown): { light: Light; seen: boolean; errors: number }
  onMac(loc: unknown): boolean
  entryView(entry: unknown): EntryView | null
  perfView(perf: unknown): Array<{ key: string; value: number; poor: boolean; dim: boolean }>
  requestsFact(row: unknown): { perf: EntryView | null; neutral: boolean }
  shotOf(row: unknown, now: number): { thumb: string | null; until: number } | null
  formatUptime(sec: unknown, locale?: string): string
  formatMem(kb: unknown, locale?: string): string
  serverRows(snapshot: unknown, showAll: boolean): Array<{ id: string; pid: number; key: string; ports: number[]; project: string }>
  serverKey(row: unknown): string
  serverActions(row: unknown, canRestart: boolean): { open: boolean; reveal: boolean; kill: boolean; restart: boolean }
  serverLight(row: unknown): 'green' | 'grey' | 'red'
  serversStateOf(snapshot: unknown, showAll: boolean): string
}

async function loadLogic(): Promise<Logic> {
  const src = await readFile(fileURLToPath(new URL('../../widgets/fremdev/logic.js', import.meta.url)), 'utf8')
  const scope: Record<string, unknown> = {}
  new Function('globalThis', src)(scope)
  expect(Object.keys(scope)).toEqual(['FremkitFremdev'])
  return scope.FremkitFremdev as Logic
}

const DEV_A = '5b1f7c1e-8d4e-4b8a-9c39-0a6f2c1d7e01'
const DEV_B = '9a0d3e44-3c1b-4f7e-8a2b-1f5e6d7c8b90'
const DEV_C = '0c2e4a6b-8d1f-4c3e-9a5b-7d9f1b3c5e70'

const tally = (open: number, total: number, seen: number, last: unknown = null) => ({ open, total, seen, last })
/** `[open, total]` or `[open, total, seen]` for each tally. */
type Counts = [number, number] | [number, number, number]
function tab(tabId: number, over: { errors?: Counts; requests?: Counts; server?: 'up' | 'down'; activity?: number } = {}) {
  const [eo, et, es = 0] = over.errors ?? [0, 0]
  const [ro, rt, rs = 0] = over.requests ?? [0, 0]
  return {
    tabId, app: `App ${tabId}`, host: `localhost:${5170 + tabId}`,
    errors: tally(eo, et, es, et > 0 ? { text: 'TypeError: x is undefined', at: 1000 } : null),
    requests: tally(ro, rt, rs, rt > 0 ? { path: '/api/items', status: 500, at: 1000 } : null),
    history: [],
    server: over.server ?? 'up',
    activity: over.activity ?? 1000,
  }
}
const install = (deviceId: string, tabs: unknown[], on = true, name = 'Chrome', connected = true, report = false) =>
  ({ deviceId, name, on, connected, report, tabs })
/** A listed install whose socket is closed: the extension's idle state, no rows. */
const idle = (deviceId: string, on = true, name = 'Chrome') => install(deviceId, [], on, name, false)
const snap = (installs: unknown[], over: { enabled?: boolean; paired?: number } = {}) =>
  ({ enabled: over.enabled ?? true, paired: over.paired ?? 1, installs })

describe('the fremdev manifest', () => {
  it('the fremdev manifest subscribes to and commands companion:dev and companion:servers', async () => {
    const cat = new WidgetCatalog(SHIPPED)
    await cat.scan()
    expect(cat.errors.filter((e) => e.id === 'fremdev')).toEqual([])
    const entry = cat.entry('fremdev')!
    expect(entry.source).toBe('builtin')
    const m = entry.manifest
    expect(m.name).toEqual({ fr: 'Fremdev', en: 'Fremdev' })
    expect(m.description).toEqual({ fr: 'Les erreurs de vos onglets de développement et vos serveurs de dev', en: 'The errors of your development tabs and your dev servers' })
    expect(m.category).toBe('dev')
    expect(m.icon).toBe('code')
    expect(m.subscriptions).toEqual([COMPANION_DEV_CHANNEL, COMPANION_SERVERS_CHANNEL])
    expect(m.commands).toEqual([COMPANION_DEV_CHANNEL, COMPANION_SERVERS_CHANNEL])
    expect(m.minSize).toEqual([8, 4])
    expect(m.defaultSize).toEqual([20, 8])
    expect(m.compact).toEqual({ width: 2 })
    expect(m.settingsSchema).toEqual({
      showAllListeners: { type: 'boolean', default: false, label: { fr: 'Montrer tous les programmes qui écoutent', en: 'Show every listening program' } },
    })
  })

  it('loads its pure half before the script that uses it, and writes text through textContent only', async () => {
    const html = await readFile(fileURLToPath(new URL('../../widgets/fremdev/index.html', import.meta.url)), 'utf8')
    const at = html.indexOf('<script src="logic.js"></script>')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(html.indexOf('FremkitFremdev'))
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  })

  it('says where it shows, in both languages, before subscribing to anything', async () => {
    const html = await readFile(fileURLToPath(new URL('../../widgets/fremdev/index.html', import.meta.url)), 'utf8')
    expect(html).toContain("elsewhere: { fr: 'Fremdev ne s\\'affiche que sur l\\'Edge du Mac.', en: 'Fremdev only shows on the Mac\\'s Edge.' }")
    const check = html.indexOf('if (!FD.onMac(location))')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(html.indexOf('Fremkit.subscribe(CHANNEL'))
  })
})

describe('fremdev/logic.js', () => {
  it('stateOf walks loading, off, unpaired, offline, moduleOff, empty, rows', async () => {
    const { stateOf } = await loadLogic()
    expect(stateOf(null)).toBe('loading')
    expect(stateOf(undefined)).toBe('loading')
    expect(stateOf(snap([install(DEV_A, [tab(1)])], { enabled: false }))).toBe('off')
    expect(stateOf(snap([], { paired: 0 }))).toBe('unpaired')
    expect(stateOf(snap([]))).toBe('offline')
    expect(stateOf(snap([install(DEV_A, [tab(1)], false)]))).toBe('moduleOff')
    expect(stateOf(snap([install(DEV_A, [])]))).toBe('empty')
    // Rows of an install with the module off do not count.
    expect(stateOf(snap([install(DEV_A, []), install(DEV_B, [tab(1)], false)]))).toBe('empty')
    expect(stateOf(snap([install(DEV_A, [tab(1)])]))).toBe('rows')
  })

  it('an install listed but not connected is idle, never offline', async () => {
    const { stateOf } = await loadLogic()
    // No dev tab open: the extension closed its socket. Fremdev on: nothing to show, not an outage.
    expect(stateOf(snap([idle(DEV_A)]))).toBe('empty')
    expect(stateOf(snap([idle(DEV_A, false)]))).toBe('moduleOff')
    expect(stateOf(snap([idle(DEV_A, false), install(DEV_B, [])]))).toBe('empty')
    expect(stateOf(snap([idle(DEV_A), install(DEV_B, [tab(1)])]))).toBe('rows')
    // Offline only while no install at all said hello since Fremkit started.
    expect(stateOf(snap([], { paired: 2 }))).toBe('offline')
  })

  it('onMac: this Mac is plain http, a paired device the TLS listener', async () => {
    const { onMac } = await loadLogic()
    expect(onMac({ protocol: 'http:' })).toBe(true)
    expect(onMac({ protocol: 'https:' })).toBe(false)
    expect(onMac(null)).toBe(false)
  })

  it('lightOf: an open error or a down server is red, an open failed request orange, resolved counters green', async () => {
    const { lightOf } = await loadLogic()
    expect(lightOf(tab(1, { errors: [1, 1] }))).toBe('red')
    expect(lightOf(tab(1, { server: 'down' }))).toBe('red')
    expect(lightOf(tab(1, { errors: [2, 3], requests: [1, 1] }))).toBe('red')
    expect(lightOf(tab(1, { requests: [1, 4] }))).toBe('orange')
    expect(lightOf(tab(1, { errors: [0, 5], requests: [0, 2] }))).toBe('green')
    expect(lightOf(tab(1))).toBe('green')
  })

  it('stateOfTab: issues all marked seen keep their colour, seen; anything unseen or a down server is not', async () => {
    const { stateOfTab, hasUnseen } = await loadLogic()
    expect(stateOfTab(tab(1, { errors: [2, 2, 2] }))).toEqual({ light: 'red', seen: true })
    expect(stateOfTab(tab(1, { requests: [1, 1, 1] }))).toEqual({ light: 'orange', seen: true })
    // A new error after the ×: unseen again.
    expect(stateOfTab(tab(1, { errors: [3, 3, 2] }))).toEqual({ light: 'red', seen: false })
    // An unseen request outranks seen errors.
    expect(stateOfTab(tab(1, { errors: [2, 2, 2], requests: [1, 1] }))).toEqual({ light: 'orange', seen: false })
    expect(stateOfTab(tab(1, { errors: [2, 2, 2], requests: [1, 1, 1] }))).toEqual({ light: 'red', seen: true })
    // A server down is never seen.
    expect(stateOfTab(tab(1, { errors: [2, 2, 2], server: 'down' }))).toEqual({ light: 'red', seen: false })
    expect(stateOfTab(tab(1, { errors: [0, 5] }))).toEqual({ light: 'green', seen: false })
    expect(stateOfTab(null)).toEqual({ light: 'green', seen: false })
    expect(hasUnseen(tab(1, { errors: [2, 2, 2] }))).toBe(false)
    expect(hasUnseen(tab(1, { errors: [2, 2, 2], requests: [1, 1] }))).toBe(true)
    expect(hasUnseen(tab(1, { errors: [3, 3, 2] }))).toBe(true)
    expect(hasUnseen(tab(1, { errors: [0, 3] }))).toBe(false)
    expect(hasUnseen(null)).toBe(false)
  })

  it('rowsOf puts unseen red, unseen orange, seen red, seen orange, then green', async () => {
    const { rowsOf } = await loadLogic()
    const rows = rowsOf(snap([install(DEV_A, [
      tab(1, { activity: 50 }),
      tab(2, { requests: [1, 1, 1], activity: 40 }),
      tab(3, { errors: [1, 1, 1], activity: 10 }),
      tab(4, { errors: [1, 1, 1], activity: 30 }),
      tab(5, { requests: [1, 1], activity: 1 }),
      tab(6, { errors: [2, 2, 1], activity: 2 }),
    ])]))
    expect(rows.map((r) => [r.tabId, r.light, r.seen])).toEqual([
      [6, 'red', false], [5, 'orange', false], [4, 'red', true], [3, 'red', true], [2, 'orange', true], [1, 'green', false],
    ])
  })

  it('rowsOf sorts red, orange, green, then the latest activity first, and skips installs with fremdev off', async () => {
    const { rowsOf } = await loadLogic()
    const rows = rowsOf(snap([
      install(DEV_A, [
        tab(1, { activity: 10 }),
        tab(2, { requests: [1, 1], activity: 5 }),
        tab(3, { activity: 30 }),
        tab(4, { errors: [1, 1], activity: 1 }),
      ], true, 'Chrome'),
      install(DEV_B, [tab(9, { errors: [3, 3], activity: 99 })], false, 'Edge'),
      install(DEV_C, [tab(6, { server: 'down', activity: 20 }), tab(5, { activity: 30 })], true, 'Brave'),
    ]))
    expect(rows.map((r) => [r.tabId, r.light])).toEqual([
      [6, 'red'], [4, 'red'], [2, 'orange'], [3, 'green'], [5, 'green'], [1, 'green'],
    ])
    expect(rows[0]).toMatchObject({ deviceId: DEV_C, browser: 'Brave', app: 'App 6', light: 'red' })
    expect(rows[1]).toMatchObject({ deviceId: DEV_A, browser: 'Chrome' })
    expect(rowsOf(null)).toEqual([])
    expect(rowsOf(snap([install(DEV_A, [tab(1)])], { enabled: false }))).toEqual([])
  })

  it('summaryOf takes the worst light and sums the open errors', async () => {
    const { summaryOf } = await loadLogic()
    expect(summaryOf(null)).toEqual({ light: 'green', seen: false, errors: 0 })
    expect(summaryOf(snap([install(DEV_A, [])]))).toEqual({ light: 'green', seen: false, errors: 0 })
    expect(summaryOf(snap([install(DEV_A, [tab(1, { requests: [1, 1] }), tab(2, { errors: [0, 4] })])]))).toEqual({ light: 'orange', seen: false, errors: 0 })
    expect(summaryOf(snap([
      install(DEV_A, [tab(1, { errors: [2, 3] }), tab(2, { requests: [1, 1] })]),
      install(DEV_B, [tab(3, { errors: [4, 4] })]),
      install(DEV_C, [tab(4, { errors: [7, 7] })], false),
    ]))).toEqual({ light: 'red', seen: false, errors: 6 })
  })

  it('summaryOf: the worst unseen colour, else the worst seen one hollow; the count is unseen errors only', async () => {
    const { summaryOf } = await loadLogic()
    // An unseen orange outranks a seen red.
    expect(summaryOf(snap([install(DEV_A, [tab(1, { errors: [3, 3, 3] }), tab(2, { requests: [1, 1] })])])))
      .toEqual({ light: 'orange', seen: false, errors: 0 })
    expect(summaryOf(snap([install(DEV_A, [tab(1, { errors: [3, 3, 3] }), tab(2, { requests: [1, 1, 1] })])])))
      .toEqual({ light: 'red', seen: true, errors: 0 })
    expect(summaryOf(snap([install(DEV_A, [tab(1, { requests: [2, 2, 2] }), tab(2)])])))
      .toEqual({ light: 'orange', seen: true, errors: 0 })
    // Two new errors on top of three seen: red, and the count says two.
    expect(summaryOf(snap([install(DEV_A, [tab(1, { errors: [5, 5, 3] }), tab(2, { errors: [1, 1, 1] })])])))
      .toEqual({ light: 'red', seen: false, errors: 2 })
  })

  it('rowsOf copies the install\'s features onto each of its rows, [] when absent, and hasFeature reads them', async () => {
    const { rowsOf, hasFeature } = await loadLogic()
    const rows = rowsOf(snap([
      { ...install(DEV_A, [tab(1, { activity: 3 })]), features: ['fremdev.open', 'fremdev.reload'] },
      install(DEV_B, [tab(2, { activity: 2 })]),
      { ...install(DEV_C, [tab(3, { activity: 1 })]), features: 'fremdev.open' },
    ]))
    expect(rows.map((r) => [r.tabId, r.features])).toEqual([[1, ['fremdev.open', 'fremdev.reload']], [2, []], [3, []]])
    expect(hasFeature(rows[0], 'fremdev.open')).toBe(true)
    expect(hasFeature(rows[0], 'fremdev.shot')).toBe(false)
    expect(hasFeature(rows[1], 'fremdev.open')).toBe(false)
    expect(hasFeature(null, 'fremdev.open')).toBe(false)
    expect(hasFeature({ features: 'fremdev.open' }, 'fremdev.open')).toBe(false)
  })

  it('openable: a build entry with a file, or a Vite error thrown on the page\'s origin, for an install with fremdev.open', async () => {
    const { openable } = await loadLogic()
    const row = (devServer: string | null, features = ['fremdev.open']) => ({ devServer, features })
    const build = { kind: 'build', id: 1, text: 'x', file: '~/app/src/App.vue', line: 1, col: 1, n: 1, at: 1, state: 'open' }
    const error = (origin: string | null) => ({ kind: 'error', id: 2, text: 'x', origin, n: 1, at: 1, state: 'open' })
    expect(openable(row('next'), build)).toBe(true)
    expect(openable(row('vite'), build)).toBe(true)
    expect(openable(row('webpack'), build)).toBe(true)
    // A build entry under an unknown dev server: the extension would open nothing, so no button.
    expect(openable(row(null), build)).toBe(false)
    expect(openable(row('parcel'), build)).toBe(false)
    expect(openable(row('vite'), error('/src/main.ts:1:1'))).toBe(true)
    // Not without the feature, nor for a build entry with no file.
    expect(openable(row('vite', []), build)).toBe(false)
    expect(openable(row('vite', []), error('/src/main.ts:1:1'))).toBe(false)
    expect(openable(row('vite'), { ...build, file: null })).toBe(false)
    // An error only under Vite, and only on the page's own origin.
    expect(openable(row('next'), error('/_next/static/chunks/app/page.js:1:2'))).toBe(false)
    expect(openable(row('webpack'), error('/main.js:1:2'))).toBe(false)
    expect(openable(row('vite'), error('cdn.example.com/lib.js:1:2'))).toBe(false)
    expect(openable(row('vite'), error('//evil.example/x.js:1:1'))).toBe(false)
    expect(openable(row('vite'), error(null))).toBe(false)
    expect(openable(row('vite'), { kind: 'request', id: 3, method: 'GET', path: '/api', status: 500, n: 1, at: 1, state: 'open' })).toBe(false)
    expect(openable(null, build)).toBe(false)
    expect(openable(row('vite'), null)).toBe(false)
  })

  it('rowsOf carries the install\'s report flag onto each of its rows, false when absent', async () => {
    const { rowsOf } = await loadLogic()
    const rows = rowsOf(snap([
      install(DEV_A, [tab(1, { activity: 2 })], true, 'Chrome', true, true),
      install(DEV_B, [tab(2, { activity: 1 })], true, 'Edge', true, false),
      { deviceId: DEV_C, name: 'Brave', on: true, connected: true, tabs: [tab(3, { activity: 0 })] },
    ]))
    expect(rows.map((r) => [r.tabId, r.report])).toEqual([[1, true], [2, false], [3, false]])
  })

  it('entryView: an error keeps its text and origin, in each state', async () => {
    const { entryView } = await loadLogic()
    for (const state of ['open', 'seen', 'resolved'] as const) {
      expect(entryView({ kind: 'error', text: 'TypeError: x is undefined', origin: '/src/App.vue:12:5', n: 3, at: 1234, state }))
        .toEqual({ kind: 'error', time: 1234, text: 'TypeError: x is undefined', origin: '/src/App.vue:12:5', n: 3, state, noAnswer: false })
    }
    expect(entryView({ kind: 'error', text: 'boom', origin: null, n: 1, at: 5, state: 'open' }))
      .toMatchObject({ origin: null, n: 1 })
  })

  it('entryView: a request reads METHOD path status, with no origin', async () => {
    const { entryView } = await loadLogic()
    expect(entryView({ kind: 'request', method: 'POST', path: '/api/cart', status: 500, n: 2, at: 77, state: 'seen' }))
      .toEqual({ kind: 'request', time: 77, text: 'POST /api/cart 500', origin: null, n: 2, state: 'seen', noAnswer: false })
    expect(entryView({ kind: 'request', method: 'GET', path: '/api/items', status: 404, n: 1, at: 1, state: 'resolved' }))
      .toMatchObject({ text: 'GET /api/items 404', state: 'resolved' })
  })

  it('entryView: a request with status 0 leaves the status for the widget to say "no answer"', async () => {
    const { entryView } = await loadLogic()
    expect(entryView({ kind: 'request', method: 'GET', path: '/api/health', status: 0, n: 4, at: 9, state: 'open' }))
      .toEqual({ kind: 'request', time: 9, text: 'GET /api/health', origin: null, n: 4, state: 'open', noAnswer: true })
  })

  it('entryView: a request whose status is not a number shows no status', async () => {
    const { entryView } = await loadLogic()
    for (const status of [undefined, null, '500', { toString: () => '500' }, Number.NaN])
      expect(entryView({ kind: 'request', method: 'GET', path: '/api/items', status, n: 1, at: 1, state: 'open' }))
        .toMatchObject({ text: 'GET /api/items', noAnswer: false })
  })

  it('entryView: a limited entry has no text of its own, only its count, in each state', async () => {
    const { entryView } = await loadLogic()
    for (const state of ['open', 'seen', 'resolved'] as const) {
      expect(entryView({ kind: 'limited', n: 120, at: 42, state }))
        .toEqual({ kind: 'limited', time: 42, text: '', origin: null, n: 120, state, noAnswer: false })
    }
  })

  it('entryView: a build entry shows its file, line and column as its origin, or the bare file', async () => {
    const { entryView } = await loadLogic()
    const build = { kind: 'build', id: 1, text: 'Invalid end tag.', file: '~/app/src/App.vue', line: 12, col: 3, n: 1, at: 50, state: 'open' }
    expect(entryView(build)).toEqual({ kind: 'build', time: 50, text: 'Invalid end tag.', origin: '~/app/src/App.vue:12:3', n: 1, state: 'open', noAnswer: false })
    expect(entryView({ ...build, col: null })).toMatchObject({ origin: '~/app/src/App.vue:12' })
    expect(entryView({ ...build, line: null, col: null })).toMatchObject({ origin: '~/app/src/App.vue' })
    expect(entryView({ ...build, file: null, line: null, col: null })).toMatchObject({ kind: 'build', origin: null })
  })

  it('entryView: a slow request reads METHOD path, its duration in ms beside it', async () => {
    const { entryView } = await loadLogic()
    const slow = { kind: 'slow', id: 3, method: 'GET', path: '/api/items', ms: 1200, n: 1, at: 60, state: 'open' }
    expect(entryView(slow)).toEqual({ kind: 'slow', time: 60, text: 'GET /api/items', origin: null, n: 1, state: 'open', noAnswer: false, ms: 1200 })
    expect(entryView({ ...slow, ms: 'x' })).toMatchObject({ kind: 'slow', ms: null })
  })

  it('entryView: a perf entry carries its metric, value and ratio for the widget to write', async () => {
    const { entryView } = await loadLogic()
    const perf = { kind: 'perf', id: 4, metric: 'lcp', value: 1800, ratio: 1.6, n: 1, at: 70, state: 'open' }
    expect(entryView(perf)).toEqual({ kind: 'perf', time: 70, text: '', origin: null, n: 1, state: 'open', noAnswer: false, metric: 'lcp', value: 1800, ratio: 1.6 })
    expect(entryView({ ...perf, metric: 'cls', value: 0.3, ratio: null })).toMatchObject({ metric: 'cls', value: 0.3, ratio: null })
    expect(entryView({ ...perf, metric: 'fps' })).toBeNull()
    expect(entryView({ ...perf, value: 'x' })).toBeNull()
    expect(entryView({ ...perf, ratio: 'x' })).toMatchObject({ ratio: null })
  })

  it('perfView: the values in order, LCP over 4 s and CLS over 0.25 poor, the heap dimmed', async () => {
    const { perfView } = await loadLogic()
    expect(perfView({ lcp: 4100, cls: 0.1, heapMb: 45 })).toEqual([
      { key: 'lcp', value: 4100, poor: true, dim: false },
      { key: 'cls', value: 0.1, poor: false, dim: false },
      { key: 'heapMb', value: 45, poor: false, dim: true },
    ])
    expect(perfView({ heapMb: 45, longTasks: 3, cls: 0.3, lcp: 4000, load: 1234 }).map((v) => [v.key, v.poor])).toEqual([
      ['load', false], ['lcp', false], ['cls', true], ['longTasks', false], ['heapMb', false],
    ])
    expect(perfView({})).toEqual([])
    expect(perfView(undefined)).toEqual([])
    expect(perfView({ lcp: 'x', fps: 60 })).toEqual([])
  })

  it('requestsFact: with no failed request to show, the newest open perf entry stands in, and a perf entry makes the wording neutral', async () => {
    const { requestsFact } = await loadLogic()
    const perf = (id: number, metric: string, value: number, ratio: number | null, state: string) => ({ kind: 'perf', id, metric, value, ratio, n: 1, at: id, state })
    const request = { kind: 'request', id: 1, method: 'GET', path: '/api', status: 404, n: 1, at: 1, state: 'open' }
    const tally = (open: number, last: unknown) => ({ total: 2, open, seen: 0, last })
    expect(requestsFact({ requests: tally(1, null), history: [perf(3, 'lcp', 1800, 1.6, 'open'), perf(2, 'cls', 0.3, null, 'resolved')] }))
      .toEqual({ perf: expect.objectContaining({ kind: 'perf', metric: 'lcp', value: 1800, ratio: 1.6 }), neutral: true })
    expect(requestsFact({ requests: tally(1, null), history: [perf(3, 'cls', 0.3, null, 'seen')] }).perf).toMatchObject({ metric: 'cls' })
    // A failed request's last stays what is shown.
    expect(requestsFact({ requests: tally(2, { path: '/api', status: 404, at: 1 }), history: [perf(3, 'lcp', 1800, 1.6, 'open'), request] }))
      .toEqual({ perf: null, neutral: true })
    // Resolved: no entry stands in, the resolved label is neutral.
    expect(requestsFact({ requests: tally(0, null), history: [perf(3, 'lcp', 1800, 1.6, 'resolved')] })).toEqual({ perf: null, neutral: true })
    expect(requestsFact({ requests: tally(1, { path: '/api', status: 404, at: 1 }), history: [request] })).toEqual({ perf: null, neutral: false })
    expect(requestsFact(null)).toEqual({ perf: null, neutral: false })
  })

  it('entryView: anything else is null', async () => {
    const { entryView } = await loadLogic()
    expect(entryView(null)).toBeNull()
    expect(entryView({ kind: 'console', text: 'x', n: 1, at: 1, state: 'open' })).toBeNull()
  })
  it('shotOf: the shot until its time is up, its thumbnail only as a JPEG data URL within the cap', async () => {
    const { shotOf, rowsOf } = await loadLogic()
    const THUMB = 'data:image/jpeg;base64,/9j/4AAQ'
    expect(shotOf({ shot: { thumb: THUMB, until: 2000 } }, 1000)).toEqual({ thumb: THUMB, until: 2000 })
    expect(shotOf({ shot: { thumb: null, until: 2000 } }, 1000)).toEqual({ thumb: null, until: 2000 })
    expect(shotOf({ shot: { thumb: THUMB, until: 2000 } }, 2000)).toBeNull()
    for (const thumb of ['data:image/png;base64,iVBORw0KGgo=', 'javascript:alert(1)', 'https://example.com/a.jpg', `data:image/jpeg;base64,${'A'.repeat(40_000)}`, 42]) {
      expect(shotOf({ shot: { thumb, until: 2000 } }, 1000)).toEqual({ thumb: null, until: 2000 })
    }
    for (const row of [null, {}, { shot: null }, { shot: { thumb: THUMB } }, { shot: { thumb: THUMB, until: '2000' } }]) {
      expect(shotOf(row, 1000)).toBeNull()
    }
    // rowsOf carries it through.
    const snap = { enabled: true, paired: 1, installs: [{ deviceId: 'a', name: 'Chrome', on: true, tabs: [{ tabId: 7, errors: {}, requests: {}, server: 'up', activity: 1, shot: { thumb: THUMB, until: 2000 } }] }] }
    expect(shotOf(rowsOf(snap)[0], 1000)?.thumb).toBe(THUMB)
  })
})

/** A `companion:servers` row, a dev server on `port` unless told otherwise. */
function server(pid: number, port: number, over: Record<string, unknown> = {}) {
  return {
    id: `${pid}:Wed Oct 22 09:00:00 2026`, pid, ports: [port], project: `app-${port}`, tool: 'Vite', uptimeSec: 60, cpu: 1, rssKb: 1024,
    folder: `~/code/app-${port}`, command: 'node vite', dev: true, system: false, docker: null,
    managed: false, state: 'up', portBusy: false, tab: null, log: [],
    ...over,
  }
}
const servers = (rows: unknown[], over: Record<string, unknown> = {}) => ({ enabled: true, canRestart: true, rows, ...over })

describe('fremdev/logic.js: the Servers segment', () => {
  it('formatUptime: seconds, minutes, hours, days, the day in the user\'s language', async () => {
    const { formatUptime } = await loadLogic()
    expect(formatUptime(42)).toBe('42 s')
    expect(formatUptime(720)).toBe('12 min')
    expect(formatUptime(7200)).toBe('2 h')
    expect(formatUptime(259200)).toBe('3 d')
    expect(formatUptime(259200, 'fr')).toBe('3 j')
    expect(formatUptime(259200, 'en')).toBe('3 d')
    expect(formatUptime(59)).toBe('59 s')
    expect(formatUptime(3599)).toBe('59 min')
    expect(formatUptime(86399)).toBe('23 h')
    expect(formatUptime(0)).toBe('0 s')
    for (const bad of [-1, NaN, Infinity, '42', null, undefined]) expect(formatUptime(bad)).toBe('')
  })

  it('formatMem: KB, MB, GB with one decimal under 10, in the user\'s language', async () => {
    const { formatMem } = await loadLogic()
    expect(formatMem(512)).toBe('512 KB')
    expect(formatMem(512, 'fr')).toBe('512 Ko')
    expect(formatMem(412_000)).toBe('402 MB')
    expect(formatMem(412_000, 'fr')).toBe('402 Mo')
    expect(formatMem(1_258_291)).toBe('1.2 GB')
    expect(formatMem(1_258_291, 'fr')).toBe('1,2 Go')
    expect(formatMem(12 * 1024 * 1024)).toBe('12 GB')
    for (const bad of [-1, NaN, '1024', null]) expect(formatMem(bad)).toBe('')
  })

  it('serverRows: hides non-dev rows unless showAll, never a managed one nor a Docker holder, sorted by port', async () => {
    const { serverRows } = await loadLogic()
    const snap = servers([
      server(3, 8080, { dev: false, project: 'ControlCenter', system: true }),
      server(2, 5173),
      server(4, 6006, { dev: false, managed: true }),
      server(1, 3000),
    ])
    expect(serverRows(snap, false).map((r) => r.pid)).toEqual([1, 2, 4])
    expect(serverRows(snap, true).map((r) => r.pid)).toEqual([1, 2, 4, 3])
    // Docker's port holder is no dev runtime, and still listed by default.
    expect(serverRows(servers([server(5, 5432, { dev: false, docker: 'db' })]), false).map((r) => r.pid)).toEqual([5])
    expect(serverRows(null, true)).toEqual([])
    expect(serverRows({ enabled: false, rows: [server(1, 3000)] }, true)).toEqual([])
    expect(serverRows({ enabled: true, rows: 'x' }, true)).toEqual([])
    // A row without ports is dropped rather than sorted on undefined.
    expect(serverRows(servers([server(1, 3000, { ports: [] }), null]), true)).toEqual([])
  })

  it('serverKey: the project and first port, so a managed row keeps its key from root to listener', async () => {
    const { serverKey, serverRows } = await loadLogic()
    const root = server(100, 6006, { project: 'design-system', managed: true, state: 'starting' })
    const listener = server(101, 6006, { project: 'design-system', managed: true })
    expect(serverKey(root)).toBe(serverKey(listener))
    expect(serverKey(root)).not.toBe(serverKey(server(100, 6007, { project: 'design-system' })))
    expect(serverKey({ id: '5:x', ports: [], project: '' })).toBe('id:5:x')
    // Two rows of one project on one port (a parent and a child both listed): keys stay distinct.
    const rows = serverRows(servers([server(7, 3000, { project: 'p' }), server(8, 3000, { project: 'p' })]), false)
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
    expect(rows[0].key).toBe(serverKey(rows[0]))
  })

  it('serverActions: Open but Docker, Finder on dev non-system rows, Kill on neither system nor Docker, Restart when the server can', async () => {
    const { serverActions } = await loadLogic()
    expect(serverActions(server(1, 3000), true)).toEqual({ open: true, reveal: true, kill: true, restart: true })
    expect(serverActions(server(1, 3000), false)).toEqual({ open: true, reveal: true, kill: true, restart: false })
    expect(serverActions(server(1, 3000, { dev: false }), true)).toEqual({ open: true, reveal: false, kill: true, restart: false })
    expect(serverActions(server(1, 3000, { system: true }), true)).toEqual({ open: true, reveal: false, kill: false, restart: false })
    expect(serverActions(server(1, 3000, { docker: 'db' }), true)).toEqual({ open: false, reveal: false, kill: false, restart: false })
    expect(serverActions(server(1, 3000, { dev: false, docker: 'Docker' }), true)).toEqual({ open: false, reveal: false, kill: false, restart: false })
    expect(serverActions(null, true)).toEqual({ open: false, reveal: false, kill: false, restart: false })
  })

  it('serverLight: green when up, grey while starting, red when failed or holding a port a restart wanted', async () => {
    const { serverLight } = await loadLogic()
    expect(serverLight(server(1, 3000))).toBe('green')
    expect(serverLight(server(1, 3000, { state: 'starting' }))).toBe('grey')
    expect(serverLight(server(1, 3000, { state: 'failed' }))).toBe('red')
    expect(serverLight(server(1, 3000, { portBusy: true }))).toBe('red')
  })

  it('serversStateOf: loading, off, error with nothing to list, empty, rows', async () => {
    const { serversStateOf } = await loadLogic()
    expect(serversStateOf(null, false)).toBe('loading')
    expect(serversStateOf({ enabled: false, rows: [], canRestart: true }, false)).toBe('off')
    expect(serversStateOf(servers([], { error: 'unavailable' }), false)).toBe('unavailable')
    expect(serversStateOf(servers([server(1, 3000)], { error: 'unavailable' }), false)).toBe('rows')
    expect(serversStateOf(servers([]), false)).toBe('empty')
    expect(serversStateOf(servers([server(1, 3000, { dev: false })]), false)).toBe('empty')
    expect(serversStateOf(servers([server(1, 3000, { dev: false })]), true)).toBe('rows')
    expect(serversStateOf(servers([server(1, 5432, { dev: false, docker: 'db' })]), false)).toBe('rows')
    // An error code the widget does not know reads as the generic one.
    expect(serversStateOf(servers([], { error: 'weird' }), false)).toBe('unavailable')
  })
})
