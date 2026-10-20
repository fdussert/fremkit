import { MAX_IN_FLIGHT, SLOW_MS } from './devflight.js'
import { clip, homePath, METHODS, methodOf } from './devlog.js'
import { cleanPerf, isPerfValue, PERF_METRICS } from './devperf.js'

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
/** The slow entries a tab's history keeps at most: they never crowd out the faults. */
export const SLOW_MAX = 5
/** The highest entry id; the next one is 1 again. */
const MAX_ID = 2_147_483_647
/** The highest line or column a build entry carries. */
const MAX_POS = 10_000_000
/** A slow entry's duration: SLOW_MS (lib/devflight.js) to an hour. */
const MIN_SLOW_MS = SLOW_MS
const MAX_SLOW_MS = 3_600_000
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
    /** The requests started and not finished (lib/devflight.js counts them; the worker sets it). */
    inFlight: 0,
    /**
     * The current document's performance values (lib/devperf.js), `perfDoc` that document's id
     * (Chrome's `documentId`, never on the wire), `perfEntryId` the id of this load's `perf` entry.
     * A document's values stay across a same-origin navigation (a pushState route change keeps its
     * document); another document's first values replace them, another origin forgets them.
     */
    perf: {},
    perfDoc: null,
    perfEntryId: null,
    /** The document whose load was flagged (`perfDoc` then; null when none was told): flagged at most once. */
    perfFlaggedDoc: null,
    activity: now,
  }
}

// The history ring: errors, failed requests, the relay's overflow (`limited`), the dev server's
// compile errors (`build`), the requests that succeeded slowly (`slow`) and a load's performance
// regression (`perf`), newest first, an entry repeated back to back folded into its `n` (never a
// perf entry: a later regression of the same load replaces its values instead). A slow entry counts
// in no tally and never colours the light: it is information, not a fault. A perf entry counts in
// the requests tally, so it lights the row orange, never red.
// Entries keep their stack here; the wire drops it. A build entry keeps the file's full `path` here;
// the wire carries it as `file`, its home folder written `~/` (homePath).
// state: `open` until the user marks it seen (`clear`), `resolved` once the page reloads or updates
// (and, for a build entry, once the overlay goes or shows another error).

const sameEntry = (a, b) =>
  a.kind === b.kind &&
  (a.kind === 'error'
    ? a.text === b.text && a.origin === b.origin
    : a.kind === 'request'
      ? a.method === b.method && a.path === b.path && a.status === b.status
      : a.kind === 'build'
        ? a.text === b.text && a.path === b.path
        : a.kind === 'slow'
          ? a.method === b.method && a.path === b.path
          : a.kind !== 'perf')

const isId = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_ID

/**
 * `{ history, nextId, errors, requests }` after `entry` (n 1 or more, open): put on top of the ring
 * with the tab's `nextId`, the next one counting on (1 again after MAX_ID), or folded into the
 * newest entry, whose id it keeps, when it is the same and open. A full ring makes room with its
 * oldest slow entry, else its oldest resolved one, else its oldest. `errors` is the tab's, less the
 * open or seen build entries the ring pushed out: nothing could resolve them any more
 * (`build-clear` finds none), and the light would stay red. `requests` is the tab's, less the open
 * or seen perf entries it pushed out: the tally counts each one once, and a regression told again
 * for that load (`perf-regression`) counts again.
 */
function record(tab, entry) {
  const ring = tab.history ?? []
  const top = ring[0]
  if (top && top.state === 'open' && sameEntry(top, entry)) {
    const merged = { ...top, n: Math.min(MAX_COUNT, top.n + entry.n), at: entry.at }
    if (entry.kind === 'error') merged.stack = entry.stack
    return { history: [merged, ...ring.slice(1)], nextId: tab.nextId, errors: tab.errors, requests: tab.requests }
  }
  const id = isId(tab.nextId) ? tab.nextId : 1
  // Room for the new entry: the oldest slow entry goes first, then the oldest resolved one, and only
  // then the oldest of all, so slow entries never crowd out the faults.
  let kept = ring
  const out = []
  while (kept.length >= HISTORY_MAX) {
    let at = lastIndex(kept, (e) => e.kind === 'slow')
    if (at === -1) at = lastIndex(kept, (e) => e.state === 'resolved')
    if (at === -1) at = kept.length - 1
    out.push(kept[at])
    kept = kept.filter((_, i) => i !== at)
  }
  return {
    history: [{ ...entry, id }, ...kept],
    nextId: id === MAX_ID ? 1 : id + 1,
    errors: uncount(tab.errors, out.filter(isLive)),
    requests: uncount(tab.requests, out.filter(isLivePerf)),
  }
}
const restate = (history, from, to) => (history ?? []).map((e) => (from.includes(e.state) ? { ...e, state: to } : e))

