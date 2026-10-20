// @vitest-environment jsdom
/**
 * companion/fremdev/build.js, the isolated-world script that reports a dev server's compile error
 * overlay (Vite, webpack-dev-server, Next) as a `build` page event. It is a classic script: it is run
 * here against the jsdom document with a fake `chrome.runtime`, and a fresh `window` object per page
 * for its once-per-page guard.
 *
 * The overlays come from real dev servers (test/fixtures/fremdev/, see the commit that added them):
 * a declarative shadow root (`<template shadowrootmode>`) is attached by hand, jsdom's parser does not,
 * and an iframe's document travels as a `<template data-frame-document>` written into the frame.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'

const source = readFileSync(new NodeURL('../../companion/fremdev/build.js', import.meta.url), 'utf8')
const fixture = (name: string) => readFileSync(new NodeURL(`./fixtures/fremdev/${name}`, import.meta.url), 'utf8')

/** Attaches every declarative shadow root under `root`, nested ones included. */
function hydrate(root: ParentNode) {
  for (const tpl of [...root.querySelectorAll('template[shadowrootmode]')] as HTMLTemplateElement[]) {
    const host = tpl.parentElement!
    const shadow = host.attachShadow({ mode: tpl.getAttribute('shadowrootmode') as ShadowRootMode })
    shadow.append(tpl.content)
    tpl.remove()
    hydrate(shadow)
  }
}

/** The overlay of `name` added to the page, as the dev server's client adds it. */
function addOverlay(name: string): Element[] {
  const box = document.createElement('div')
  box.innerHTML = fixture(name)
  const frames = [...box.querySelectorAll('template[data-frame-document]')] as HTMLTemplateElement[]
  for (const f of frames) f.remove()
  hydrate(box)
  const added = [...box.children]
  document.body.append(...added)
  for (const f of frames) {
    const frame = document.getElementById(f.getAttribute('data-frame-document')!) as HTMLIFrameElement
    frame.contentDocument!.documentElement.innerHTML = f.innerHTML
  }
  return added
}

function page() {
  const sendMessage = vi.fn((_msg: unknown) => Promise.resolve())
  const chrome: { runtime: { id: string | undefined; sendMessage: typeof sendMessage } } = { runtime: { id: 'ext', sendMessage } }
  const win: Record<string, unknown> = {}
  const run = () => new Function('window', 'document', 'chrome', source)(win, document, chrome)
  const sent = () => sendMessage.mock.calls.map(([m]) => m as Record<string, unknown>)
  return { run, sent, sendMessage, chrome }
}

const BUILD = { target: 'worker', type: 'dev.event', kind: 'build' }
const CLEAR = { target: 'worker', type: 'dev.event', kind: 'build-clear' }

/** Past the debounce and the rate limit. */
const settle = async (ms = 1_000) => {
  await vi.advanceTimersByTimeAsync(ms)
}

