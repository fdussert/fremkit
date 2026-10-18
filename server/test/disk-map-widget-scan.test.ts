import { describe, it, expect } from 'vite-plus/test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * The disk map widget's scan buttons, run in a DOM against a stub of the `Fremkit` bridge.
 *
 * jsdom is the UI package's dependency; it is borrowed from there rather than added to the server.
 */
const { JSDOM } = createRequire(fileURLToPath(new URL('../../ui/package.json', import.meta.url)))('jsdom') as {
  JSDOM: new (html: string, opts: { runScripts: 'outside-only' }) => { window: unknown }
}

const dir = new URL('../../widgets/disk-map/', import.meta.url)
const html = await readFile(fileURLToPath(new URL('index.html', dir)), 'utf8')
const sunburst = await readFile(fileURLToPath(new URL('sunburst.js', dir)), 'utf8')
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

const flush = () => new Promise((r) => setTimeout(r, 0))

interface Loaded {
  doc: Document
  commands: [string, string, Record<string, unknown>][]
  publish(snap: Record<string, unknown>): void
}

function load(answers: Record<string, unknown> = {}): Loaded {
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only' })
  const win = dom.window as unknown as Record<string, any>
  const commands: Loaded['commands'] = []
  let subscriber: ((d: unknown) => void) | null = null
  win.Fremkit = {
    locale: 'en', settings: {}, compact: false, size: { px: { width: 800, height: 300 } },
    whenReady: (cb: () => void) => cb(),
    onResize() {}, onLocale() {}, onSettings() {},
    subscribe: (_c: string, cb: (d: unknown) => void) => { subscriber = cb },
    sendCommand: (channel: string, name: string, payload: Record<string, unknown>) => {
      commands.push([channel, name, payload])
      return Promise.resolve(answers[name] ?? { ok: true, view: null })
    },
    t: (dict: Record<string, string> | string, params?: Record<string, string>) =>
      (typeof dict === 'string' ? dict : dict.en).replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k] ?? '')),
    el: (tag: string, cls?: string, text?: string) => {
      const n = win.document.createElement(tag)
      if (cls) n.className = cls
      if (text !== undefined) n.textContent = text
      return n
    },
  }
  win.eval(sunburst)
  win.eval(inline)
  return { doc: win.document, commands, publish: (snap) => subscriber!(snap) }
}

const neverScanned = { scanner: 'native', roots: [{ id: 'home', label: '~', kind: 'home' }], scanning: null, queued: [], results: {}, errors: {} }

describe('disk map widget', () => {
  it('never scans a root on its own, and offers a button that does', async () => {
    const w = load()
    w.publish(neverScanned)
    await flush()
    w.publish(neverScanned)
    await flush()
    expect(w.commands.filter(([, name]) => name === 'scan')).toEqual([])
    const cta = w.doc.getElementById('cta')!
    expect(cta.hidden).toBe(false)
    expect(w.doc.getElementById('ctaBtn')!.textContent).toBe('Scan the home folder')

    w.doc.getElementById('ctaBtn')!.dispatchEvent(new w.doc.defaultView!.MouseEvent('click', { bubbles: true }))
    await flush()
    expect(w.commands.filter(([, name]) => name === 'scan')).toEqual([['disk-map', 'scan', { root: 'home', path: [] }]])
    // The scan is under way: the button gives way to its progress.
    expect(cta.hidden).toBe(true)
  })

  it('says it waits for another root, and its ✕ takes it out of the queue', async () => {
    const w = load()
    w.publish({ ...neverScanned, scanning: { root: 'volume:Example', path: [], startedAt: 0, directories: 1, files: 0, current: [] }, queued: ['home'] })
    await flush()
    expect(w.doc.getElementById('cta')!.hidden).toBe(true)
    expect(w.doc.getElementById('status')!.textContent).toBe('Waiting: another scan is running')
    expect(w.doc.getElementById('scanBtn')!.textContent).toBe('✕')
    w.doc.getElementById('scanBtn')!.dispatchEvent(new w.doc.defaultView!.MouseEvent('click', { bubbles: true }))
    expect(w.commands.at(-1)).toEqual(['disk-map', 'cancel', { root: 'home' }])
  })

  it('says which folder macOS is asking about while the scan waits, and nothing once it moves on', async () => {
    const w = load()
    const scanning = { root: 'home', path: [], startedAt: 0, directories: 12, files: 0, current: ['Library'] }
    w.publish({ ...neverScanned, scanning: { ...scanning, waiting: ['Documents'] } })
    await flush()
    const ask = w.doc.getElementById('ask')!
    expect(ask.hidden).toBe(false)
    expect(w.doc.getElementById('askText')!.textContent).toBe(
      'macOS is asking whether Fremkit may open “Documents” — answer the window on the Mac (it may be behind the dashboard).')
    expect(w.doc.getElementById('askShow')!.textContent).toBe('Show the request')
    w.doc.getElementById('askShow')!.dispatchEvent(new w.doc.defaultView!.MouseEvent('click', { bubbles: true }))
    expect(w.commands.at(-1)).toEqual(['disk-map', 'revealPrompt', {}])
    // The scan's own progress stays on.
    expect(w.doc.getElementById('progress')!.hidden).toBe(false)
    w.publish({ ...neverScanned, scanning: { ...scanning, waiting: null } })
    await flush()
    expect(ask.hidden).toBe(true)
    // A scanned subfolder held itself is named by its own name.
    w.publish({ ...neverScanned, scanning: { ...scanning, path: ['Library', 'Mobile Documents'], waiting: [] } })
    await flush()
    expect(w.doc.getElementById('askText')!.textContent).toContain('“Mobile Documents”')
  })
})
