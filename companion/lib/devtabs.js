import { clip } from './devlog.js'

// One dev tab's state as a pure reducer, and the rows `dev.tabs` carries. The wire shape mirrors
// DevTabSchema in server/src/companion/protocol.ts, which is strict.

const MAX_TABS = 32
const MAX_APP = 120
const MAX_TEXT = 300
const MAX_COUNT = 1_000_000
/** The server refuses a message over 65_536 bytes; stay clear of it (multibyte text is wider). */
const MAX_BYTES = 60_000

/** `seen`: the open ones the user marked seen on the Edge (×); 0 <= seen <= open <= total. */
const tally = () => ({ total: 0, open: 0, seen: 0, last: null })

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase() || 'unknown'
  } catch {
    return 'unknown'
  }
}
const originOf = (url) => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

export function emptyTab(tabId, url, title, now) {
  return {
    tabId,
    url,
    host: hostOf(url),
    title: title ?? '',
    errors: tally(),
    requests: tally(),
    server: 'up',
    activity: now,
  }
}

const bump = (t, last) => ({
  total: Math.min(MAX_COUNT, t.total + 1),
  open: Math.min(MAX_COUNT, t.open + 1),
  seen: t.seen ?? 0,
  last,
})
const resolved = (t) => ({ ...t, open: 0, seen: 0 })
/** Marked seen: still open, no longer new. */
const seenAll = (t) => ({ ...t, seen: t.open })

/** The next state of a tab after an event. Every event but `title` stamps `activity`. */
export function reduce(tab, event, now) {
  switch (event.kind) {
    case 'error':
      return { ...tab, errors: bump(tab.errors, { text: event.text, at: now }), activity: now }
    case 'request':
      return {
        ...tab,
        requests: bump(tab.requests, { path: event.path, status: event.status, at: now }),
        activity: now,
      }
    case 'navigated': {
      const next = { ...tab, url: event.url, host: hostOf(event.url), title: event.title ?? '', activity: now }
      if (originOf(event.url) !== originOf(tab.url)) {
        return { ...next, errors: tally(), requests: tally(), server: 'up' }
      }
      return { ...next, errors: resolved(tab.errors), requests: resolved(tab.requests) }
    }
    case 'hot':
      return { ...tab, errors: resolved(tab.errors), requests: resolved(tab.requests), activity: now }
    case 'server':
      return { ...tab, server: event.state === 'down' ? 'down' : 'up', activity: now }
    case 'title':
      return { ...tab, title: event.title ?? '' }
    case 'count': {
      // Errors the relay counted over its rate limit: they add up, the last text stays.
      const n = count(event.n)
      if (n === 0) return tab
      const e = tab.errors
      const add = (v) => Math.min(MAX_COUNT, v + n)
      return { ...tab, errors: { total: add(e.total), open: add(e.open), seen: e.seen ?? 0, last: e.last }, activity: now }
    }
    case 'clear':
      // The user has seen them: they stay open, and the light dims until a new one or a reload.
      return { ...tab, errors: seenAll(tab.errors), requests: seenAll(tab.requests), activity: now }
    default:
      return tab
  }
}

const count = (n) => Math.max(0, Math.min(MAX_COUNT, Math.trunc(Number.isFinite(n) ? n : 0)))
const pathOnly = (p) => {
  const bare = String(p ?? '').split(/[?#]/)[0]
  return clip(bare.startsWith('/') ? bare : `/${bare}`, MAX_TEXT)
}

function wireTally(t, shape) {
  const total = count(t.total)
  const open = Math.min(total, count(t.open))
  return { total, open, seen: Math.min(open, count(t.seen)), last: t.last ? shape(t.last) : null }
}

function wireRow(t) {
  return {
    tabId: t.tabId,
    app: clip(String(t.title || t.host), MAX_APP),
    host: t.host,
    errors: wireTally(t.errors, (l) => ({ text: clip(String(l.text ?? ''), MAX_TEXT), at: Math.max(0, l.at) })),
    requests: wireTally(t.requests, (l) => ({
      path: pathOnly(l.path),
      status: Math.max(0, Math.min(599, Math.trunc(l.status) || 0)),
      at: Math.max(0, l.at),
    })),
    server: t.server,
    activity: Math.max(0, t.activity),
  }
}

const MAX_TAB_ID = 2_147_483_647
/** DevTabSchema's host: host:port as the URL gives it, `_` included. */
const HOST_RE = /^[a-z0-9._\-[\]:]{1,260}$/i
const PATH_RE = /^\/[^?#]*$/
const isStamp = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_COUNT
const isText = (v, max) => typeof v === 'string' && v.length <= max
const okTally = (t, last) =>
  isCount(t?.total) && isCount(t?.open) && isCount(t?.seen) && t.seen <= t.open && t.open <= t.total &&
  (t.last === null || last(t.last))

/**
 * Whether a row stays inside DevTabSchema's bounds. The server drops a row it cannot read and keeps
 * the rest; this keeps such a row from leaving at all.
 */
export function validRow(r) {
  return (
    Number.isInteger(r?.tabId) && r.tabId >= 0 && r.tabId <= MAX_TAB_ID &&
    isText(r.app, MAX_APP) &&
    typeof r.host === 'string' && HOST_RE.test(r.host) &&
    okTally(r.errors, (l) => isText(l?.text, MAX_TEXT) && isStamp(l.at)) &&
    okTally(r.requests, (l) => isText(l?.path, MAX_TEXT) && PATH_RE.test(l.path) &&
      Number.isInteger(l.status) && l.status >= 0 && l.status <= 599 && isStamp(l.at)) &&
    (r.server === 'up' || r.server === 'down') &&
    isStamp(r.activity)
  )
}

const bytes = (rows) => new TextEncoder().encode(JSON.stringify({ type: 'dev.tabs', tabs: rows })).length

/**
 * The rows for `dev.tabs`: the 32 latest, latest first, trimmed (oldest first) to fit the size cap.
 * A row outside the server's bounds (`validRow`) is left out.
 */
export function wireTabs(tabs) {
  const rows = [...tabs]
    .sort((a, b) => b.activity - a.activity)
    .map(wireRow)
    .filter(validRow)
    .slice(0, MAX_TABS)
  while (rows.length > 0 && bytes(rows) > MAX_BYTES) rows.pop()
  return rows
}

/** Whether the server speaks Fremdev: Fremkit 0.5.0 says nothing, and gets no Fremdev message. */
export function fremdevSupport(ready) {
  const flag = ready?.modules?.fremdev
  if (typeof flag !== 'boolean') return 'unsupported'
  return flag ? 'yes' : 'disabled'
}

/** Runs the first call at once, then at most one more per `ms`: the last pushed. */
export class Throttle {
  constructor(ms = 500, now = Date.now, setTimer = setTimeout) {
    this.ms = ms
    this.now = now
    // Called bare, never as `this.setTimer(…)`: a browser's setTimeout refuses another `this`.
    this.setTimer = (fn, ms) => setTimer(fn, ms)
    this.lastRun = -Infinity
    this.pending = null
    this.armed = false
  }

  push(fn) {
    const wait = this.lastRun + this.ms - this.now()
    if (wait <= 0 && !this.armed) {
      this.lastRun = this.now()
      fn()
      return
    }
    this.pending = fn
    if (this.armed) return
    this.armed = true
    this.setTimer(() => {
      this.armed = false
      const run = this.pending
      this.pending = null
      this.lastRun = this.now()
      if (run) run()
    }, Math.max(0, wait))
  }
}
