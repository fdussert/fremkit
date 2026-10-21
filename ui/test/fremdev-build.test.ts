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
    expect(p.sent()).toEqual([{
      ...BUILD, text: 'Invalid end tag.', file: '/Users/example/app/src/App.vue', line: 12, col: 3,
      frame: ['10 |      </button>', '11 |    </main>', '12 |    </section>', '   |     ^', '13 |  </template>', '14 |'],
      stack: expect.arrayContaining(['at emitError (/Users/example/app/node_modules/@vue/compiler-core/dist/compiler-core.cjs.js:3036:5)']),
    }])
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
    expect(p.sent()).toEqual([{ ...BUILD, text: 'Expected \'</\', got \'onClick\'', file: './app/page.js', line: 3, col: 1, frame: expect.any(Array), stack: expect.any(Array) }])
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

  it("reads Vite's code frame and stack, and the SFC compiler's message without the frame it repeats", async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [overlay] = addOverlay('vite-overlay-sfc.html')
    await settle()
    expect(p.sent()).toEqual([{
      ...BUILD,
      text: '[vue/compiler-sfc] Unexpected token (3:18)',
      file: '/Users/example/app/src/App.vue',
      line: 3,
      col: 18,
      frame: [
        '1  |  <script setup>',
        "2  |  const title = 'Scratch Vite'",
        '3  |  const broken = 1 +* 2',
        '   |      ^',
        '4  |  const other = 3',
        '5  |  </script>',
      ],
      stack: expect.any(Array),
    }])
    const stack = p.sent()[0].stack as string[]
    expect(stack).toHaveLength(10)
    expect(stack[0]).toBe('at constructor (/Users/example/app/node_modules/@babel/parser/lib/index.js:369:19)')
    // The case a user copied: the message, the file on a line of its own, then a frame's last line.
    overlay.shadowRoot!.querySelector('.message-body')!.textContent =
      '[vue/compiler-sfc] Unexpected token (3:15)\n\n/Users/example/app/src/App.vue\n12 |'
    await settle()
    expect(p.sent().at(-1)).toMatchObject({ text: '[vue/compiler-sfc] Unexpected token (3:15)' })
  })

  it("reads a hot update's Vite overlay: no file but the message's, the frame from the message", async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    // A real overlay of an SFC broken while the page was open: `.file` says `unknown file:3:15`, the
    // `.frame` is empty, and the message holds the path and the code frame.
    const [overlay] = addOverlay('vite-overlay-hmr.html')
    await settle()
    expect(p.sent()).toEqual([{
      ...BUILD,
      text: '[vue/compiler-sfc] Unexpected token (3:15)',
      file: '/Users/example/app/src/App.vue',
      line: 3,
      col: 15,
      frame: ['8  |  <script setup>', "9  |  const title = 'Scratch Vite'", '10 |  const broken = ;', '   |                 ^', '11 |  </script>', '12 |'],
      stack: expect.arrayContaining(['at constructor (/Users/example/app/node_modules/@babel/parser/lib/index.js:369:19)']),
    }])
    const root = overlay.shadowRoot!
    const body = root.querySelector('.message-body')!
    // The path's own line and column win over the `(L:C)`.
    body.textContent = '[plugin] Bad (3:15)\n\n/Users/example/app/src/App.vue:10:17'
    await settle()
    expect(p.sent().at(-1)).toMatchObject({ text: '[plugin] Bad (3:15)', file: '/Users/example/app/src/App.vue', line: 10, col: 17 })
    // No path anywhere: the `unknown file` position stands, and no file.
    body.textContent = '[plugin] Bad (4:2)'
    await settle()
    expect(p.sent().at(-1)).toEqual({ ...BUILD, text: '[plugin] Bad (4:2)', line: 3, col: 15, stack: expect.any(Array) })
    // Neither a file nor a position in `.file`: the `(L:C)` of the message.
    root.querySelector('.file')!.textContent = 'unknown file'
    body.textContent = '[plugin] Worse (4:2)'
    await settle()
    expect(p.sent().at(-1)).toEqual({ ...BUILD, text: '[plugin] Worse (4:2)', line: 4, col: 2, stack: expect.any(Array) })
    expect(JSON.stringify(p.sent())).not.toContain('unknown file')
  })

  it('drops the file and the code frame residue from a message, keeping its prefix', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [overlay] = addOverlay('vite-overlay-sfc.html')
    const body = overlay.shadowRoot!.querySelector('.message-body')!
    const cases: Array<[string, string]> = [
      ['[plugin] Bad thing /Users/example/app/src/App.vue:3:18 here', '[plugin] Bad thing here'],
      ['[plugin] Bad /Users/example/app/src/App.vue:3', '[plugin] Bad'],
      // Another file stays, and so does one the path only starts.
      ['[plugin] Bad /Users/example/app/src/Other.vue', '[plugin] Bad /Users/example/app/src/Other.vue'],
      ['[plugin] Bad /Users/example/app/src/App.vue.bak', '[plugin] Bad /Users/example/app/src/App.vue.bak'],
      ['Unexpected token\n  2 | a\n> 3 | b +* c\n    |     ^\n  4 | d', 'Unexpected token'],
      ['Unexpected token\n    ^\nmore', 'Unexpected token more'],
      // A first line that only looks like a frame's is the message's own text.
      ["1 | 2 is not assignable to type 'string'\n  1 | type A = 1 | 2\n    | ^", "1 | 2 is not assignable to type 'string'"],
      ['\n  1 | 2 is not a frame here', '1 | 2 is not a frame here'],
    ]
    for (const [message, text] of cases) {
      body.textContent = message
      await settle()
      expect(p.sent().at(-1)?.text, message).toBe(text)
    }
  })

  it("reads webpack's code frame from its message, and Next's frame and what follows it", async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    addOverlay('webpack-overlay-compile.html')
    await settle()
    const [w] = p.sent()
    expect(w.text).toBe("Module parse failed: Unexpected token (2:0) File was parsed as module type 'javascript/auto'. You may need an appropriate loader to handle this file type, currently no loaders are configured to process this file. See https://webpack.js.org/concepts#loaders")
    expect(w.frame).toEqual([
      "  1 | document.body.insertAdjacentHTML((('beforeend', '<h1>Scratch webpack</h1><button id=\"b\">Throw</button>')",
      "> 2 | document.getElementById('b').addEventListener('click', () => { throw new Error('runtime boom') })",
      '    | ^',
      '  3 |',
    ])
    expect(w).not.toHaveProperty('stack')

    document.body.innerHTML = ''
    const q = page()
    q.run()
    addOverlay('next-build-error.html')
    await settle()
    const [n] = q.sent()
    expect(n.frame).toEqual([
      '   ,-[/Users/example/app/app/page.js:3:1]',
      " 1 | 'use client'",
      ' 2 | export default function Page() {',
      " 3 |   return <main>{(<h1>Scratch Next</h1><button onClick={() => { throw new Error('runtime boom') }}>Throw</button></main>",
      '   :                                               ^^^^^^^',
      ' 4 | }',
      '   `----',
    ])
    expect(n.stack).toEqual(['Caused by:', 'Syntax Error', 'Import trace for requested module:', './app/page.js'])
  })

  it('keeps the frame to 20 lines and the stack to 30, 300 characters each, 6 000 in all', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [overlay] = addOverlay('vite-overlay-sfc.html')
    const root = overlay.shadowRoot!
    const lines = (n: number, len: number) => Array.from({ length: n }, (_, i) => `${i} |`.padEnd(len, 'x')).join('\n')
    root.querySelector('.frame')!.textContent = lines(25, 10)
    root.querySelector('.stack')!.textContent = lines(35, 10)
    await settle()
    let last = p.sent().at(-1) as { frame: string[]; stack: string[] }
    expect(last.frame).toHaveLength(20)
    expect(last.stack).toHaveLength(30)
    root.querySelector('.frame')!.textContent = lines(20, 400)
    root.querySelector('.stack')!.textContent = lines(30, 400)
    await settle()
    last = p.sent().at(-1) as { frame: string[]; stack: string[] }
    // Each line cut to 300: 19 of them and their line breaks fit 6 000, the stack none.
    expect(last.frame).toHaveLength(19)
    expect(last.frame.every((l) => l.length === 300)).toBe(true)
    expect(last).not.toHaveProperty('stack')
    const value = (name: string) => Number(new RegExp(`const ${name} = ([\\d_]+)`).exec(source)?.[1].replace(/_/g, ''))
    // lib/devlog.js's boundBuildLines bounds (pinned to the same values in server/test/companion-fremdev-lib.test.ts).
    expect([value('MAX_FRAME_LINES'), value('MAX_STACK_LINES'), value('MAX_LINE'), value('MAX_EXTRA')]).toEqual([20, 30, 300, 6_000])
  })

  it("bounds the frame and stack exactly as lib/devlog.js's boundBuildLines on the same inputs", async () => {
    // lib/devlog.js takes URL.prototype's getters at load, which jsdom's URL lacks: Node's, for the import.
    const jsdomUrl = globalThis.URL
    globalThis.URL = NodeURL as unknown as typeof URL
    let boundBuildLines: (f: string[], s: string[]) => { frame?: string[]; stack?: string[] }
    try {
      // @ts-expect-error plain JS module outside ui/, no declarations
      ;({ boundBuildLines } = await import('../../companion/lib/devlog.js'))
    } finally {
      globalThis.URL = jsdomUrl
    }
    const many = (n: number, len: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i} |`.padEnd(len, 'x'))
    const pair = '\u{1F600}'
    const inputs: Array<[string[], string[]]> = [
      [many(3, 20, 'f'), many(3, 20, 's')],
      [many(25, 10, 'f'), many(35, 10, 's')],
      [many(20, 400, 'f'), many(30, 400, 's')],
      [many(10, 300, 'f'), many(30, 300, 's')],
      [many(19, 300, 'f'), many(5, 200, 's')],
      [many(5, 299, 'f').map((l) => l.slice(0, 299) + pair), [`s0 ${'y'.repeat(296)}${pair}`]],
      [many(1, 50, 'f'), many(40, 150, 's')],
      [[], many(2, 30, 's')],
      // The edges of the 6 000: 19 lines of 300 leave 281, which a line of 281 and its break overrun.
      [many(19, 300, 'f'), many(1, 281, 's')],
      [many(19, 300, 'f'), many(1, 280, 's')],
    ]
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [overlay] = addOverlay('vite-overlay-sfc.html')
    const root = overlay.shadowRoot!
    for (const [i, [frame, stack]] of inputs.entries()) {
      root.querySelector('.message-body')!.textContent = `case ${i}`
      root.querySelector('.frame')!.textContent = frame.join('\n')
      root.querySelector('.stack')!.textContent = stack.join('\n')
      await settle()
      const sent = p.sent().at(-1)!
      expect(sent.text, `case ${i}`).toBe(`case ${i}`)
      const { frame: f, stack: s } = sent as { frame?: string[]; stack?: string[] }
      expect({ ...(f ? { frame: f } : {}), ...(s ? { stack: s } : {}) }, `case ${i}`).toEqual(boundBuildLines(frame, stack))
    }
  })

  it('says a changed code frame again for the same message', async () => {
    vi.useFakeTimers()
    const p = page()
    p.run()
    const [overlay] = addOverlay('vite-overlay-sfc.html')
    await settle()
    overlay.shadowRoot!.querySelector('.frame')!.textContent = '4  |  const broken = 1 +* 2\n   |      ^'
    await settle()
    expect(p.sent()).toHaveLength(2)
    expect(p.sent()[1]).toMatchObject({ text: '[vue/compiler-sfc] Unexpected token (3:18)', frame: ['4  |  const broken = 1 +* 2', '   |      ^'] })
  })

  it('reads text and attributes only: no page object, no network, the shadow root through the prototype getter', () => {
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|postMessage|eval\(|\.innerHTML|innerText|wrappedJSObject|window\.(?!__fremdevBuild)/)
    expect(source).toContain("Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')")
    // Every selector is in the one table at the top.
    expect(source).toMatch(/const READERS = /)
  })
})
