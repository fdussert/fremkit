import { afterEach, describe, expect, it, vi } from 'vitest'
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
  parentNode: StubNode | null
  isConnected: boolean
  retryTimer?: unknown
}

interface Loaded {
  /** The buttons currently in the grid, in order. */
  buttons(): StubNode[]
  /** What the first button draws as its artwork: an `img` node, or the kind's glyph. */
  artwork(): StubNode | undefined
  /** Hands the widget one answer from the dock channel, as the host delivers it. */
  publishDock(data: unknown): void
  iconRequests(): string[]
  /** Every command the widget sent, as `[channel, command, payload]`. */
  sent(): unknown[][]
}

async function loadWidget(installed: unknown, settings: Record<string, unknown>): Promise<Loaded> {
  const html = await readFile(fileURLToPath(new URL('../../widgets/shortcuts/index.html', import.meta.url)), 'utf8')
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

  const node = (tag = 'div'): StubNode => {
    const self = {
      tag, className: '', textContent: '', src: '', alt: '', hidden: false, clientHeight: 300,
      children: [] as StubNode[], parentNode: null, isConnected: true,
      style: { setProperty: () => {} },
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      appendChild: (child: StubNode) => { child.parentNode = self; self.children.push(child) },
      replaceChild: (next: StubNode, old: StubNode) => { old.parentNode = null; next.parentNode = self; self.children.splice(self.children.indexOf(old), 1, next) },
      addEventListener: () => {},
      onclick: null,
      // The widget empties the grid this way before rebuilding it.
      set innerHTML(_v: string) { self.children.forEach((child) => { child.parentNode = null; child.isConnected = false }); self.children.length = 0 },
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
  const iconRequests: string[] = []
  const sent: unknown[][] = []
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
    sendCommand: (...args: unknown[]) => { sent.push(args); return Promise.resolve({ ok: true }) },
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
    // A link's site icon never arrives here: the button keeps its glyph.
    favicon: () => new Promise(() => {}),
    image: () => new Promise(() => {}),
    appIcon: (bundleId: string) => { iconRequests.push(bundleId); return Promise.resolve('data:image/png;base64,aWNvbg==') },
  }
  // The widget refreshes the list on a timer; a test wants the one call it makes on startup.
  new Function('document', 'Fremkit', 'setInterval', script)(document, Fremkit, () => 0)
  const grid = () => byId('grid')
  return {
    buttons: () => grid().children,
    artwork: () => grid().children[0]?.children[0],
    publishDock: (data) => dockSubscribers.forEach((cb) => cb(data)),
    iconRequests: () => iconRequests,
    sent: () => sent,
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
    expect(loaded.artwork()?.src).toBe('data:image/png;base64,aWNvbg==')
    expect(loaded.iconRequests()).toContain('com.apple.Terminal')
  })

  it('matches the bundle a name is filed under, not only its own name', async () => {
    const loaded = await loadWidget([{ name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', file: 'Code' }], {
      buttons: [{ label: 'Code', kind: 'app', target: 'Code.app' }],
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(loaded.artwork()?.src).toBe('data:image/png;base64,aWNvbg==')
    expect(loaded.iconRequests()).toContain('com.microsoft.VSCode')
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
    await Promise.resolve()
    expect(loaded.artwork()?.src).toBe('data:image/png;base64,aWNvbg==')
    expect(loaded.iconRequests()).toContain('com.apple.Terminal')
  })
})

describe('pressing a shortcuts button', () => {
  it('names the button by its place in the saved list, a half-typed one before it included', async () => {
    // The host reads the saved list by index; the skipped row must not shift the ones after it.
    const loaded = await loadWidget([], { buttons: [{ label: 'Unfinished', kind: 'app', target: '' }, terminal] })
    expect(loaded.buttons()).toHaveLength(1)
    ;(loaded.buttons()[0] as unknown as { onclick: () => void }).onclick()
    expect(loaded.sent()[0]).toEqual(['shortcuts', 'open', { instanceId: 'shortcuts-1', index: 1 }])
  })
})

describe('a group of shortcuts', () => {
  afterEach(() => { vi.useRealTimers() })
  const groups = {
    buttons: [
      terminal,
      { label: 'Prod', kind: 'group', target: '', items: [
        { label: 'Deploy', kind: 'url', target: 'https://example.com/deploy' },
        { label: 'Unfinished', kind: 'url', target: '' },
        { label: 'Logs', kind: 'url', target: 'https://example.com/logs' },
      ] },
      { label: '', kind: 'group', target: '', items: [] },
    ],
  }
  const names = (loaded: Loaded) => loaded.buttons().map((b) => b.children[1]?.textContent)
  const tap = (loaded: Loaded, i: number) => (loaded.buttons()[i] as unknown as { onclick: () => void }).onclick()

  it('opens in place of the grid behind a back button, and presses a button by its place in the group', async () => {
    vi.useFakeTimers()
    const loaded = await loadWidget([], groups)
    // The nameless empty group is an unfinished row, not a button.
    expect(names(loaded)).toEqual(['Terminal', 'Prod'])
    tap(loaded, 1)
    await vi.advanceTimersByTimeAsync(200)
    expect(names(loaded)).toEqual(['Prod', 'Deploy', 'Logs'])
    tap(loaded, 2)
    expect(loaded.sent()[0]).toEqual(['shortcuts', 'open', { instanceId: 'shortcuts-1', index: 1, item: 2 }])
    // Once the shortcut ran, the group folds back by itself.
    await vi.advanceTimersByTimeAsync(1400 + 200)
    expect(names(loaded)).toEqual(['Terminal', 'Prod'])
  })

  it('closes on the back button, and by itself after a while untouched', async () => {
    vi.useFakeTimers()
    const loaded = await loadWidget([], groups)
    tap(loaded, 1)
    await vi.advanceTimersByTimeAsync(200)
    tap(loaded, 0)
    await vi.advanceTimersByTimeAsync(200)
    expect(names(loaded)).toEqual(['Terminal', 'Prod'])
    tap(loaded, 1)
    await vi.advanceTimersByTimeAsync(200)
    expect(names(loaded)).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(8000 + 200)
    expect(names(loaded)).toEqual(['Terminal', 'Prod'])
  })
})
