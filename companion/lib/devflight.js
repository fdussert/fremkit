// The requests a dev tab has started and not finished, timed from chrome.webRequest's own
// `timeStamp`s: what a slow request is (lib/devtabs.js's `slow` entry) and the row's `inFlight`.
// Pure: the worker hands in every time, so a test reads the exact count.

/** A request that succeeded in this long or longer is slow. */
export const SLOW_MS = 1000
/**
 * A request still pending after this long stops counting, and is forgotten: a long poll or an
 * EventSource that never finishes neither stays in flight nor ever reads as slow.
 */
export const STALE_MS = 30_000
/** The highest `inFlight` a row carries. */
export const MAX_IN_FLIGHT = 999
/** The requests tracked at once, all tabs together; the oldest goes first. */
export const MAX_TRACKED = 4096

export class InFlight {
  constructor() {
    /** requestId → { tabId, at }, oldest first (a Map keeps insertion order). */
    this.pending = new Map()
  }

  get size() {
    return this.pending.size
  }

  /**
   * A request starting. A redirect starts the same request id again: it keeps its first start, so
   * the time is the whole request's. Returns the tab of the request dropped to make room (its
   * count changed), or null.
   */
  start(requestId, tabId, at) {
    if (this.pending.has(requestId)) return null
    let evicted = null
    if (this.pending.size >= MAX_TRACKED) {
      const [oldest, p] = this.pending.entries().next().value
      this.pending.delete(oldest)
      evicted = p.tabId
    }
    this.pending.set(requestId, { tabId, at })
    return evicted
  }

  /** `{ tabId, ms }` for a request this started and has not forgotten; null for any other. */
  finish(requestId, at) {
    const p = this.pending.get(requestId)
    if (!p) return null
    this.pending.delete(requestId)
    const ms = at - p.at
    if (ms > STALE_MS) return null
    return { tabId: p.tabId, ms: Math.max(0, ms) }
  }

  /** Forgets every request started more than STALE_MS before `at`. */
  prune(at) {
    for (const [id, p] of this.pending) if (at - p.at > STALE_MS) this.pending.delete(id)
  }

  /** The tab's pending requests at `at`, at most MAX_IN_FLIGHT; the stale ones are forgotten. */
  count(tabId, at) {
    this.prune(at)
    let n = 0
    for (const p of this.pending.values()) if (p.tabId === tabId) n++
    return Math.min(MAX_IN_FLIGHT, n)
  }

  /** When the oldest pending request goes stale, or null with none pending. */
  nextStale() {
    let first = null
    for (const p of this.pending.values()) if (first === null || p.at < first) first = p.at
    return first === null ? null : first + STALE_MS
  }

  forgetTab(tabId) {
    for (const [id, p] of this.pending) if (p.tabId === tabId) this.pending.delete(id)
  }

  clear() {
    this.pending.clear()
  }
}
