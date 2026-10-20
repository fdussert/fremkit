// @vitest-environment jsdom
/**
 * companion/fremdev/kind.js, the isolated-world script that tells which dev server served a tab
 * (Vite, Next or webpack-dev-server) from the page's script tags. It is a classic script: it is run
 * here against the jsdom document with a fake `chrome.runtime`, and a fresh `window` object per page
 * for its once-per-page guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'

const source = readFileSync(new NodeURL('../../companion/fremdev/kind.js', import.meta.url), 'utf8')

function page(head: string, body = '') {
  document.head.innerHTML = head
  document.body.innerHTML = body
  const sendMessage = vi.fn((_msg: unknown) => Promise.resolve())
  const chrome: { runtime: { id: string | undefined; sendMessage: typeof sendMessage } } = { runtime: { id: 'ext', sendMessage } }
  const win: Record<string, unknown> = {}
  const run = (timer: typeof setTimeout = setTimeout) =>
    new Function('window', 'document', 'chrome', 'setTimeout', 'MutationObserver', 'URL', source)(win, document, chrome, timer, MutationObserver, URL)
  const sent = () => sendMessage.mock.calls.map(([m]) => m)
  return { run, sent, sendMessage, chrome }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.useRealTimers()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('fremdev/kind.js', () => {
  it('tells Vite from its client script, with the base before @vite/client', async () => {
    const p = page('<script type="module" src="/@vite/client"></script>')
    p.run()
    await tick()
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'devserver', server: 'vite', base: '/' }])

    const q = page('<script type="module" src="/app/@vite/client"></script>')
    q.run()
    await tick()
    expect(q.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'devserver', server: 'vite', base: '/app/' }])
  })

  it('needs a module script for Vite', async () => {
    const p = page('<script src="/@vite/client"></script>')
    p.run()
    await tick()
    expect(p.sent()).toEqual([])
  })

  it('tells Next from a /_next/ script', async () => {
    const p = page('<script src="/_next/static/chunks/main.js"></script>')
    p.run()
    await tick()
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'devserver', server: 'next', base: '/' }])
  })

  it('tells webpack-dev-server from a script of its own', async () => {
    const p = page('<script src="/node_modules/webpack-dev-server/client/index.js"></script>')
    p.run()
    await tick()
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'devserver', server: 'webpack', base: '/' }])
  })

  it('tells webpack-dev-server from its overlay added after the load', async () => {
    const p = page('<script src="/main.js"></script>')
    p.run()
    await tick()
    expect(p.sent()).toEqual([])
    await new Promise((r) => setTimeout(r, 100))
    const overlay = document.createElement('iframe')
    overlay.id = 'webpack-dev-server-client-overlay'
    document.body.appendChild(overlay)
    await tick()
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'devserver', server: 'webpack', base: '/' }])
    // Found: it stops watching.
    document.head.appendChild(Object.assign(document.createElement('script'), { src: '/_next/x.js' }))
    await tick()
    expect(p.sent()).toHaveLength(1)
  })

  it('sends nothing for a page with none of them, and stops looking after 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = page('<script src="/main.js"></script><script type="module" src="/src/vite-client.js"></script>')
    p.run(setTimeout)
    await Promise.resolve()
    expect(p.sent()).toEqual([])
    vi.advanceTimersByTime(30_000)
    document.head.appendChild(Object.assign(document.createElement('script'), { src: '/_next/late.js' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(p.sent()).toEqual([])
  })

  it('runs once per page: a second run sends nothing more', async () => {
    const p = page('<script type="module" src="/@vite/client"></script>')
    p.run()
    p.run()
    await tick()
    expect(p.sent()).toHaveLength(1)
  })

  it('never throws when sending fails, and sends nothing once the extension is gone', async () => {
    const p = page('<script type="module" src="/@vite/client"></script>')
    p.sendMessage.mockImplementation(() => { throw new Error('Extension context invalidated') })
    expect(() => p.run()).not.toThrow()
    await tick()
    expect(p.sendMessage).toHaveBeenCalledTimes(1)

    const gone = page('<script type="module" src="/@vite/client"></script>')
    gone.chrome.runtime.id = undefined
    expect(() => gone.run()).not.toThrow()
    await tick()
    expect(gone.sent()).toEqual([])
  })

  it('says the kind is unknown for a Vite client whose base the worker would refuse', async () => {
    for (const src of ['/a//b/@vite/client', '/a b/@vite/client', `/${'a'.repeat(120)}/@vite/client`]) {
      const p = page(`<script type="module" src="${src}"></script>`)
      p.run()
      await tick()
      expect(p.sent(), src).toEqual([{ target: 'worker', type: 'dev.event', kind: 'devserver', server: null }])
    }
  })

  it('sees a src set on a script after it was added', async () => {
    const p = page('<script src="/main.js"></script>')
    p.run()
    await tick()
    const script = document.createElement('script')
    script.type = 'module'
    document.head.appendChild(script)
    await tick()
    expect(p.sent()).toEqual([])
    script.setAttribute('src', '/app/@vite/client')
    await tick()
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'devserver', server: 'vite', base: '/app/' }])
  })

  it('counts only scripts from the page\'s own origin', async () => {
    const p = page([
      '<script src="https://cdn.example.com/_next/static/x.js"></script>',
      '<script type="module" src="//other.example.com/@vite/client"></script>',
      '<script src="https://cdn.example.com/webpack-dev-server/client.js"></script>',
    ].join(''))
    p.run()
    await tick()
    expect(p.sent()).toEqual([])
    const own = page(`<script src="${location.origin}/_next/static/x.js"></script>`)
    own.run()
    await tick()
    expect(own.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'devserver', server: 'next', base: '/' }])
  })

  it('looks only at the added nodes once watching, a script inside an added element included', async () => {
    const p = page('<script src="/main.js"></script>')
    p.run()
    await tick()
    const scan = vi.spyOn(document, 'querySelectorAll')
    for (let i = 0; i < 5; i++) document.body.appendChild(document.createElement('div'))
    await tick()
    expect(scan).not.toHaveBeenCalled()
    const box = document.createElement('div')
    box.innerHTML = '<script type="module" src="/app/@vite/client"></script>'
    document.body.appendChild(box)
    await tick()
    scan.mockRestore()
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'devserver', server: 'vite', base: '/app/' }])
  })

  it('reads attributes and the DOM only: no page object, no network', () => {
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|postMessage|eval\(|\.innerHTML|wrappedJSObject|window\.(?!__fremdevKind)/)
    // The page's origin comes from `location`, whose `origin` is a platform getter, not page code.
    expect(source).toContain('location.origin')
  })
})
