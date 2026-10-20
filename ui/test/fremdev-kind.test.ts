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
  const chrome = { runtime: { id: 'ext', sendMessage } }
  const win: Record<string, unknown> = {}
  const run = (timer: typeof setTimeout = setTimeout) =>
    new Function('window', 'document', 'chrome', 'setTimeout', 'MutationObserver', 'URL', source)(win, document, chrome, timer, MutationObserver, URL)
  const sent = () => sendMessage.mock.calls.map(([m]) => m)
  return { run, sent, sendMessage }
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

  it('sends nothing once the extension is gone, and never throws', async () => {
    const p = page('<script type="module" src="/@vite/client"></script>')
    p.sendMessage.mockImplementation(() => { throw new Error('Extension context invalidated') })
    expect(() => p.run()).not.toThrow()
    await tick()
  })

  it('reads attributes and the DOM only: no page object, no network', () => {
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|postMessage|eval\(|\.innerHTML|wrappedJSObject|window\.(?!__fremdevKind)/)
  })
})
