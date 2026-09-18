import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * The Spotify widget's long press, run for real.
 *
 * The widget is a plain browser script in an HTML file, so it is evaluated here against stubs
 * that record the listeners it registers — then the recorded `contextmenu` handler is called,
 * which is exactly what the Edge's touch driver produces for a press held past its threshold.
 */
interface Loaded {
  listeners: Map<string, ((e: unknown) => void)[]>
  commands: [string, string, unknown?][]
  settings: Record<string, unknown>
}

async function loadWidget(settings: Record<string, unknown>): Promise<Loaded> {
  const html = await readFile(fileURLToPath(new URL('../../widgets/spotify/index.html', import.meta.url)), 'utf8')
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

  const listeners = new Map<string, ((e: unknown) => void)[]>()
  const commands: [string, string, unknown?][] = []
  const node = () => ({
    textContent: '', className: '', style: {}, src: '',
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    setAttribute: () => {}, removeAttribute: () => {}, appendChild: () => {},
    addEventListener: () => {}, onclick: null,
  })
  const document = {
    documentElement: { lang: '', classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {} } },
    head: { firstChild: null, insertBefore: () => {}, appendChild: () => {} },
    createElement: node,
    getElementById: node,
    querySelector: node,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
  }
  const Fremkit = {
    settings,
    locale: 'fr',
    compact: false,
    instanceId: 'spotify-1',
    whenReady: (cb: () => void) => cb(),
    subscribe: () => () => {},
    onLocale: () => {},
    onResize: () => {},
    onSettings: () => {},
    sendCommand: (channel: string, name: string, payload?: unknown) => {
      commands.push([channel, name, payload])
      return Promise.resolve({ ok: true })
    },
    t: (dict: unknown) => (typeof dict === 'string' ? dict : ((dict as Record<string, string>)?.fr ?? '')),
    esc: (v: unknown) => String(v ?? ''),
    color: (v: unknown, fallback: string) => fallback,
  }
  const window = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout }
  new Function('document', 'Fremkit', 'window', 'console', script)(document, Fremkit, window, console)
  return { listeners, commands, settings }
}

const fire = (loaded: Loaded, type: string, event: unknown = {}) =>
  (loaded.listeners.get(type) ?? []).forEach((fn) => fn(event))

describe('the spotify widget long press', () => {
  it('opens the application on a contextmenu, which is what a held press becomes', async () => {
    // The driver turns a press held past its threshold into rightMouseDown + rightMouseUp, so
    // the page never sees a held button — only this event.
    const loaded = await loadWidget({ longPressOpensApp: true })
    expect(loaded.listeners.has('contextmenu')).toBe(true)
    fire(loaded, 'contextmenu')
    expect(loaded.commands).toContainEqual(['spotify', 'activate', undefined])
  })

  it('does nothing at all while the setting is off', async () => {
    const loaded = await loadWidget({ longPressOpensApp: false })
    fire(loaded, 'contextmenu')
    expect(loaded.commands).toEqual([])
  })

  it('treats an absent setting as off', async () => {
    const loaded = await loadWidget({})
    fire(loaded, 'contextmenu')
    expect(loaded.commands).toEqual([])
  })

  it('keeps the timer path, and ignores a non-primary pointerdown', async () => {
    vi.useFakeTimers()
    try {
      const loaded = await loadWidget({ longPressOpensApp: true })
      // The right button is the driver's long press; starting a hold on it would only have that
      // hold cancelled by its own release.
      fire(loaded, 'pointerdown', { button: 2, clientX: 10, clientY: 10 })
      vi.advanceTimersByTime(2000)
      expect(loaded.commands).toEqual([])

      // A held left button — a real mouse, or the plain-Chrome kiosk path — still works.
      fire(loaded, 'pointerdown', { button: 0, clientX: 10, clientY: 10 })
      vi.advanceTimersByTime(2000)
      expect(loaded.commands).toContainEqual(['spotify', 'activate', undefined])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the timer when the finger travels', async () => {
    vi.useFakeTimers()
    try {
      const loaded = await loadWidget({ longPressOpensApp: true })
      fire(loaded, 'pointerdown', { button: 0, clientX: 10, clientY: 10 })
      fire(loaded, 'pointermove', { clientX: 200, clientY: 10 })
      vi.advanceTimersByTime(2000)
      expect(loaded.commands).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
