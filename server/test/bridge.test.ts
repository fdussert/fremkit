import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { SDK_VERSION } from '../src/bridge/sdk.js'

/**
 * The bridge is a plain browser script, injected into every widget. It is evaluated here against
 * the smallest stand-ins for `window` and `document` it touches on load, so the helpers every
 * widget now relies on for escaping can be exercised without a DOM.
 */
interface Bridge {
  sdk: number
  esc(value: unknown): string
  el(tag: string, className?: string, text?: unknown): { tagName: string; className: string; textContent: string }
  color(value: unknown, fallback?: string): string | null
}

/** What the loaded bridge did to its document, for the kiosk-behaviour tests. */
interface LoadResult {
  bridge: Bridge
  listeners: string[]
  styles: { attrs: Record<string, string>; textContent: string }[]
  /** The custom properties standing on <html>, as the last call left them. */
  properties: Map<string, string>
  /** Hands the bridge a message from the host, the way the dashboard posts one. */
  send(message: Record<string, unknown>): void
}

async function loadBridge(): Promise<LoadResult> {
  const src = await readFile(fileURLToPath(new URL('../src/bridge/fremkit.js', import.meta.url)), 'utf8')
  let onMessage: ((event: { source: unknown; data: unknown }) => void) | null = null
  const window: Record<string, unknown> = {
    parent: { postMessage: () => {} },
    addEventListener: (type: string, cb: (event: { source: unknown; data: unknown }) => void) => {
      if (type === 'message') onMessage = cb
    },
  }
  const properties = new Map<string, string>()
  const listeners: string[] = []
  const styles: LoadResult['styles'] = []
  const element = (tag: string) => {
    const node: Record<string, unknown> = {
      tagName: tag.toUpperCase(), className: '', textContent: '',
      attrs: {} as Record<string, string>,
    }
    node.setAttribute = (name: string, value: string) => { (node.attrs as Record<string, string>)[name] = value }
    if (tag === 'style') styles.push(node as unknown as LoadResult['styles'][number])
    return node
  }
  const head = {
    firstChild: null as unknown,
    insertBefore: () => {},
    appendChild: () => {},
  }
  const document = {
    documentElement: {
      lang: '',
      classList: { add: () => {}, remove: () => {} },
      style: {
        setProperty: (name: string, value: string) => { properties.set(name, value) },
        removeProperty: (name: string) => { properties.delete(name) },
      },
    },
    head,
    createElement: element,
    // The kiosk guard asks whether its stylesheet is already there. Nothing is, in a fresh
    // document, which is what makes the one call below do its work.
    querySelector: () => null,
    addEventListener: (type: string) => { listeners.push(type) },
    dispatchEvent: () => {},
  }
  new Function('window', 'document', 'console', src)(window, document, console)
  return {
    bridge: window.Fremkit as Bridge,
    listeners,
    styles,
    properties,
    // The bridge answers its own parent and nothing else, so the event says it came from there.
    send: (message: Record<string, unknown>) => onMessage?.({ source: window.parent, data: message }),
  }
}

const loaded = await loadBridge()
const F = loaded.bridge

describe('Fremkit.sdk', () => {
  it('is the generation the server says it speaks', () => {
    // The bridge is a plain browser script and cannot import the constant, so it repeats it as a
    // literal. A bump on one side and not the other would have the server accept a manifest the
    // bridge cannot honour, which is exactly what the number exists to prevent.
    expect(F.sdk).toBe(SDK_VERSION)
  })
})

