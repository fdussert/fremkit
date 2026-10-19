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
interface Row { tabId: number; deviceId: string; browser: string; light: Light; app: string; activity: number }
interface Logic {
  stateOf(snapshot: unknown): string
  lightOf(tab: unknown): Light
  rowsOf(snapshot: unknown): Row[]
  summaryOf(snapshot: unknown): { light: Light; errors: number }
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

const tally = (open: number, total: number, last: unknown = null) => ({ open, total, last })
function tab(tabId: number, over: { errors?: [number, number]; requests?: [number, number]; server?: 'up' | 'down'; activity?: number } = {}) {
  const [eo, et] = over.errors ?? [0, 0]
  const [ro, rt] = over.requests ?? [0, 0]
  return {
    tabId, app: `App ${tabId}`, host: `localhost:${5170 + tabId}`,
    errors: tally(eo, et, et > 0 ? { text: 'TypeError: x is undefined', at: 1000 } : null),
    requests: tally(ro, rt, rt > 0 ? { path: '/api/items', status: 500, at: 1000 } : null),
    server: over.server ?? 'up',
    activity: over.activity ?? 1000,
  }
}
const install = (deviceId: string, tabs: unknown[], on = true, name = 'Chrome') => ({ deviceId, name, on, tabs })
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

  it('lightOf: an open error or a down server is red, an open failed request orange, resolved counters green', async () => {
    const { lightOf } = await loadLogic()
    expect(lightOf(tab(1, { errors: [1, 1] }))).toBe('red')
    expect(lightOf(tab(1, { server: 'down' }))).toBe('red')
    expect(lightOf(tab(1, { errors: [2, 3], requests: [1, 1] }))).toBe('red')
    expect(lightOf(tab(1, { requests: [1, 4] }))).toBe('orange')
    expect(lightOf(tab(1, { errors: [0, 5], requests: [0, 2] }))).toBe('green')
    expect(lightOf(tab(1))).toBe('green')
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
    expect(summaryOf(null)).toEqual({ light: 'green', errors: 0 })
    expect(summaryOf(snap([install(DEV_A, [])]))).toEqual({ light: 'green', errors: 0 })
    expect(summaryOf(snap([install(DEV_A, [tab(1, { requests: [1, 1] }), tab(2, { errors: [0, 4] })])]))).toEqual({ light: 'orange', errors: 0 })
    expect(summaryOf(snap([
      install(DEV_A, [tab(1, { errors: [2, 3] }), tab(2, { requests: [1, 1] })]),
      install(DEV_B, [tab(3, { errors: [4, 4] })]),
      install(DEV_C, [tab(4, { errors: [7, 7] })], false),
    ]))).toEqual({ light: 'red', errors: 6 })
  })
})
