import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * The shortcuts widget's application icons, drawn for real.
 *
 * The widget is a plain browser script in an HTML file, so it is evaluated here against stubs.
 * What this watches is where the bundle id comes from: the widget asks the *host* for the
 * installed applications, because its own frame is served with `connect-src 'none'` and a
 * `fetch` from there never leaves the page — which is why every button for an application the
 * user never docked drew the kind's glyph instead of its icon.
 */
interface StubNode {
  tag: string; className: string; textContent: string; src: string
  children: StubNode[]
  retryTimer?: unknown
}

interface Loaded {
  /** The buttons currently in the grid, in order. */
  buttons(): StubNode[]
  /** What the first button draws as its artwork: an `img` node, or the kind's glyph. */
  artwork(): StubNode | undefined
  /** Hands the widget one answer from the dock channel, as the host delivers it. */
  publishDock(data: unknown): void
}

async function loadWidget(installed: unknown, settings: Record<string, unknown>): Promise<Loaded> {
  const html = await readFile(fileURLToPath(new URL('../../widgets/shortcuts/index.html', import.meta.url)), 'utf8')
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

  const node = (tag = 'div'): StubNode => {
    const self = {
      tag, className: '', textContent: '', src: '', alt: '', hidden: false, clientHeight: 300,
      children: [] as StubNode[],
      style: { setProperty: () => {} },
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      appendChild: (child: StubNode) => { self.children.push(child) },
      replaceChild: (next: StubNode, old: StubNode) => { self.children.splice(self.children.indexOf(old), 1, next) },
      addEventListener: () => {},
      onclick: null,
      // The widget empties the grid this way before rebuilding it.
      set innerHTML(_v: string) { self.children.length = 0 },
      get innerHTML() { return '' },
    } as unknown as StubNode
    return self
  }
  const nodes = new Map<string, StubNode>()
  const byId = (id: string): StubNode => {
    if (!nodes.has(id)) nodes.set(id, node())
    return nodes.get(id)!
  }
  const dockSubscribers: ((data: unknown) => void)[] = []
  const document = {
    documentElement: node('html'),
    getElementById: byId,
    createElement: (tag: string) => node(tag),
  }
  const Fremkit = {
    settings, locale: 'fr', compact: false, instanceId: 'shortcuts-1',
    size: { h: 8, px: { width: 320, height: 320 } },
    whenReady: (cb: () => void) => cb(),
    subscribe: (channel: string, cb: (data: unknown) => void) => {
      if (channel === 'dock') dockSubscribers.push(cb)
      return () => {}
    },
    onLocale: () => {}, onResize: () => {}, onSettings: () => {},
    sendCommand: () => Promise.resolve({ ok: true }),
    el: (tag: string, className: string, text?: unknown) => {
      const n = node(tag)
      n.className = className ?? ''
      n.textContent = String(text ?? '')
      return n
    },
    t: (dict: Record<string, string>) => dict.fr,
    esc: (value: unknown) => String(value ?? ''),
    color: (_value: unknown, fallback: string) => fallback,
    installedApps: () => (installed === REFUSED ? Promise.reject(new Error('unavailable')) : Promise.resolve(installed)),
  }
  // The widget refreshes the list on a timer; a test wants the one call it makes on startup.
  new Function('document', 'Fremkit', 'setInterval', script)(document, Fremkit, () => 0)
  const grid = () => byId('grid')
  return {
    buttons: () => grid().children,
    artwork: () => grid().children[0]?.children[0],
    publishDock: (data) => dockSubscribers.forEach((cb) => cb(data)),
  }
}

const terminal = { label: 'Terminal', kind: 'app', target: 'Terminal' }
/** Passed as the installed list to make the host's answer fail instead of arriving. */
const REFUSED = Symbol('refused')

describe('the shortcuts widget application icons', () => {
  it('draws the icon of an application that is not in the Dock', async () => {
    const loaded = await loadWidget([{ name: 'Terminal', bundleId: 'com.apple.Terminal' }], { buttons: [terminal] })
    await Promise.resolve()
    await Promise.resolve()
    expect(loaded.artwork()?.tag).toBe('img')
    expect(loaded.artwork()?.src).toBe('/api/apps/icon/com.apple.Terminal')
  })

  it('matches the bundle a name is filed under, not only its own name', async () => {
    const loaded = await loadWidget([{ name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', file: 'Code' }], {
      buttons: [{ label: 'Code', kind: 'app', target: 'Code.app' }],
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(loaded.artwork()?.src).toBe('/api/apps/icon/com.microsoft.VSCode')
  })

  it('keeps the glyph while the host has not answered, and when it never does', async () => {
    const loaded = await loadWidget(REFUSED, { buttons: [terminal] })
    expect(loaded.artwork()?.className).toContain('glyph')
    await Promise.resolve()
    expect(loaded.buttons()).toHaveLength(1)
  })

  it('still falls back to the Dock, which names a bundle id too', async () => {
    const loaded = await loadWidget([], { buttons: [terminal] })
    await Promise.resolve()
    await Promise.resolve()
    loaded.publishDock({ available: true, apps: [{ name: 'Terminal', bundleId: 'com.apple.Terminal', badge: null, running: true }] })
    expect(loaded.artwork()?.src).toBe('/api/apps/icon/com.apple.Terminal')
  })
})