describe('Fremkit.esc', () => {
  it('neutralises the markup a remote string can carry', () => {
    expect(F.esc('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
    // A volume name, which is what widgets/disk used to concatenate as-is.
    expect(F.esc('</span><script>fetch("/api/config")</script>'))
      .toBe('&lt;/span&gt;&lt;script&gt;fetch(&quot;/api/config&quot;)&lt;/script&gt;')
  })
  it('escapes both quote characters, so the result is safe in an attribute too', () => {
    expect(F.esc('" onmouseover="x')).toBe('&quot; onmouseover=&quot;x')
    expect(F.esc("' onmouseover='x")).toBe('&#39; onmouseover=&#39;x')
  })
  it('escapes the ampersand before anything else, so nothing is double-decoded', () => {
    expect(F.esc('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;')
  })
  it('reads null, undefined and numbers the way a template needs', () => {
    expect(F.esc(null)).toBe('')
    expect(F.esc(undefined)).toBe('')
    expect(F.esc(0)).toBe('0')
    expect(F.esc(false)).toBe('false')
  })
})

describe('Fremkit.el', () => {
  it('builds an element whose text needs no escaping at all', () => {
    const node = F.el('div', 'row', '<img src=x onerror=alert(1)>')
    expect(node.tagName).toBe('DIV')
    expect(node.className).toBe('row')
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>')
  })
  it('leaves the class and the text alone when they are not given', () => {
    const node = F.el('span')
    expect(node.className).toBe('')
    expect(node.textContent).toBe('')
  })
})

describe('Fremkit.color', () => {
  it('passes a six-digit hex colour through, in either case', () => {
    expect(F.color('#0a7cff', '#000')).toBe('#0a7cff')
    expect(F.color('#0A7CFF', '#000')).toBe('#0A7CFF')
  })
  it('refuses anything that would be more than one declaration', () => {
    for (const bad of ['red; background: url(https://evil.example/x)', '#fff', '#0a7cf', '#0a7cfff',
      'rgb(1,2,3)', 'red', '', null, undefined, '#zzzzzz']) {
      expect(F.color(bad, '#5f6771'), String(bad)).toBe('#5f6771')
    }
  })
  it('answers null when no fallback is given', () => {
    expect(F.color('nope')).toBeNull()
  })
})

describe('what the bridge does to a widget document', () => {
  it('refuses the context menu and drag, which is what a long press raises', () => {
    // WebKit answers a long press inside a widget with "Open Frame in New Window", on a screen
    // with no keyboard and no chrome to get back from.
    expect(loaded.listeners).toContain('contextmenu')
    expect(loaded.listeners).toContain('dragstart')
  })

  it('injects the kiosk stylesheet, marked so it can be found', () => {
    const style = loaded.styles.find((s) => s.attrs['data-fremkit'] === 'kiosk')
    expect(style).toBeDefined()
    for (const rule of ['user-select:none', '-webkit-touch-callout:none',
      '-webkit-tap-highlight-color:transparent', '-webkit-user-drag:none',
      '::-webkit-scrollbar{display:none}', 'cursor:default']) {
      expect(style!.textContent, rule).toContain(rule)
    }
  })

  it('says the same thing as the dashboard\'s own copy', async () => {
    // Two copies exist on purpose — the bridge is a plain browser script injected into a
    // sandboxed iframe and cannot import a module — so they are compared rather than trusted.
    const kiosk = await readFile(fileURLToPath(new URL('../../ui/src/shared/kiosk.ts', import.meta.url)), 'utf8')
    const parts = /export const KIOSK_CSS = \[([\s\S]*?)\]\.join\(''\)/.exec(kiosk)
    expect(parts, 'KIOSK_CSS not found in ui/src/shared/kiosk.ts').not.toBeNull()
    const uiCss = [...parts![1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('')
    const style = loaded.styles.find((s) => s.attrs['data-fremkit'] === 'kiosk')
    expect(style!.textContent).toBe(uiCss)
  })

  it('leaves no trace of the project\'s former name', async () => {
    const src = await readFile(fileURLToPath(new URL('../src/bridge/fremkit.js', import.meta.url)), 'utf8')
    expect(src.toLowerCase()).not.toContain('vardek')
  })
})

/**
 * The tokens of the theme in force are painted on the widget's own <html>, and the tile's
 * appearance is applied after them so a colour chosen in the editor still wins. Which means the
 * appearance pass must put back what the theme set when the tile carries no colour of its own —
 * the case of nearly every tile. It used to remove it, and the widgets stayed on the fallback
 * written into their CSS whatever theme the screen was wearing.
 */
describe('a widget under a theme', () => {
  const TERMINAL = { '--accent': '#39ff88', '--on-accent': '#041008', '--text': '#cfeede' }

  /** A fresh bridge per case: the properties on <html> are what is being asked about. */
  async function screen(): Promise<LoadResult> {
    const loaded = await loadBridge()
    loaded.send({ type: 'fremkit:init', instanceId: 'w-1', settings: {}, tokens: TERMINAL })
    return loaded
  }

  it('wears the theme accent on a tile that has none of its own', async () => {
    const { properties } = await screen()
    expect(properties.get('--accent')).toBe('#39ff88')
    expect(properties.get('--on-accent')).toBe('#041008')
    expect(properties.get('--text')).toBe('#cfeede')
  })

  it('lets the tile colour win over the theme, and takes the theme back when it is cleared', async () => {
    const loaded = await screen()
    loaded.send({ type: 'fremkit:appearance', accentColor: '#ff0000', tokens: TERMINAL })
    expect(loaded.properties.get('--accent')).toBe('#ff0000')
    // Light text on a dark accent: the luminance rule the host frame uses.
    expect(loaded.properties.get('--on-accent')).toBe('#fff')

    loaded.send({ type: 'fremkit:appearance', accentColor: null, tokens: TERMINAL })
    expect(loaded.properties.get('--accent')).toBe('#39ff88')
    expect(loaded.properties.get('--on-accent')).toBe('#041008')
  })

  it('leaves the property unset when neither the theme nor the tile names a colour', async () => {
    const loaded = await loadBridge()
    loaded.send({ type: 'fremkit:init', instanceId: 'w-1', settings: {}, tokens: { '--text': '#cfeede' } })
    expect(loaded.properties.has('--accent')).toBe(false)
    expect(loaded.properties.has('--on-accent')).toBe(false)
  })

  it('follows a theme change without a reload', async () => {
    const loaded = await screen()
    loaded.send({ type: 'fremkit:appearance', tokens: { '--accent': '#a2622a' } })
    expect(loaded.properties.get('--accent')).toBe('#a2622a')
    // The theme that follows leaves the token out: back to the widget's own fallback.
    expect(loaded.properties.has('--text')).toBe(false)
  })
})
