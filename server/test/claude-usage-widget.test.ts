import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * The Claude limits widget drawn for real.
 *
 * The widget is a plain browser script in an HTML file, so it is evaluated here against stubs and
 * then handed one answer per channel, exactly as the host delivers them. A render that throws
 * leaves the nodes it had not reached yet empty, which is what this watches: the footer and the
 * histogram sit at the end of `render()`, after everything a reader actually notices.
 */
interface StubNode { innerHTML: string; textContent: string; hidden: boolean }

interface Loaded {
  /** The elements the widget asked for by id, so a test can read what it put in them. */
  nodes: Map<string, StubNode>
  /** Hands the widget one answer from a channel, as the host delivers it. */
  publish(channel: string, data: Record<string, unknown>): void
}

async function loadWidget(): Promise<Loaded> {
  const html = await readFile(fileURLToPath(new URL('../../widgets/claude-usage/index.html', import.meta.url)), 'utf8')
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

  const subscribers = new Map<string, ((data: unknown) => void)[]>()
  const node = (): StubNode => ({
    innerHTML: '', textContent: '', hidden: false,
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    style: { setProperty: () => {} },
  } as StubNode)
  // By id, and the same object every time: a fresh stub per call would forget every write.
  const nodes = new Map<string, StubNode>()
  const byId = (id: string): StubNode => {
    if (!nodes.has(id)) nodes.set(id, node())
    return nodes.get(id)!
  }
  const document = {
    documentElement: { lang: '', style: { setProperty: () => {} } },
    getElementById: byId,
  }
  const Fremkit = {
    locale: 'fr',
    compact: false,
    size: { h: 4, px: { width: 640, height: 160 } },
    whenReady: (cb: () => void) => cb(),
    subscribe: (channel: string, cb: (data: unknown) => void) => {
      subscribers.set(channel, [...(subscribers.get(channel) ?? []), cb])
      return () => {}
    },
    onLocale: () => {},
    onResize: () => {},
    t: (dict: Record<string, string>, params?: Record<string, unknown>) =>
      Object.entries(params ?? {}).reduce((text, [k, v]) => text.replace('{' + k + '}', String(v)), dict.fr),
    // The bridge's own helper, which is what the widget must reach it through: it is passed by
    // reference to `map`, so it may not lean on `this`.
    esc: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c),
  }
  // The widget redraws itself every second for the countdowns; a test wants the renders it asks for.
  new Function('document', 'Fremkit', 'setInterval', script)(document, Fremkit, () => 0)
  return {
    nodes,
    publish: (channel, data) => (subscribers.get(channel) ?? []).forEach((cb) => cb(data)),
  }
}

const today = {
  messages: 12, input: 1000, output: 2000, cacheRead: 500, cacheWrite: 500,
  sessions: 2, costUsd: 1.25, hourly: new Array(24).fill(0),
}

describe('the claude-usage widget', () => {
  it('puts the day in its footer', async () => {
    const loaded = await loadWidget()
    loaded.publish('claude-usage', { fiveHour: { pct: 10, resetsAt: 0 }, sevenDay: { pct: 20, resetsAt: 0 }, today, updatedAt: Date.now() })
    expect(loaded.nodes.get('foot')?.innerHTML).toContain('aujourd’hui')
    expect(loaded.nodes.get('foot')?.innerHTML).toContain('4 k tokens')
  })

  it('escapes what the account names, since a limit name is not ours', async () => {
    const loaded = await loadWidget()
    loaded.publish('claude-account', {
      available: true, stale: false,
      limits: [{ name: 'Opus', percent: 40, resetsAt: 0 }],
      breakdown: [{ name: '<img src=x>', percent: 30 }],
    })
    expect(loaded.nodes.get('foot')?.innerHTML).toContain('&lt;img src=x&gt;')
  })

  it('draws the histogram that follows the footer', async () => {
    const loaded = await loadWidget()
    loaded.publish('claude-usage', { fiveHour: null, sevenDay: null, today: { ...today, hourly: new Array(24).fill(1) }, updatedAt: Date.now() })
    expect(loaded.nodes.get('histrow')?.hidden).toBe(false)
    expect(loaded.nodes.get('hist')?.innerHTML).toContain('height:100%')
  })
})
