import { clip, METHODS, methodOf } from './devlog.js'

// One dev tab's state as a pure reducer, and the rows `dev.tabs` carries. The wire shape mirrors
// DevTabSchema in server/src/companion/protocol.ts, which is strict.

const MAX_TABS = 32
const MAX_APP = 120
const MAX_TEXT = 300
const MAX_COUNT = 1_000_000
/** The server refuses a message over 65_536 bytes; stay clear of it (multibyte text is wider). */
const MAX_BYTES = 60_000
/** The entries a tab's history keeps, newest first. */
export const HISTORY_MAX = 20
/** The highest entry id; the next one is 1 again. */
const MAX_ID = 2_147_483_647
/** The dev servers told apart (DEV_SERVERS on the server). */
export const DEV_SERVERS = ['vite', 'next', 'webpack']
const BASE_RE = /^\/[A-Za-z0-9._~\-/]{0,99}$/

/**
 * Whether `base` may be the dev server's base path: a bounded absolute path ending in `/`, with no
 * empty or dot segment (`//evil/` would read as another host once joined to an origin), and `/`
 * for anything but Vite, the only one whose base the page tells.
 */
export function validBase(base, server) {
  if (typeof base !== 'string' || !BASE_RE.test(base) || !base.endsWith('/')) return false
  if (base.includes('//') || base.split('/').some((seg) => seg === '.' || seg === '..')) return false
  return server === 'vite' || base === '/'
}

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
    history: [],
    /** The id the next history entry gets. */
    nextId: 1,
    /**
     * The dev server's kind and, for Vite, its base path (`validBase`: no empty or dot segment): the
     * latest told, kept across same-origin navigations, reset by a cross-origin one.
     */
    devServer: null,
    serverBase: '/',
    server: 'up',
    activity: now,
  }
}

// The history ring: errors, failed requests and the relay's overflow (`limited`), newest first, an
// entry repeated back to back folded into its `n`. Entries keep their stack here; the wire drops it.
// state: `open` until the user marks it seen (`clear`), `resolved` once the page reloads or updates.

const sameEntry = (a, b) =>
  a.kind === b.kind &&
  (a.kind === 'error'
    ? a.text === b.text && a.origin === b.origin
    : a.kind === 'request'
      ? a.method === b.method && a.path === b.path && a.status === b.status
      : true)

const isId = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_ID

/**
 * `{ history, nextId }` after `entry` (n 1 or more, open): put on top of the ring with the tab's
 * `nextId`, the next one counting on (1 again after MAX_ID), or folded into the newest entry, whose
 * id it keeps, when it is the same and open.
 */
function record(tab, entry) {
  const ring = tab.history ?? []
  const top = ring[0]
  if (top && top.state === 'open' && sameEntry(top, entry)) {
    const merged = { ...top, n: Math.min(MAX_COUNT, top.n + entry.n), at: entry.at }
    if (entry.kind === 'error') merged.stack = entry.stack
    return { history: [merged, ...ring.slice(1)], nextId: tab.nextId }
  }
  const id = isId(tab.nextId) ? tab.nextId : 1
  return { history: [{ ...entry, id }, ...ring].slice(0, HISTORY_MAX), nextId: id === MAX_ID ? 1 : id + 1 }
}
const restate = (history, from, to) => (history ?? []).map((e) => (from.includes(e.state) ? { ...e, state: to } : e))

const bump = (t, last) => ({
  total: Math.min(MAX_COUNT, t.total + 1),
  open: Math.min(MAX_COUNT, t.open + 1),
  seen: t.seen ?? 0,
  last,
})
const resolved = (t) => ({ ...t, open: 0, seen: 0 })
/** Marked seen: still open, no longer new. */
const seenAll = (t) => ({ ...t, seen: t.open })

