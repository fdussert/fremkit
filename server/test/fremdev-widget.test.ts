import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { COMPANION_DEV_CHANNEL } from '../src/companion/dev.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'

/**
 * The Fremdev widget: its manifest as the catalogue reads it, and `widgets/fremdev/logic.js`, the
 * pure half of the page — which state a `companion:dev` snapshot puts on screen, the colour of
 * each row and the order the rows come in.
 */
const SHIPPED = fileURLToPath(new URL('../../widgets', import.meta.url))

type Light = 'red' | 'orange' | 'green'
interface Row { tabId: number; deviceId: string; browser: string; light: Light; seen: boolean; app: string; activity: number }
interface Logic {
  stateOf(snapshot: unknown): string
  lightOf(tab: unknown): Light
  stateOfTab(tab: unknown): { light: Light; seen: boolean }
  hasUnseen(tab: unknown): boolean
  rowsOf(snapshot: unknown): Row[]
  summaryOf(snapshot: unknown): { light: Light; seen: boolean; errors: number }
  onMac(loc: unknown): boolean
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
    server: over.server ?? 'up',
    activity: over.activity ?? 1000,
  }
}
const install = (deviceId: string, tabs: unknown[], on = true, name = 'Chrome', connected = true) => ({ deviceId, name, on, connected, tabs })
/** A listed install whose socket is closed: the extension's idle state, no rows. */
const idle = (deviceId: string, on = true, name = 'Chrome') => install(deviceId, [], on, name, false)
const snap = (installs: unknown[], over: { enabled?: boolean; paired?: number } = {}) =>
  ({ enabled: over.enabled ?? true, paired: over.paired ?? 1, installs })

describe('the fremdev manifest', () => {
  it('the fremdev manifest subscribes to and commands companion:dev', async () => {
    const cat = new WidgetCatalog(SHIPPED)
    await cat.scan()
    expect(cat.errors.filter((e) => e.id === 'fremdev')).toEqual([])
    const entry = cat.entry('fremdev')!
    expect(entry.source).toBe('builtin')
    const m = entry.manifest
    expect(m.name).toEqual({ fr: 'Fremdev', en: 'Fremdev' })
    expect(m.description).toEqual({ fr: 'Les erreurs de vos onglets de développement', en: 'The errors of your development tabs' })
    expect(m.category).toBe('dev')
    expect(m.icon).toBe('code')
    expect(m.subscriptions).toEqual([COMPANION_DEV_CHANNEL])
    expect(m.commands).toEqual([COMPANION_DEV_CHANNEL])
    expect(m.minSize).toEqual([8, 4])
    expect(m.defaultSize).toEqual([20, 8])
    expect(m.compact).toEqual({ width: 2 })
    expect(m.settingsSchema).toEqual({})
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
})
