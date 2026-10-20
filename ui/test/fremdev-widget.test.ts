// @vitest-environment jsdom
/**
 * The Fremdev widget's page: what a tap, a key and a snapshot do to the rows. Its pure half
 * (widgets/fremdev/logic.js) is tested on the server side; this runs the page itself, logic.js
 * then the inline script, against a fake `Fremkit`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'

const read = (name: string) => readFileSync(new NodeURL(`../../widgets/fremdev/${name}`, import.meta.url), 'utf8')
const html = read('index.html')
const logic = read('logic.js')

const DEVICE = '11111111-1111-4111-8111-111111111111'

function tab(tabId: number, over: Record<string, unknown> = {}) {
  return {
    tabId,
    app: `App ${tabId}`,
    host: `localhost:${5170 + tabId}`,
    errors: { total: 1, open: 1, seen: 0, last: { text: 'TypeError: x', at: 1000 } },
    requests: { total: 0, open: 0, seen: 0, last: null },
    history: [{ kind: 'error', id: 1, text: 'TypeError: x', origin: '/src/a.js:1:2', n: 1, at: 1000, state: 'open' }],
    devServer: null,
    server: 'up',
    activity: 1000 + tabId,
    ...over,
  }
}
function snapshot(tabs: unknown[], report = true, features: string[] = []) {
  return { enabled: true, paired: 1, installs: [{ deviceId: DEVICE, name: 'Chrome', on: true, connected: true, report, features, tabs }] }
}

function load() {
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<script/)![1]!
  let publish!: (data: unknown) => void
  const F = {
    t: (dict: { en: string }, vars?: Record<string, unknown>) =>
      dict.en.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? '')),
    whenReady: (cb: () => void) => cb(),
    onLocale: () => {},
    subscribe: (_channel: string, cb: (data: unknown) => void) => { publish = cb },
    sendCommand: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({ ok: true })),
  }
  new Function(logic)()
  new Function('Fremkit', html.match(/<script>([\s\S]*?)<\/script>/)![1]!)(F)
  return { F, publish: (s: unknown) => publish(s) }
}

const rowEls = () => [...document.querySelectorAll<HTMLElement>('.row')]
const rowOf = (app: string) => rowEls().find((r) => r.querySelector('.app')!.textContent === app)!
const control = (row: HTMLElement) => row.querySelector<HTMLElement>('[role="button"]')!
const unfoldedApps = () => rowEls().filter((r) => r.classList.contains('unfolded')).map((r) => r.querySelector('.app')!.textContent)

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
  delete (globalThis as { FremkitFremdev?: unknown }).FremkitFremdev
})

describe('the Fremdev widget page', () => {
  it('unfolds one row at a time, from a tap on its line', () => {
    const w = load()
    w.publish(snapshot([tab(7), tab(8)]))
    expect(unfoldedApps()).toEqual([])
    rowOf('App 7').querySelector<HTMLElement>('.top')!.click()
    expect(unfoldedApps()).toEqual(['App 7'])
    expect(control(rowOf('App 7')).getAttribute('aria-expanded')).toBe('true')
    expect(rowOf('App 7').querySelectorAll('.history .entry')).toHaveLength(1)
    rowOf('App 8').querySelector<HTMLElement>('.light')!.click()
    expect(unfoldedApps()).toEqual(['App 8'])
    expect(control(rowOf('App 7')).getAttribute('aria-expanded')).toBe('false')
    rowOf('App 8').querySelector<HTMLElement>('.top')!.click()
    expect(unfoldedApps()).toEqual([])
  })

  it('writes "Build" before a build entry\'s text, and its file under it', () => {
    const w = load()
    const build = { kind: 'build', id: 2, text: 'Invalid end tag.', file: '~/app/src/App.vue', line: 12, col: 3, n: 1, at: 2000, state: 'open' }
    w.publish(snapshot([tab(7, { history: [build] })]))
    rowOf('App 7').querySelector<HTMLElement>('.top')!.click()
    const entry = rowOf('App 7').querySelector('.history .entry.build')!
    expect(entry.querySelector('.kind')!.textContent).toBe('Build')
    expect(entry.querySelector('.what')!.textContent).toBe('Invalid end tag.')
    expect(entry.querySelector('.origin')!.textContent).toBe('~/app/src/App.vue:12:3')
    // Only a build entry carries the label.
    w.publish(snapshot([tab(7)]))
    expect(rowOf('App 7').querySelector('.history .entry .kind')).toBeNull()
  })

  it('puts the unfold role on the name and facts, with no button inside it, and keeps Enter and Space', () => {
    const w = load()
    w.publish(snapshot([tab(7)]))
    const row = rowOf('App 7')
    expect(row.querySelectorAll('[role="button"]')).toHaveLength(1)
    expect(control(row).classList.contains('body')).toBe(true)
    expect(control(row).tabIndex).toBe(0)
    expect(control(row).getAttribute('aria-label')).toBe('App 7')
    expect(control(row).querySelector('button')).toBeNull()
    expect(row.querySelector('.top')!.hasAttribute('role')).toBe(false)
    control(row).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(unfoldedApps()).toEqual(['App 7'])
    control(row).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(unfoldedApps()).toEqual([])
  })

  it('Show tab and × act on the tab and fold nothing', () => {
    const w = load()
    w.publish(snapshot([tab(7)]))
    const row = rowOf('App 7')
    row.querySelector<HTMLElement>('button.show')!.click()
    row.querySelector<HTMLElement>('button.clear')!.click()
    expect(unfoldedApps()).toEqual([])
    expect(w.F.sendCommand.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['focus', { deviceId: DEVICE, tabId: 7 }],
      ['clear', { deviceId: DEVICE, tabId: 7 }],
    ])
  })

  it('forgets the unfolded row when its tab goes, so it comes back folded', () => {
    const w = load()
    w.publish(snapshot([tab(7), tab(8)]))
    rowOf('App 7').querySelector<HTMLElement>('.top')!.click()
    w.publish(snapshot([tab(8)]))
    expect(rowEls()).toHaveLength(1)
    w.publish(snapshot([tab(7), tab(8)]))
    expect(unfoldedApps()).toEqual([])
  })

  it('shows the copy buttons only for an install that can report', () => {
    const w = load()
    w.publish(snapshot([tab(7)], false))
    rowOf('App 7').querySelector<HTMLElement>('.top')!.click()
    expect(rowOf('App 7').querySelector<HTMLElement>('.actions')!.hidden).toBe(true)
    w.publish(snapshot([tab(7)], true))
    expect(rowOf('App 7').querySelector<HTMLElement>('.actions')!.hidden).toBe(false)
  })

  it('a copy button is busy while asked, says the answer for 2 s, then reads its label again', async () => {
    vi.useFakeTimers()
    const w = load()
    w.publish(snapshot([tab(7)]))
    rowOf('App 7').querySelector<HTMLElement>('.top')!.click()
    const [plain, withStack] = [...rowOf('App 7').querySelectorAll<HTMLButtonElement>('button.copy')]
    expect([plain.textContent, withStack.textContent]).toEqual(['Copy report', 'Copy with stack'])

    let answer!: (v: unknown) => void
    w.F.sendCommand.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    plain.click()
    expect(plain.disabled).toBe(true)
    expect(w.F.sendCommand).toHaveBeenLastCalledWith('companion:dev', 'report', { deviceId: DEVICE, tabId: 7, stack: false })
    // A second tap while busy asks nothing more.
    plain.click()
    expect(w.F.sendCommand).toHaveBeenCalledTimes(1)
    // A snapshot meanwhile keeps the state.
    w.publish(snapshot([tab(7)]))
    expect(plain.disabled).toBe(true)
    answer({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(plain.disabled).toBe(false)
    expect(plain.textContent).toBe('Copied ✓')
    expect(plain.classList.contains('ok')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(plain.textContent).toBe('Copy report')
    expect(plain.classList.contains('ok')).toBe(false)

    w.F.sendCommand.mockImplementationOnce(() => Promise.resolve({ ok: false }))
    withStack.click()
    expect(w.F.sendCommand).toHaveBeenLastCalledWith('companion:dev', 'report', { deviceId: DEVICE, tabId: 7, stack: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(withStack.textContent).toBe('Copy failed')
    expect(withStack.classList.contains('failed')).toBe(true)
    // A copy does not fold the row.
    expect(unfoldedApps()).toEqual(['App 7'])
  })

  it('the origin of an openable entry is a 44 px button that sends open and folds nothing; others stay text', () => {
    const w = load()
    w.publish(snapshot([tab(7, { devServer: 'vite' })], true, ['fremdev.open']))
    rowOf('App 7').querySelector<HTMLElement>('.top')!.click()
    const origin = rowOf('App 7').querySelector<HTMLButtonElement>('.history .entry button.origin')!
    expect(origin).not.toBeNull()
    expect(origin.textContent).toBe('/src/a.js:1:2')
    expect(read('index.html')).toMatch(/button\.origin\{[^}]*min-height:44px/)
    origin.click()
    expect(w.F.sendCommand).toHaveBeenLastCalledWith('companion:dev', 'open', { deviceId: DEVICE, tabId: 7, entryId: 1 })
    expect(unfoldedApps()).toEqual(['App 7'])
    // Without the feature, or under Next for a runtime error, the origin is text.
    w.publish(snapshot([tab(7, { devServer: 'vite' })], true, []))
    expect(rowOf('App 7').querySelector('.history .entry button.origin')).toBeNull()
    expect(rowOf('App 7').querySelector('.history .entry .origin')!.textContent).toBe('/src/a.js:1:2')
    w.publish(snapshot([tab(7, { devServer: 'next', history: [{ kind: 'error', id: 1, text: 'x', origin: '/_next/static/chunks/a.js:1:2', n: 1, at: 1000, state: 'open' }] })], true, ['fremdev.open']))
    expect(rowOf('App 7').querySelector('.history .entry button.origin')).toBeNull()
  })

  it('says "Sent to the editor" for 2 s after { ok: true }, and "Can\'t open here" after a refusal', async () => {
    vi.useFakeTimers()
    const w = load()
    w.publish(snapshot([tab(7, { devServer: 'vite' })], true, ['fremdev.open']))
    rowOf('App 7').querySelector<HTMLElement>('.top')!.click()
    const origin = () => rowOf('App 7').querySelector<HTMLButtonElement>('.history .entry button.origin')!
    origin().click()
    await vi.advanceTimersByTimeAsync(0)
    expect(origin().textContent).toBe('Sent to the editor')
    // A snapshot meanwhile keeps it.
    w.publish(snapshot([tab(7, { devServer: 'vite' })], true, ['fremdev.open']))
    expect(origin().textContent).toBe('Sent to the editor')
    await vi.advanceTimersByTimeAsync(1999)
    expect(origin().textContent).toBe('Sent to the editor')
    await vi.advanceTimersByTimeAsync(1)
    expect(origin().textContent).toBe('/src/a.js:1:2')

    w.F.sendCommand.mockImplementationOnce(() => Promise.resolve({ ok: false, error: "Can't open here" }))
    origin().click()
    await vi.advanceTimersByTimeAsync(0)
    expect(origin().textContent).toBe("Can't open here")
    expect(origin().classList.contains('failed')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(origin().textContent).toBe('/src/a.js:1:2')
    expect(unfoldedApps()).toEqual(['App 7'])
  })
})