/** The next state of a tab after an event. Every event but `title` and `devserver` stamps `activity`. */
export function reduce(tab, event, now) {
  switch (event.kind) {
    case 'error':
      return {
        ...tab,
        errors: bump(tab.errors, { text: event.text, at: now }),
        ...record(tab, {
          kind: 'error',
          text: event.text,
          origin: typeof event.origin === 'string' ? event.origin : null,
          stack: Array.isArray(event.stack) ? event.stack : null,
          n: 1,
          at: now,
          state: 'open',
        }),
        activity: now,
      }
    case 'request':
      return {
        ...tab,
        requests: bump(tab.requests, { path: event.path, status: event.status, at: now }),
        ...record(tab, {
          kind: 'request',
          method: methodOf(event.method),
          path: event.path,
          status: event.status,
          n: 1,
          at: now,
          state: 'open',
        }),
        activity: now,
      }
    case 'navigated': {
      // The entry ids keep counting either way. The dev server's kind belongs to the origin: a
      // reload or a pushState route change keeps it, another origin forgets it and looks again.
      const next = { ...tab, url: event.url, host: hostOf(event.url), title: event.title ?? '', activity: now }
      if (originOf(event.url) !== originOf(tab.url)) {
        return { ...next, errors: tally(), requests: tally(), history: [], server: 'up', devServer: null, serverBase: '/' }
      }
      return { ...next, errors: resolved(tab.errors), requests: resolved(tab.requests), history: restate(tab.history, ['open', 'seen'], 'resolved') }
    }
    case 'hot':
      return {
        ...tab,
        errors: resolved(tab.errors),
        requests: resolved(tab.requests),
        history: restate(tab.history, ['open', 'seen'], 'resolved'),
        activity: now,
      }
    case 'server':
      return { ...tab, server: event.state === 'down' ? 'down' : 'up', activity: now }
    case 'title':
      return { ...tab, title: event.title ?? '' }
    case 'devserver':
      // kind.js tells it once per document: a fresh load detects again and may replace it (Next
      // now listening where Vite did); a pushState route change runs no kind.js and keeps it.
      if (!DEV_SERVERS.includes(event.server) || !validBase(event.base, event.server)) return tab
      return { ...tab, devServer: event.server, serverBase: event.base }
    case 'count': {
      // Errors the relay counted over its rate limit: they add up, the last text stays.
      const n = count(event.n)
      if (n === 0) return tab
      const e = tab.errors
      const add = (v) => Math.min(MAX_COUNT, v + n)
      return {
        ...tab,
        errors: { total: add(e.total), open: add(e.open), seen: e.seen ?? 0, last: e.last },
        ...record(tab, { kind: 'limited', n, at: now, state: 'open' }),
        activity: now,
      }
    }
    case 'clear':
      // The user has seen them: they stay open, and the light dims until a new one or a reload.
      return {
        ...tab,
        errors: seenAll(tab.errors),
        requests: seenAll(tab.requests),
        history: restate(tab.history, ['open'], 'seen'),
        activity: now,
      }
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

const STATES = ['open', 'seen', 'resolved']
const statusOf = (s) => Math.max(0, Math.min(599, Math.trunc(s) || 0))

/**
 * The rows as chrome.storage.session keeps them: every entry's stack dropped. Stacks stay in the
 * worker's memory, for a report; the session copy is rewritten up to twice a second and only has to
 * bring the rows back after the worker was stopped, at which point a report simply has no stacks
 * for what came before.
 */
export function sessionTabs(tabs) {
  const out = {}
  for (const [id, tab] of Object.entries(tabs)) {
    out[id] = Array.isArray(tab.history)
      ? { ...tab, history: tab.history.map((e) => (e.kind === 'error' && e.stack !== null ? { ...e, stack: null } : e)) }
      : tab
  }
  return out
}

/** One history entry as `dev.tabs` carries it: bounded, and never its stack. Null for what cannot travel. */
function wireEntry(e) {
  const common = { n: count(e?.n), at: Math.max(0, e?.at), state: e?.state }
  if (!isId(e?.id) || common.n < 1 || !Number.isFinite(common.at) || !STATES.includes(common.state)) return null
  const id = e.id
  switch (e.kind) {
    case 'error':
      return {
        kind: 'error',
        id,
        text: clip(String(e.text ?? ''), MAX_TEXT),
        origin: typeof e.origin === 'string' ? clip(e.origin, MAX_TEXT) : null,
        ...common,
      }
    case 'request':
      return { kind: 'request', id, method: methodOf(e.method), path: pathOnly(e.path), status: statusOf(e.status), ...common }
    case 'limited':
      return { kind: 'limited', id, ...common }
    default:
      return null
  }
}

function wireRow(t) {
  return {
    tabId: t.tabId,
    app: clip(String(t.title || t.host), MAX_APP),
    host: t.host,
    errors: wireTally(t.errors, (l) => ({ text: clip(String(l.text ?? ''), MAX_TEXT), at: Math.max(0, l.at) })),
    requests: wireTally(t.requests, (l) => ({
      path: pathOnly(l.path),
      status: statusOf(l.status),
      at: Math.max(0, l.at),
    })),
    history: (Array.isArray(t.history) ? t.history : []).slice(0, HISTORY_MAX).map(wireEntry).filter(Boolean),
    // The kind alone: the base path is for the extension's own use and never leaves it.
    devServer: DEV_SERVERS.includes(t.devServer) ? t.devServer : null,
    server: t.server,
    activity: Math.max(0, t.activity),
  }
}

const MAX_TAB_ID = MAX_ID
/** DevTabSchema's host: host:port as the URL gives it, `_` included. */
const HOST_RE = /^[a-z0-9._\-[\]:]{1,260}$/i
const PATH_RE = /^\/[^?#]*$/
const isStamp = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_COUNT
const isText = (v, max) => typeof v === 'string' && v.length <= max
const okTally = (t, last) =>
  isCount(t?.total) && isCount(t?.open) && isCount(t?.seen) && t.seen <= t.open && t.open <= t.total &&
  (t.last === null || last(t.last))

const okEntry = (e) => {
  if (!e || typeof e !== 'object' || !isId(e.id) || !Number.isInteger(e.n) || e.n < 1 || e.n > MAX_COUNT || !isStamp(e.at) || !STATES.includes(e.state)) {
    return false
  }
  const keys = Object.keys(e).sort().join()
  switch (e.kind) {
    case 'error':
      return keys === 'at,id,kind,n,origin,state,text' && isText(e.text, MAX_TEXT) && (e.origin === null || isText(e.origin, MAX_TEXT))
    case 'request':
      return keys === 'at,id,kind,method,n,path,state,status' && (METHODS.includes(e.method) || e.method === 'OTHER') &&
        isText(e.path, MAX_TEXT) && PATH_RE.test(e.path) && Number.isInteger(e.status) && e.status >= 0 && e.status <= 599
    case 'limited':
      return keys === 'at,id,kind,n,state'
    default:
      return false
  }
}

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
    Array.isArray(r.history) && r.history.length <= HISTORY_MAX && r.history.every(okEntry) &&
    (r.devServer === null || DEV_SERVERS.includes(r.devServer)) &&
    (r.server === 'up' || r.server === 'down') &&
    isStamp(r.activity)
  )
}

const encoder = new TextEncoder()
const sizeOf = (v) => encoder.encode(JSON.stringify(v)).length
const bytes = (rows) => sizeOf({ type: 'dev.tabs', tabs: rows })

/**
 * Green as the widget paints it (`lightOf` in widgets/fremdev/logic.js): nothing open, seen or not,
 * and the dev server up. Its history is the first to go when the message is too big.
 */
const isGreen = (r) => r.errors.open === 0 && r.requests.open === 0 && r.server === 'up'

/**
 * Takes history entries off `rows` (oldest first) until the message fits, green rows' first. The
 * size is kept by arithmetic, not re-encoded per entry: an entry's JSON, and the comma before it.
 */
function trimHistory(rows, size) {
  const drop = (r) => {
    const e = r.history.pop()
    size -= sizeOf(e) + (r.history.length > 0 ? 1 : 0)
  }
  for (const pass of [rows.filter(isGreen), rows.filter((r) => !isGreen(r))]) {
    while (size > MAX_BYTES) {
      let oldest = null
      for (const r of pass) {
        const last = r.history.at(-1)
        if (last && (oldest === null || last.at < oldest.history.at(-1).at)) oldest = r
      }
      if (oldest === null) break
      drop(oldest)
    }
  }
}

/**
 * The rows for `dev.tabs`: the 32 latest, latest first. To fit the size cap, history goes first
 * (`trimHistory`), then the oldest rows. A row outside the server's bounds (`validRow`) is left out.
 */
export function wireTabs(tabs) {
  const rows = [...tabs]
    .sort((a, b) => b.activity - a.activity)
    .map(wireRow)
    .filter(validRow)
    .slice(0, MAX_TABS)
  trimHistory(rows, bytes(rows))
  while (rows.length > 0 && bytes(rows) > MAX_BYTES) rows.pop()
  return rows
}

const isFrames = (v) => v === null || v === undefined || (Array.isArray(v) && v.every((f) => typeof f === 'string'))

/**
 * The rows read back from chrome.storage.session, keeping only well-formed tabs: keyed by their own
 * id, with the fields this file reads, whose wire row the server would take and whose every history
 * entry travels as it is. Anything else (an older build's shape, a corrupted value) is dropped
 * rather than left to throw in `reduce` or `wireTabs` later.
 */
export function restoredTabs(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, t] of Object.entries(raw)) {
    try {
      if (!t || typeof t !== 'object' || !Number.isInteger(t.tabId) || String(t.tabId) !== key) continue
      if (typeof t.url !== 'string' || typeof t.host !== 'string' || typeof t.title !== 'string') continue
      if ((t.server !== 'up' && t.server !== 'down') || !Array.isArray(t.history) || t.history.length > HISTORY_MAX) continue
      if (!t.history.every((e) => wireEntry(e) !== null && (e.kind !== 'error' || isFrames(e.stack)))) continue
      // An id at or above the next one would come round again while its entry is still listed.
      if (!isId(t.nextId) || !t.history.every((e) => e.id < t.nextId)) continue
      if (!(t.devServer === null || DEV_SERVERS.includes(t.devServer))) continue
      if (!validBase(t.serverBase, t.devServer)) continue
      if (!validRow(wireRow(t))) continue
      out[key] = t
    } catch {
      // a shape wireRow cannot read: dropped
    }
  }
  return out
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
