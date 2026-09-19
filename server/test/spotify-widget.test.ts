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
interface StubNode {
  textContent: string; className: string; title: string; onclick: (() => void) | null
  style: Record<string, string> & { setProperty(name: string, value: string): void }
  childNodes: StubNode[]
}

interface Loaded {
  listeners: Map<string, ((e: unknown) => void)[]>
  commands: [string, string, unknown?][]
  settings: Record<string, unknown>
  /** The elements the widget asked for by id, so a test can read what it put in them. */
  nodes: Map<string, StubNode>
  /** Hands the widget one answer from the spotify channel, as the host delivers it. */
  publish(data: Record<string, unknown>): void
}

async function loadWidget(settings: Record<string, unknown>, viewport: [number, number] = [632, 282]): Promise<Loaded> {
  const html = await readFile(fileURLToPath(new URL('../../widgets/spotify/index.html', import.meta.url)), 'utf8')
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

  const listeners = new Map<string, ((e: unknown) => void)[]>()
  const commands: [string, string, unknown?][] = []
  const subscribers: ((data: unknown) => void)[] = []
  const node = () => {
    const self = {
      textContent: '', className: '', title: '', src: '',
      style: { setProperty(name: string, value: string) { (this as Record<string, unknown>)[name] = value } } as StubNode['style'],
      clientWidth: viewport[0] - 36,
      childNodes: [] as StubNode[],
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      setAttribute: () => {}, removeAttribute: () => {},
      appendChild: (child: StubNode) => { self.childNodes.push(child) },
      addEventListener: () => {}, onclick: null,
    }
    return self
  }
  // By id, and the same object every time: `textContent = ''` on a fresh stub would erase nothing.
  const nodes = new Map<string, ReturnType<typeof node>>()
  const byId = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, node())
    return nodes.get(id)!
  }
  const document = {
    documentElement: { lang: '', classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {} } },
    head: { firstChild: null, insertBefore: () => {}, appendChild: () => {} },
    createElement: node,
    getElementById: byId,
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
    subscribe: (_channel: string, cb: (data: unknown) => void) => { subscribers.push(cb); return () => {} },
    onLocale: () => {},
    onResize: () => {},
    onSettings: () => {},
    sendCommand: (channel: string, name: string, payload?: unknown) => {
      commands.push([channel, name, payload])
      return Promise.resolve({ ok: true })
    },
    el: (_tag: string, className: string, text?: unknown) => {
      const n = node()
      n.className = className ?? ''
      n.textContent = String(text ?? '')
      return n
    },
    t: (dict: unknown) => (typeof dict === 'string' ? dict : ((dict as Record<string, string>)?.fr ?? '')),
    esc: (v: unknown) => String(v ?? ''),
    color: (v: unknown, fallback: string) => fallback,
  }
  const window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout,
    innerWidth: viewport[0], innerHeight: viewport[1],
  }
  new Function('document', 'Fremkit', 'window', 'console', script)(document, Fremkit, window, console)
  return {
    listeners, commands, settings,
    nodes: nodes as unknown as Map<string, StubNode>,
    publish: (data: Record<string, unknown>) => subscribers.forEach((cb) => cb(data)),
  }
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

/**
 * The progress bar. The position arrives once a second, so a bar that only moved when an answer
 * landed stepped once a second — visibly. It is aimed a second ahead and given a second to get
 * there instead, and each answer corrects the aim. What must not glide is a seek or a new track:
 * running the fill backwards across a second reads as a bug, not as an animation.
 */
describe('the spotify widget progress bar', () => {
  const playing = (positionMs: number, extra: Record<string, unknown> = {}) => ({
    available: true, state: 'playing', title: 'Song', artist: 'Artist', album: 'Album',
    durationMs: 200_000, positionMs, ...extra,
  })
  const scale = (loaded: Loaded) =>
    Number(/scaleX\(([\d.]+)\)/.exec(loaded.nodes.get('bar')!.style.transform ?? '')?.[1])

  it('aims one poll ahead while the track plays', async () => {
    const loaded = await loadWidget({})
    loaded.publish(playing(100_000))
    // 100 s of 200 s, plus the second it will have played by the next answer.
    expect(scale(loaded)).toBeCloseTo(0.505, 5)
  })

  it('stops at where it is when the track is paused', async () => {
    const loaded = await loadWidget({})
    loaded.publish(playing(100_000, { state: 'paused' }))
    expect(scale(loaded)).toBeCloseTo(0.5, 5)
  })

  it('never aims past the end of the track', async () => {
    const loaded = await loadWidget({})
    loaded.publish(playing(199_800))
    expect(scale(loaded)).toBe(1)
  })

  it('snaps rather than glides when the track changes', async () => {
    const loaded = await loadWidget({})
    loaded.publish(playing(180_000))
    loaded.publish(playing(1_000, { title: 'Another' }))
    // The snap class is put on and taken off within the call; what it leaves is the new aim.
    expect(loaded.nodes.get('bar')!.className).toBe('')
    expect(scale(loaded)).toBeCloseTo(0.01, 5)
  })

  it('snaps on a seek backwards, and glides on one forwards', async () => {
    const loaded = await loadWidget({})
    loaded.publish(playing(100_000))
    loaded.publish(playing(20_000))
    expect(scale(loaded)).toBeCloseTo(0.105, 5)
  })

  it('draws an empty bar for a track with no duration at all', async () => {
    const loaded = await loadWidget({})
    loaded.publish(playing(0, { durationMs: 0 }))
    expect(scale(loaded)).toBe(0)
  })
})