afterEach(() => {
  vi.useRealTimers()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('fremdev/build.js', () => {
  it('reports the Vite overlay with its message, file, line and column, and its removal once', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [overlay] = addOverlay('vite-overlay.html')
    await settle()
    expect(p.sent()).toEqual([{ ...BUILD, text: 'Invalid end tag.', file: '/Users/example/app/src/App.vue', line: 12, col: 3 }])
    overlay.remove()
    await settle()
    expect(p.sent()).toEqual([expect.objectContaining({ kind: 'build' }), CLEAR])
    await settle()
    expect(p.sent()).toHaveLength(2)
  })

  it('sees an overlay that is already on the page when it starts', async () => {
    vi.useFakeTimers()
    addOverlay('vite-overlay.html')
    const p = page()
    p.run()
    await settle()
    expect(p.sent()).toEqual([expect.objectContaining({ kind: 'build', line: 12 })])
  })

  it('reports the webpack overlay of a compile error, with its relative file', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    addOverlay('webpack-overlay-compile.html')
    await settle()
    const sent = p.sent()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ ...BUILD, file: './src/index.js', line: 2, col: 1 })
    expect(sent[0].text).toMatch(/^Module parse failed: Unexpected token \(2:0\)/)
  })

  it('ignores webpack\'s overlay of runtime errors', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    addOverlay('webpack-overlay-runtime.html')
    await settle()
    expect(p.sent()).toEqual([])
  })

  it('reports Next\'s build error dialog, never its runtime dialog nor the dev indicator alone', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [portal] = addOverlay('next-build-error.html')
    await settle()
    expect(p.sent()).toEqual([{ ...BUILD, text: 'Expected \'</\', got \'onClick\'', file: './app/page.js', line: 3, col: 1 }])
    portal.remove()
    await settle()
    expect(p.sent().at(-1)).toEqual(CLEAR)

    for (const name of ['next-runtime-error.html', 'next-indicator.html']) {
      document.body.innerHTML = ''
      const q = page()
      q.run()
      addOverlay(name)
      await settle()
      expect(q.sent(), name).toEqual([])
    }
  })

  it('sends one message for an overlay that re-renders 50 times in a second, and a second for a new text', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [overlay] = addOverlay('vite-overlay.html')
    const body = overlay.shadowRoot!.querySelector('.message-body')!
    for (let i = 0; i < 50; i++) {
      body.textContent = 'Invalid end tag.'
      await vi.advanceTimersByTimeAsync(20)
    }
    await settle()
    expect(p.sent()).toHaveLength(1)
    body.textContent = 'Element is missing end tag.'
    await settle()
    expect(p.sent()).toHaveLength(2)
    expect(p.sent()[1]).toMatchObject({ kind: 'build', text: 'Element is missing end tag.' })
  })

  it('sends at most 2 messages a second: 500 ms or more between two', async () => {
    vi.useFakeTimers()
    const p = page()
    const stamps: number[] = []
    p.sendMessage.mockImplementation(() => {
      stamps.push(Date.now())
      return Promise.resolve()
    })
    p.run()
    const [overlay] = addOverlay('vite-overlay.html')
    const body = overlay.shadowRoot!.querySelector('.message-body')!
    await settle()
    const start = p.sent().length
    for (let i = 0; i < 20; i++) {
      body.textContent = `error ${i}`
      await vi.advanceTimersByTimeAsync(210)
    }
    // 20 changes over 4.2 s: no more than 2 a second, the latest among them.
    const n = p.sent().length - start
    expect(n).toBeLessThanOrEqual(9)
    expect(n).toBeGreaterThan(0)
    await settle()
    expect(p.sent().at(-1)).toMatchObject({ text: 'error 19' })
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1], `send ${i}`).toBeGreaterThanOrEqual(500)
  })

  it('reads the frame when the Vite message is blank, and never clears while the overlay shows', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [overlay] = addOverlay('vite-overlay.html')
    const root = overlay.shadowRoot!
    root.querySelector('.message-body')!.textContent = '  \n  '
    await settle()
    expect(p.sent()).toEqual([expect.objectContaining({ kind: 'build', file: '/Users/example/app/src/App.vue', line: 12 })])
    expect(p.sent()[0].text).toMatch(/^10 \| <\/button> 11 \| <\/main> 12 \| <\/section>/)
    // Mid-render: nothing to read at all. What was said stands.
    root.querySelector('.frame')!.textContent = ''
    await settle()
    expect(p.sent()).toHaveLength(1)
    overlay.remove()
    await settle()
    expect(p.sent().at(-1)).toEqual(CLEAR)
  })

  it('clips a 2 000-character message to 300', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [overlay] = addOverlay('vite-overlay.html')
    overlay.shadowRoot!.querySelector('.message-body')!.textContent = 'x'.repeat(2_000)
    await settle()
    expect(p.sent()).toHaveLength(1)
    expect(p.sent()[0].text).toBe('x'.repeat(300))
  })

  it('runs once per page, and never throws when the extension is gone', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    p.run()
    addOverlay('vite-overlay.html')
    await settle()
    expect(p.sent()).toHaveLength(1)

    document.body.innerHTML = ''
    const gone = page()
    gone.chrome.runtime.id = undefined
    expect(() => gone.run()).not.toThrow()
    addOverlay('vite-overlay.html')
    await settle()
    expect(gone.sent()).toEqual([])

    document.body.innerHTML = ''
    const failing = page()
    failing.sendMessage.mockImplementation(() => { throw new Error('Extension context invalidated') })
    failing.run()
    addOverlay('vite-overlay.html')
    await expect(settle()).resolves.toBeUndefined()
    expect(failing.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('reads text and attributes only: no page object, no network, the shadow root through the prototype getter', () => {
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|postMessage|eval\(|\.innerHTML|innerText|wrappedJSObject|window\.(?!__fremdevBuild)/)
    expect(source).toContain("Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')")
    // Every selector is in the one table at the top.
    expect(source).toMatch(/const READERS = /)
  })
})
