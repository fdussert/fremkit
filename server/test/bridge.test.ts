import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * The bridge is a plain browser script, injected into every widget. It is evaluated here against
 * the smallest stand-ins for `window` and `document` it touches on load, so the helpers every
 * widget now relies on for escaping can be exercised without a DOM.
 */
interface Bridge {
  esc(value: unknown): string
  el(tag: string, className?: string, text?: unknown): { tagName: string; className: string; textContent: string }
  color(value: unknown, fallback?: string): string | null
}

/** What the loaded bridge did to its document, for the kiosk-behaviour tests. */
interface LoadResult {
  bridge: Bridge
  listeners: string[]
  styles: { attrs: Record<string, string>; textContent: string }[]
}

async function loadBridge(): Promise<LoadResult> {
  const src = await readFile(fileURLToPath(new URL('../src/bridge/fremkit.js', import.meta.url)), 'utf8')
  const window: Record<string, unknown> = {
    parent: { postMessage: () => {} },
    addEventListener: () => {},
  }
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
    documentElement: { lang: '', classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {}, removeProperty: () => {} } },
    head,
    createElement: element,
    addEventListener: (type: string) => { listeners.push(type) },
    dispatchEvent: () => {},
  }
  new Function('window', 'document', 'console', src)(window, document, console)
  return { bridge: window.Fremkit as Bridge, listeners, styles }
}

const loaded = await loadBridge()
const F = loaded.bridge

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