const bump = (t, last) => ({
  total: Math.min(MAX_COUNT, t.total + 1),
  open: Math.min(MAX_COUNT, t.open + 1),
  seen: t.seen ?? 0,
  last,
})
const resolved = (t) => ({ ...t, open: 0, seen: 0 })

const isLive = (e) => e.kind === 'build' && (e.state === 'open' || e.state === 'seen')
const isLivePerf = (e) => e.kind === 'perf' && (e.state === 'open' || e.state === 'seen')
const isPos = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_POS

/**
 * A tally (errors or requests) less the open or seen entries `live` (the seen ones off `seen` too),
 * never below zero and `seen` never above `open`.
 */
function uncount(e, live) {
  if (live.length === 0) return e
  const open = Math.max(0, e.open - live.length)
  const seen = Math.min(open, Math.max(0, (e.seen ?? 0) - live.filter((x) => x.state === 'seen').length))
  return { ...e, open, seen }
}

/** `{ errors, history }` with every open or seen build entry resolved, and uncounted. */
function resolveBuilds(tab) {
  const ring = tab.history ?? []
  const live = ring.filter(isLive)
  if (live.length === 0) return { errors: tab.errors, history: ring }
  return {
    errors: uncount(tab.errors, live),
    history: ring.map((x) => (isLive(x) ? { ...x, state: 'resolved' } : x)),
  }
}
/** Marked seen: still open, no longer new. */
const seenAll = (t) => ({ ...t, seen: t.open })

/**
 * A slow request: folded into the newest open slow entry when it is the same method and path (it
 * takes the latest `ms`, keeps its id, and comes to the top so the ring stays newest first),
 * otherwise a new entry. The tallies and `activity` are left as they are, on eviction too: a new
 * slow entry never pushes a counted entry out (`addSlow`).
 */
function slowEntry(tab, event, now) {
  const method = methodOf(event.method)
  const path = typeof event.path === 'string' ? event.path : '/'
  const ms = Math.max(MIN_SLOW_MS, Math.min(MAX_SLOW_MS, Math.round(Number.isFinite(event.ms) ? event.ms : 0)))
  const ring = tab.history ?? []
  const newest = ring.find((e) => e.kind === 'slow' && e.state === 'open')
  if (newest && newest.method === method && newest.path === path) {
    const merged = { ...newest, ms, n: Math.min(MAX_COUNT, newest.n + 1), at: now }
    return { ...tab, history: [merged, ...ring.filter((e) => e !== newest)] }
  }
  return addSlow(tab, { kind: 'slow', method, path, ms, n: 1, at: now, state: 'open' })
}

/** The index of the last (oldest) entry of `ring` that `test` takes, or -1. */
const lastIndex = (ring, test) => {
  for (let i = ring.length - 1; i >= 0; i--) if (test(ring[i])) return i
  return -1
}

/**
 * A new slow entry on top of the ring. It needs a slot when the ring is full or already holds
 * SLOW_MAX slow entries: it takes the oldest slow entry's, else the oldest resolved entry's, else it
 * is dropped. An open or seen entry, which a tally counts or the light shows, never makes room for it.
 */
function addSlow(tab, entry) {
  let ring = tab.history ?? []
  const slowCount = ring.filter((e) => e.kind === 'slow').length
  if (ring.length >= HISTORY_MAX || slowCount >= SLOW_MAX) {
    let at = lastIndex(ring, (e) => e.kind === 'slow')
    if (at === -1 && slowCount < SLOW_MAX) at = lastIndex(ring, (e) => e.state === 'resolved')
    if (at === -1) return tab
    ring = ring.filter((_, i) => i !== at)
  }
  const id = isId(tab.nextId) ? tab.nextId : 1
  return { ...tab, history: [{ ...entry, id }, ...ring].slice(0, HISTORY_MAX), nextId: id === MAX_ID ? 1 : id + 1 }
}

