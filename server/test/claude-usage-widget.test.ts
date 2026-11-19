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
interface StubNode { innerHTML: string; textContent: string; hidden: boolean; classes: Set<string> }

interface Loaded {
  /** The elements the widget asked for by id, so a test can read what it put in them. */
  nodes: Map<string, StubNode>
  markup: string
  /** Hands the widget one answer from a channel, as the host delivers it. */
  publish(channel: string, data: Record<string, unknown>): void
}

async function loadWidget(settings: Record<string, unknown> = {}, opts: { compact?: boolean; h?: number } = {}): Promise<Loaded> {
  const html = await readFile(fileURLToPath(new URL('../../widgets/claude-usage/index.html', import.meta.url)), 'utf8')
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

  const subscribers = new Map<string, ((data: unknown) => void)[]>()
  const node = (): StubNode => {
    const classes = new Set<string>()
    return {
      innerHTML: '', textContent: '', hidden: false, classes,
      classList: {
        add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) },
        toggle: (c: string, on?: boolean) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c) },
      },
      style: { setProperty: () => {} },
    } as StubNode
  }
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
    compact: opts.compact ?? false,
    size: { h: opts.h ?? 4, px: { width: 640, height: 160 } },
    whenReady: (cb: () => void) => cb(),
    subscribe: (channel: string, cb: (data: unknown) => void) => {
      subscribers.set(channel, [...(subscribers.get(channel) ?? []), cb])
      return () => {}
    },
    settings,
    onSettings: () => () => {},
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
    nodes, markup: html,
    publish: (channel, data) => (subscribers.get(channel) ?? []).forEach((cb) => cb(data)),
  }
}

/** One account as the claude-account channel publishes it: windows reset an hour and a day from now. */
function row(name: string, five: number, seven: number) {
  const now = Math.floor(Date.now() / 1000)
  return {
    key: name.toLowerCase(), name, named: true, plan: 'Max', available: true, stale: false, updatedAt: Date.now(),
    fiveHour: { pct: five, resetsAt: now + 3600 }, sevenDay: { pct: seven, resetsAt: now + 86400 },
  } as Record<string, any>
}

const today = {
  messages: 12, input: 1000, output: 2000, cacheRead: 500, cacheWrite: 500,
  sessions: 2, costUsd: 1.25, hourly: new Array(24).fill(0),
}

