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

function load(settings: Record<string, unknown> = {}) {
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<script/)![1]!
  const subs = new Map<string, (data: unknown) => void>()
  let onSettings: (() => void) | null = null
  const F = {
    t: (dict: { en: string }, vars?: Record<string, unknown>) =>
      dict.en.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? '')),
    locale: 'en',
    settings,
    whenReady: (cb: () => void) => cb(),
    onLocale: () => {},
    onSettings: (cb: () => void) => { onSettings = cb },
    subscribe: (channel: string, cb: (data: unknown) => void) => { subs.set(channel, cb) },
    sendCommand: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({ ok: true })),
  }
  new Function(logic)()
  new Function('Fremkit', html.match(/<script>([\s\S]*?)<\/script>/)![1]!)(F)
  return {
    F,
    publish: (s: unknown) => subs.get('companion:dev')!(s),
    servers: (s: unknown) => subs.get('companion:servers')!(s),
    settings: (next: Record<string, unknown>) => { F.settings = next; onSettings?.() },
  }
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

  it('shows the reload buttons only for an install that lists fremdev.reload, and sends the cache choice', () => {
    const w = load()
    w.publish(snapshot([tab(7)], true, []))
    rowOf('App 7').querySelector<HTMLElement>('.top')!.click()
    const buttons = () => [...rowOf('App 7').querySelectorAll<HTMLButtonElement>('button.reload')]
    expect(buttons().every((b) => b.hidden)).toBe(true)
    w.publish(snapshot([tab(7)], true, ['fremdev.reload']))
    const [plain, hard] = buttons()
    expect([plain.hidden, hard.hidden]).toEqual([false, false])
    expect([plain.textContent, hard.textContent]).toEqual(['Reload', 'Reload without cache'])
    plain.click()
    expect(w.F.sendCommand).toHaveBeenLastCalledWith('companion:dev', 'reload', { deviceId: DEVICE, tabId: 7, bypassCache: false })
    hard.click()
    expect(w.F.sendCommand).toHaveBeenLastCalledWith('companion:dev', 'reload', { deviceId: DEVICE, tabId: 7, bypassCache: true })
    // The actions show for reload alone, with no report, and the copy buttons stay away.
    w.publish(snapshot([tab(7)], false, ['fremdev.reload']))
    expect(rowOf('App 7').querySelector<HTMLElement>('.actions')!.hidden).toBe(false)
    expect(rowOf('App 7').querySelector<HTMLButtonElement>('button.copy')!.hidden).toBe(true)
    // A reload does not fold the row.
    expect(unfoldedApps()).toEqual(['App 7'])
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

function server(pid: number, port: number, over: Record<string, unknown> = {}) {
  return {
    id: `${pid}:Wed Oct 22 09:00:00 2026`, pid, ports: [port], project: `app-${port}`, tool: 'Vite', uptimeSec: 7200, cpu: 3.1, rssKb: 412_000,
    folder: `~/code/app-${port}`, command: `node ~/code/app-${port}/node_modules/.bin/vite`, dev: true, system: false, docker: null,
    managed: false, state: 'up', portBusy: false, tab: null, log: [],
    ...over,
  }
}
const servers = (rows: unknown[], over: Record<string, unknown> = {}) => ({ enabled: true, canRestart: true, rows, ...over })
const srows = () => [...document.querySelectorAll<HTMLElement>('.srow')]
const srowOf = (port: number) => srows().find((r) => r.querySelector('.port')!.textContent!.split(', ')[0] === String(port))!
const button = (row: HTMLElement, name: string) => row.querySelector<HTMLButtonElement>(`button.act.${name}`)!
const showServers = () => document.querySelector<HTMLButtonElement>('#segServers')!.click()

describe('the Fremdev widget page: the Servers segment', () => {
  it('shows the segments with their counts while Fremdev is on, and the off sentence alone when it is off', () => {
    const w = load()
    w.publish({ enabled: true, paired: 0, installs: [] })
    w.servers(servers([server(1, 3000), server(2, 5173)]))
    const segs = document.querySelector<HTMLElement>('#segs')!
    expect(segs.hidden).toBe(false)
    expect(document.querySelector('#segTabs')!.textContent).toBe('Tabs (0)')
    expect(document.querySelector('#segServers')!.textContent).toBe('Servers (2)')
    expect(document.querySelector('#segTabs')!.getAttribute('aria-selected')).toBe('true')
    // Unpaired, the Tabs segment says so; the Servers one lists the servers all the same.
    expect(document.querySelector('#msg')!.textContent).toBe('Link your browser with Fremkit Companion')
    showServers()
    expect(document.querySelector('#segServers')!.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('#slist')!.classList.contains('current')).toBe(true)
    expect(document.querySelector('#list')!.classList.contains('current')).toBe(false)
    expect(document.querySelector('#stage')!.classList.contains('rows')).toBe(true)
    expect(srows().map((r) => r.querySelector('.port')!.textContent)).toEqual(['3000', '5173'])
    // Off: no segments, the off sentence, nothing to touch.
    w.publish({ enabled: false, paired: 0, installs: [] })
    w.servers({ enabled: false, rows: [], canRestart: true })
    expect(segs.hidden).toBe(true)
    expect(document.querySelector('#msg')!.textContent).toBe('Feature turned off')
    expect(srows()).toHaveLength(0)
    // Back on, the segment picked is still the one shown (kept in memory).
    w.publish({ enabled: true, paired: 0, installs: [] })
    w.servers(servers([server(1, 3000)]))
    expect(document.querySelector('#segServers')!.getAttribute('aria-selected')).toBe('true')
  })

  it('writes the row: port, project, tool, uptime, CPU, memory, the Fremkit badge and the tab light', () => {
    const w = load()
    w.publish(snapshot([]))
    w.servers(servers([server(1, 5173, { ports: [5173, 24678], managed: true, tab: 'orange' })]))
    showServers()
    const row = srowOf(5173)
    expect(row.querySelector('.port')!.textContent).toBe('5173, 24678')
    expect(row.querySelector('.project')!.textContent).toBe('app-5173')
    expect(row.querySelector('.tool')!.textContent).toBe('Vite')
    expect(row.querySelector('.uptime')!.textContent).toBe('2 h')
    expect(row.querySelector('.cpu')!.textContent).toBe('3.1% CPU')
    expect(row.querySelector('.mem')!.textContent).toBe('402 MB')
    expect(row.querySelector<HTMLElement>('.badge')!.hidden).toBe(false)
    expect(row.querySelector<HTMLElement>('.tabdot')!.className).toBe('tabdot orange')
    expect(row.querySelector('.light')!.className).toBe('light green')
  })

  it('says "No dev server running" with nothing to list, and the unavailable sentence when listing failed', () => {
    const w = load()
    w.publish(snapshot([]))
    w.servers(servers([server(1, 8080, { dev: false })]))
    showServers()
    expect(document.querySelector('#msg')!.textContent).toBe('No dev server running')
    expect(document.querySelector('#segServers')!.textContent).toBe('Servers (0)')
    // The setting lists every listener, live.
    w.settings({ showAllListeners: true })
    expect(srows()).toHaveLength(1)
    expect(document.querySelector('#msg')!.textContent).toBe('')
    w.servers(servers([], { error: 'unavailable' }))
    expect(document.querySelector('#msg')!.textContent).toBe("Can't list the servers")
    // With the last good rows, a line says the list is not current.
    w.servers(servers([server(1, 3000)], { error: 'unavailable' }))
    expect(document.querySelector<HTMLElement>('#snote')!.hidden).toBe(false)
    expect(document.querySelector('#snote')!.textContent).toBe("Can't list the servers")
  })

  it('unfolds a row on tap: command, folder, the log of a managed server, 56 px buttons', () => {
    const w = load()
    w.publish(snapshot([]))
    w.servers(servers([server(1, 3000), server(2, 6006, { managed: true, log: ['ready', 'Local: http://localhost:6006/'] })]))
    showServers()
    srowOf(6006).querySelector<HTMLElement>('.top')!.click()
    expect(srowOf(6006).classList.contains('unfolded')).toBe(true)
    expect(srowOf(3000).classList.contains('unfolded')).toBe(false)
    expect(srowOf(6006).querySelector('.cmd')!.textContent).toBe('node ~/code/app-6006/node_modules/.bin/vite')
    expect(srowOf(6006).querySelector('.folder')!.textContent).toBe('~/code/app-6006')
    expect(srowOf(6006).querySelector('.log')!.textContent).toBe('ready\nLocal: http://localhost:6006/')
    expect(srowOf(3000).querySelector<HTMLElement>('.log')!.hidden).toBe(true)
    expect(read('index.html')).toMatch(/button\.act\{[^}]*min-height:56px/)
    expect(['open', 'reveal', 'restart', 'kill'].map((n) => button(srowOf(6006), n).textContent)).toEqual(['Open', 'Finder', 'Restart', 'Kill'])
    srowOf(3000).querySelector<HTMLElement>('.top')!.click()
    expect(srows().filter((r) => r.classList.contains('unfolded'))).toEqual([srowOf(3000)])
  })

  it('offers only what the server would do: Docker nothing, system Open only, Restart only when the server can', () => {
    const w = load({ showAllListeners: true })
    w.publish(snapshot([]))
    const visible = (port: number) => ['open', 'reveal', 'restart', 'kill'].filter((n) => !button(srowOf(port), n).hidden)
    w.servers(servers([
      server(1, 3000),
      server(2, 5432, { dev: false, docker: 'postgres' }),
      server(3, 7000, { dev: false, system: true, project: 'ControlCenter', tool: 'ControlCenter' }),
      server(4, 8080, { dev: false, project: 'proxy', tool: 'proxy' }),
    ]))
    showServers()
    expect(visible(3000)).toEqual(['open', 'reveal', 'restart', 'kill'])
    expect(visible(5432)).toEqual([])
    expect(srowOf(5432).querySelector<HTMLElement>('.actions')!.hidden).toBe(true)
    expect(srowOf(5432).querySelector('.project')!.textContent).toBe('Docker → postgres')
    expect(visible(7000)).toEqual(['open'])
    expect(visible(8080)).toEqual(['open', 'kill'])
    w.servers(servers([server(1, 3000)], { canRestart: false }))
    expect(visible(3000)).toEqual(['open', 'reveal', 'kill'])
  })

  it('Open and Finder send at once with the row id; neither folds the row', () => {
    const w = load()
    w.publish(snapshot([]))
    w.servers(servers([server(1, 3000)]))
    showServers()
    srowOf(3000).querySelector<HTMLElement>('.top')!.click()
    button(srowOf(3000), 'open').click()
    button(srowOf(3000), 'reveal').click()
    expect(w.F.sendCommand.mock.calls).toEqual([
      ['companion:servers', 'open', { id: '1:Wed Oct 22 09:00:00 2026' }],
      ['companion:servers', 'reveal', { id: '1:Wed Oct 22 09:00:00 2026' }],
    ])
    expect(srowOf(3000).classList.contains('unfolded')).toBe(true)
  })

  it('Kill arms "Confirm?" for 3 s; a second touch inside sends it, none lets it go', async () => {
    vi.useFakeTimers()
    const w = load()
    w.publish(snapshot([]))
    w.servers(servers([server(1, 3000)]))
    showServers()
    srowOf(3000).querySelector<HTMLElement>('.top')!.click()
    button(srowOf(3000), 'kill').click()
    expect(w.F.sendCommand).not.toHaveBeenCalled()
    expect(button(srowOf(3000), 'kill').textContent).toBe('Confirm?')
    expect(button(srowOf(3000), 'kill').classList.contains('armed')).toBe(true)
    // A snapshot meanwhile keeps it armed.
    w.servers(servers([server(1, 3000)]))
    expect(button(srowOf(3000), 'kill').textContent).toBe('Confirm?')
    await vi.advanceTimersByTimeAsync(3000)
    expect(button(srowOf(3000), 'kill').textContent).toBe('Kill')
    button(srowOf(3000), 'kill').click()
    await vi.advanceTimersByTimeAsync(2999)
    button(srowOf(3000), 'kill').click()
    expect(w.F.sendCommand).toHaveBeenCalledWith('companion:servers', 'kill', { id: '1:Wed Oct 22 09:00:00 2026' })
    // Arming Restart disarms Kill.
    await vi.advanceTimersByTimeAsync(0)
    button(srowOf(3000), 'kill').click()
    button(srowOf(3000), 'restart').click()
    expect(button(srowOf(3000), 'kill').textContent).toBe('Kill')
    expect(button(srowOf(3000), 'restart').textContent).toBe('Confirm?')
    expect(w.F.sendCommand).toHaveBeenCalledTimes(1)
  })

  it('a restart holds the row as "Restarting…" with its buttons off, across the id change, then shows a refusal', async () => {
    vi.useFakeTimers()
    const w = load()
    w.publish(snapshot([]))
    w.servers(servers([server(1, 6006, { project: 'ds' })]))
    showServers()
    srowOf(6006).querySelector<HTMLElement>('.top')!.click()
    let answer!: (v: unknown) => void
    w.F.sendCommand.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    button(srowOf(6006), 'restart').click()
    button(srowOf(6006), 'restart').click()
    expect(w.F.sendCommand).toHaveBeenLastCalledWith('companion:servers', 'restart', { id: '1:Wed Oct 22 09:00:00 2026' })
    const busy = () => {
      const row = srowOf(6006)
      expect(row.querySelector('.status')!.textContent).toBe('Restarting…')
      expect(['open', 'reveal', 'restart', 'kill'].every((n) => button(row, n).disabled)).toBe(true)
    }
    busy()
    // The old server gone from the list, then Fremkit's new one under another pid: same row, still busy, still unfolded.
    w.servers(servers([]))
    w.servers(servers([server(77, 6006, { project: 'ds', managed: true, state: 'starting' })]))
    busy()
    expect(srowOf(6006).classList.contains('unfolded')).toBe(true)
    answer({ ok: false, error: 'The port stayed taken' })
    await vi.advanceTimersByTimeAsync(0)
    expect(srowOf(6006).querySelector('.status')!.textContent).toBe('The port stayed taken')
    expect(srowOf(6006).querySelector('.status')!.classList.contains('failed')).toBe(true)
    expect(button(srowOf(6006), 'restart').disabled).toBe(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(srowOf(6006).querySelector('.status')!.textContent).toBe('Starting…')
  })

  it('leaves the compact tile as it was: the sum, no segments', () => {
    expect(html).toMatch(/html\.compact \.stage \.pane,html\.compact \.stage \.segs\{display:none\}/)
  })
})