/**
 * A document's performance values (`{ kind: 'perf', values, doc }`, the worker's checked event):
 * merged into the tab's when they are the same document's, replacing them for another document (a
 * reload), whose load has no perf entry yet. A measure, not an event: no activity stamped.
 */
function perfValuesOf(tab, event) {
  const values = cleanPerf(event.values)
  const doc = typeof event.doc === 'string' ? event.doc : null
  const same = doc === null || doc === (tab.perfDoc ?? null)
  if (same) return { ...tab, perf: { ...cleanPerf(tab.perf), ...values } }
  return { ...tab, perf: values, perfDoc: doc, perfEntryId: null }
}

/** A verdict's priority, 0 the strongest: LCP slower, load slower, LCP poor, CLS poor (lib/devperf.js). */
const verdictRank = (metric, ratio) => (ratio !== null ? (metric === 'lcp' ? 0 : 1) : metric === 'lcp' ? 2 : 3)

/**
 * A load's regression (`{ kind: 'perf-regression', metric, value, ratio }`, from lib/devperf.js's
 * verdict): at most one entry and one tally bump per document. While this load's entry is in the
 * ring and open or seen, a verdict of equal or higher priority takes its metric, value and ratio (a
 * weaker one is ignored: a poor CLS never hides an LCP twice as slow). Once the document was flagged,
 * it is not flagged again, whether its entry resolved (a route change, a hot update) or left the
 * ring (un-counted then). Otherwise a new open entry, counted in the requests tally with
 * `requests.last` left as it is.
 */
function perfRegression(tab, event, now) {
  if (!PERF_METRICS.includes(event.metric) || !isPerfValue(event.metric, event.value)) return tab
  const ratio = isRatio(event.ratio) ? event.ratio : null
  const ring = tab.history ?? []
  const current = isId(tab.perfEntryId) ? ring.find((e) => e.kind === 'perf' && e.id === tab.perfEntryId) : undefined
  if (current && current.state !== 'resolved') {
    if (verdictRank(event.metric, ratio) > verdictRank(current.metric, current.ratio)) return tab
    // The same verdict told again (perf.js re-sends its values as the heap moves): no change at all.
    if (event.metric === current.metric && event.value === current.value && ratio === current.ratio) return tab
    const next = { ...current, metric: event.metric, value: event.value, ratio }
    return { ...tab, history: ring.map((e) => (e === current ? next : e)) }
  }
  // Without a documentId (none told) no page can be told from the next: no once-per-document guard.
  const doc = typeof tab.perfDoc === 'string' ? tab.perfDoc : null
  if (doc !== null && tab.perfFlaggedDoc === doc) return tab
  const r = tab.requests
  const requests = { total: Math.min(MAX_COUNT, r.total + 1), open: Math.min(MAX_COUNT, r.open + 1), seen: r.seen ?? 0, last: r.last }
  const id = isId(tab.nextId) ? tab.nextId : 1
  return {
    ...tab,
    ...record({ ...tab, requests }, { kind: 'perf', metric: event.metric, value: event.value, ratio, n: 1, at: now, state: 'open' }),
    perfEntryId: id,
    perfFlaggedDoc: doc,
    activity: now,
  }
}

/**
 * The next state of a tab after an event. Every event but `title`, `devserver`, `slow` and
 * `inflight` stamps `activity`.
 */