describe('the claude-usage widget', () => {
  it('puts the day in its footer', async () => {
    const loaded = await loadWidget()
    loaded.publish('claude-usage', { fiveHour: { pct: 10, resetsAt: 0 }, sevenDay: { pct: 20, resetsAt: 0 }, today, updatedAt: Date.now() })
    expect(loaded.nodes.get('foot-text')?.innerHTML).toContain('aujourd’hui')
    expect(loaded.nodes.get('foot-text')?.innerHTML).toContain('4 k tokens')
    expect(loaded.nodes.get('foot-text')?.innerHTML).toContain('≈ 1,25 $')
  })

  it('leaves the cost out when Show cost is off', async () => {
    const loaded = await loadWidget({ showCost: false })
    loaded.publish('claude-usage', { fiveHour: { pct: 10, resetsAt: 0 }, sevenDay: { pct: 20, resetsAt: 0 }, today, updatedAt: Date.now() })
    expect(loaded.nodes.get('foot-text')?.innerHTML).toContain('4 k tokens')
    expect(loaded.nodes.get('foot-text')?.innerHTML).not.toContain('$')
  })

  it('escapes the account names, since the user typed them', async () => {
    const loaded = await loadWidget()
    loaded.publish('claude-account', { source: 'account', accounts: [row('<img src=x>', 10, 20), row('Personal', 30, 40)] })
    expect(loaded.nodes.get('rows')?.innerHTML).toContain('&lt;img src=x&gt;')
    expect(loaded.nodes.get('rows')?.innerHTML).not.toContain('<img')
  })

  it('says in words why one account\'s gauges are old, and when they were read', async () => {
    const loaded = await loadWidget()
    const last = { ...row('Max', 40, 50), named: false, stale: true, updatedAt: new Date().setHours(9, 5, 0, 0) }
    loaded.publish('claude-account', { source: 'account', accounts: [{ ...last, error: 'unauthorized' }] })
    expect(loaded.nodes.get('note')?.textContent).toContain('lu à 09:05')
    expect(loaded.nodes.get('note')?.textContent).toContain('connexion refusée')
    loaded.publish('claude-account', { source: 'account', accounts: [{ ...last, error: 'http-500' }] })
    expect(loaded.nodes.get('note')?.textContent).toContain('http-500')
    loaded.publish('claude-account', { source: 'account', accounts: [{ ...last, error: 'constructor' }] })
    expect(loaded.nodes.get('note')?.textContent).toContain('constructor')
  })

  it('draws one row per account, each with its own 5-hour and 7-day numbers', async () => {
    const loaded = await loadWidget()
    loaded.publish('claude-account', { source: 'account', accounts: [row('Work', 12, 34), row('Personal', 91, 47)] })
    const rows = loaded.nodes.get('rows')!
    expect(rows.hidden).toBe(false)
    expect(loaded.nodes.get('gauges')?.hidden).toBe(true)
    const [work, personal] = rows.innerHTML.split('<div class="acct').slice(1)
    expect(work).toContain('Work'); expect(work).toContain('12%'); expect(work).toContain('34%')
    expect(personal).toContain('Personal'); expect(personal).toContain('91%'); expect(personal).toContain('47%')
    // The plan beside the user's name, and no per-model line any more.
    expect(work).toContain('Max')
    expect(loaded.nodes.get('foot-text')?.innerHTML ?? '').not.toContain('Opus')
  })

  it('dims a stale row with its reason and draws a window whose reset has passed as reset', async () => {
    const loaded = await loadWidget()
    const old: Record<string, any> = { ...row('Personal', 70, 47), stale: true, error: 'expired', updatedAt: Date.now() - 3 * 3_600_000 }
    old.fiveHour = { pct: 70, resetsAt: Math.floor(Date.now() / 1000) - 60 }
    loaded.publish('claude-account', { source: 'account', accounts: [row('Work', 12, 34), old] })
    const personal = loaded.nodes.get('rows')!.innerHTML.split('<div class="acct').slice(1)[1]
    expect(personal.startsWith(' stale')).toBe(true)
    expect(personal).toContain('aucune session en cours sur ce compte')
    expect(personal).toContain('0%')
    expect(personal).not.toContain('70%')
    expect(personal).toContain('47%')
  })

  it('shows the two most loaded accounts in the bar, in their own order', async () => {
    const loaded = await loadWidget({}, { compact: true })
    loaded.publish('claude-account', { source: 'account', accounts: [row('Alpha', 90, 10), row('Beta', 5, 5), row('Gamma', 20, 70)] })
    const bar = loaded.nodes.get('cwrap')!
    expect(bar.classes.has('stack')).toBe(true)
    expect(bar.innerHTML).toContain('Alpha')
    expect(bar.innerHTML).toContain('Gamma')
    expect(bar.innerHTML).not.toContain('Beta')
    expect(bar.innerHTML.indexOf('Alpha')).toBeLessThan(bar.innerHTML.indexOf('Gamma'))
    // One account: the one line it always was.
    loaded.publish('claude-account', { source: 'account', accounts: [row('Alpha', 90, 10)] })
    expect(bar.classes.has('stack')).toBe(false)
    expect(bar.innerHTML).toContain('Claude')
  })

  it('draws the histogram that follows the footer, where it fits', async () => {
    const loaded = await loadWidget({}, { h: 5 })
    loaded.publish('claude-usage', { fiveHour: null, sevenDay: null, today: { ...today, hourly: new Array(24).fill(1) }, updatedAt: Date.now() })
    expect(loaded.nodes.get('histrow')?.hidden).toBe(false)
    expect(loaded.nodes.get('hist')?.innerHTML).toContain('height:100%')
  })
})

describe('Claude plan in its usage widget', () => {
  it('names a single account by its plan, as it always did, or by the user\'s name', async () => {
    const widget = await loadWidget()
    widget.publish('claude-account', { source: 'account', accounts: [{ ...row('Max', 10, 20), named: false }] })
    expect(widget.nodes.get('plan')?.textContent).toBe('Claude Max')
    expect(widget.nodes.get('plan')?.hidden).toBe(false)
    expect(widget.markup).toMatch(/<div class=\"foot\"[^>]*><span class=\"plan\"[^>]*id=\"plan\"/)
    widget.publish('claude-account', { source: 'account', accounts: [row('Work', 10, 20)] })
    expect(widget.nodes.get('plan')?.textContent).toBe('Work · Max')
  })
  it('says the account usage is off, and still shows the status line\'s numbers', async () => {
    const widget = await loadWidget()
    widget.publish('claude-account', { source: 'status-line', error: 'disabled', accounts: [{ ...row('Max', 33, 44), named: false }] })
    expect(widget.nodes.get('note')?.textContent).toContain('désactivée')
    expect(widget.nodes.get('gauges')?.innerHTML).toContain('33%')
  })
})