export function reduce(tab, event, now) {
  switch (event.kind) {
    case 'error':
      return {
        ...tab,
        ...record({ ...tab, errors: bump(tab.errors, { text: event.text, at: now }) }, {
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
        ...record({ ...tab, requests: bump(tab.requests, { path: event.path, status: event.status, at: now }) }, {
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
    case 'build': {
      // The overlay re-renders as the user types: the same error again is not a new one.
      // An edit above it moves it: it takes the newest line and column (an editor opened on it
      // must not land on a stale line), keeping its id, its count and the tally.
      const path = typeof event.file === 'string' ? event.file : null
      const line = isPos(event.line) ? event.line : null
      const col = isPos(event.col) ? event.col : null
      const newest = (tab.history ?? []).find(isLive)
      if (newest && newest.text === event.text && newest.path === path) {
        if (newest.line === line && newest.col === col) return tab
        return { ...tab, history: tab.history.map((e) => (e === newest ? { ...e, path, line, col } : e)) }
      }
      // Another error replaces the one shown: one build entry open at a time.
      const base = { ...tab, ...resolveBuilds(tab) }
      return {
        ...base,
        ...record({ ...base, errors: bump(base.errors, { text: event.text, at: now }) }, {
          kind: 'build',
          text: event.text,
          path,
          line,
          col,
          n: 1,
          at: now,
          state: 'open',
        }),
        activity: now,
      }
    }
    case 'build-clear': {
      // The overlay went: the error is fixed.
      if (!(tab.history ?? []).some(isLive)) return tab
      return { ...tab, ...resolveBuilds(tab), activity: now }
    }
    case 'slow':
      return slowEntry(tab, event, now)
    case 'perf':
      return perfValuesOf(tab, event)
    case 'perf-regression':
      return perfRegression(tab, event, now)
    case 'inflight':
      return { ...tab, inFlight: Math.min(MAX_IN_FLIGHT, count(event.n)) }
    case 'navigated': {
      // The entry ids keep counting either way. The dev server's kind belongs to the origin: a
      // reload or a pushState route change keeps it, another origin forgets it and looks again.
      // The count in flight stays for the same origin (the worker still times those requests) and
      // starts again at 0 for another, whose timings the worker forgets.
      const next = { ...tab, url: event.url, host: hostOf(event.url), title: event.title ?? '', activity: now }
      // The performance values belong to the document: a pushState route change keeps it (its
      // values and its load's entry stay; a reload's new document replaces them with its first
      // values, `perf`), another origin forgets them.
      if (originOf(event.url) !== originOf(tab.url)) {
        return {
          ...next, inFlight: 0, errors: tally(), requests: tally(), history: [], server: 'up', devServer: null, serverBase: '/',
          perf: {}, perfDoc: null, perfEntryId: null, perfFlaggedDoc: null,
        }
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
      // `server` null: this load's kind is unknown, and the last one's would be stale.
      if (event.server === null) return { ...tab, devServer: null, serverBase: '/' }
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
        ...record({ ...tab, errors: { total: add(e.total), open: add(e.open), seen: e.seen ?? 0, last: e.last } }, { kind: 'limited', n, at: now, state: 'open' }),
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
/** A request path as it travels: no query or fragment, a home folder `~` (`/@fs/~/…`), then clipped. */
const pathOnly = (p) => {
  const bare = homePath(String(p ?? '').split(/[?#]/)[0])
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

/**
 * One history entry as `dev.tabs` carries it: bounded, never its stack, and every text or path with
 * its home folder written `~` before it is clipped (homePath). Null for what cannot travel.
 */
function wireEntry(e) {
  const common = { n: count(e?.n), at: Math.max(0, e?.at), state: e?.state }
  if (!isId(e?.id) || common.n < 1 || !Number.isFinite(common.at) || !STATES.includes(common.state)) return null
  const id = e.id
  switch (e.kind) {
    case 'error':
      return {
        kind: 'error',
        id,
        text: clip(homePath(e.text ?? ''), MAX_TEXT),
        origin: typeof e.origin === 'string' ? clip(homePath(e.origin), MAX_TEXT) : null,
        ...common,
      }
    case 'build':
      return {
        kind: 'build',
        id,
        text: clip(homePath(e.text ?? ''), MAX_TEXT),
        file: typeof e.path === 'string' ? clip(homePath(e.path), MAX_TEXT) : null,
        line: isPos(e.line) ? e.line : null,
        col: isPos(e.col) ? e.col : null,
        ...common,
      }
    case 'request':
      return { kind: 'request', id, method: methodOf(e.method), path: pathOnly(e.path), status: statusOf(e.status), ...common }
    case 'limited':
      return { kind: 'limited', id, ...common }
    case 'slow':
      if (!isSlowMs(e.ms)) return null
      return { kind: 'slow', id, method: methodOf(e.method), path: pathOnly(e.path), ms: e.ms, ...common }
    case 'perf':
      if (!PERF_METRICS.includes(e.metric) || !isPerfValue(e.metric, e.value) || !(e.ratio === null || isRatio(e.ratio))) return null
      return { kind: 'perf', id, metric: e.metric, value: e.value, ratio: e.ratio, ...common }
    default:
      return null
  }
}

function wireRow(t) {
  return {
    tabId: t.tabId,
    app: clip(homePath(t.title || t.host), MAX_APP),
    host: t.host,
    errors: wireTally(t.errors, (l) => ({ text: clip(homePath(l.text ?? ''), MAX_TEXT), at: Math.max(0, l.at) })),
    requests: wireTally(t.requests, (l) => ({
      path: pathOnly(l.path),
      status: statusOf(l.status),
      at: Math.max(0, l.at),
    })),
    history: (Array.isArray(t.history) ? t.history : []).slice(0, HISTORY_MAX).map(wireEntry).filter(Boolean),
    // The kind alone: the base path is for the extension's own use and never leaves it.
    devServer: DEV_SERVERS.includes(t.devServer) ? t.devServer : null,
    // Never trimmed: it is one number, and the live part of the row.
    inFlight: Math.min(MAX_IN_FLIGHT, count(t.inFlight)),
    // Never trimmed either: five bounded numbers. The document's id stays in the extension.
    perf: cleanPerf(t.perf),
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
const isSlowMs = (v) => Number.isInteger(v) && v >= MIN_SLOW_MS && v <= MAX_SLOW_MS
const isMethod = (m) => METHODS.includes(m) || m === 'OTHER'
/** A perf entry's ratio: from 1 (the verdict's 1.5 at least) to 1000 (DevTabSchema's bounds). */
const isRatio = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 1000
const PERF_KEYS_RE = /^(cls|heapMb|lcp|load|longTasks)?(,(cls|heapMb|lcp|load|longTasks))*$/
/** A row's `perf`: an object of known keys only, each within its bounds. */
const okPerf = (p) =>
  !!p && typeof p === 'object' && !Array.isArray(p) && PERF_KEYS_RE.test(Object.keys(p).join()) &&
  Object.entries(p).every(([k, v]) => isPerfValue(k, v))
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
      return keys === 'at,id,kind,method,n,path,state,status' && isMethod(e.method) &&
        isText(e.path, MAX_TEXT) && PATH_RE.test(e.path) && Number.isInteger(e.status) && e.status >= 0 && e.status <= 599
    case 'limited':
      return keys === 'at,id,kind,n,state'
    case 'slow':
      return keys === 'at,id,kind,method,ms,n,path,state' && isMethod(e.method) && isText(e.path, MAX_TEXT) && PATH_RE.test(e.path) &&
        isSlowMs(e.ms)
    case 'perf':
      return keys === 'at,id,kind,metric,n,ratio,state,value' && PERF_METRICS.includes(e.metric) && isPerfValue(e.metric, e.value) &&
        (e.ratio === null || isRatio(e.ratio))
    case 'build':
      return keys === 'at,col,file,id,kind,line,n,state,text' && isText(e.text, MAX_TEXT) &&
        (e.file === null || isText(e.file, MAX_TEXT)) && (e.line === null || isPos(e.line)) && (e.col === null || isPos(e.col))
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
    (r.inFlight === undefined || (Number.isInteger(r.inFlight) && r.inFlight >= 0 && r.inFlight <= MAX_IN_FLIGHT)) &&
    (r.perf === undefined || okPerf(r.perf)) &&
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
      // A row from before the performance values has none; one with values out of bounds is not ours.
      if (t.perf !== undefined && !okPerf(t.perf)) continue
      if (!validRow(wireRow(t))) continue
      // The timings behind the count lived in the stopped worker's memory: none is pending now.
      out[key] = {
        ...t,
        inFlight: 0,
        perf: t.perf ?? {},
        perfDoc: typeof t.perfDoc === 'string' && t.perfDoc.length <= 128 ? t.perfDoc : null,
        perfEntryId: isId(t.perfEntryId) ? t.perfEntryId : null,
        perfFlaggedDoc: typeof t.perfFlaggedDoc === 'string' && t.perfFlaggedDoc.length <= 128 ? t.perfFlaggedDoc : null,
      }
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
