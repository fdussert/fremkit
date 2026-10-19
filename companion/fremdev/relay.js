// Fremdev's relay, run in the extension's isolated world of a dev tab before the page's scripts.
// It takes what the hook (fremdev/hook.js, in the page's world) dispatches and hands it to the
// worker, at most 10 events in any second: errors over that are counted here and sent as one
// `count` a second, so a page logging in a loop costs the worker nothing more.
//
// A classic script, registered with chrome.scripting: no import. It cannot read the extension's
// storage either (trusted contexts only), so it does not judge whether the tab is a dev tab: the
// worker drops every event whose tab is not one (companion/fremdev.js).
//
// Transport: a CustomEvent of one fixed type on `document`, its detail a JSON string (why not a
// window `message` nor a DOM attribute: see hook.js). The page can dispatch the same event; whatever
// it sends reaches only its own tab's row: this relay forwards a known kind and a bounded text,
// nothing else, and the worker takes the tab from Chrome's sender, never from the message.

;(() => {
  // Once per page; a relay left behind by an extension reload no longer reaches the worker, and
  // the one injected after it takes over.
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id)
    } catch {
      return false
    }
  }
  if (window.__fremdevRelay?.() === true) return
  window.__fremdevRelay = alive

  const EVENT = '__fremkit_fremdev__'
  const PER_SECOND = 10
  const MAX_TEXT = 300
  /** A JSON-escaped 300-character text is at most six times longer, plus the envelope. */
  const MAX_DETAIL = 6 * MAX_TEXT + 64
  const KINDS = ['error', 'up', 'down', 'hot']

  const forward = (event) => {
    if (!alive()) return
    try {
      chrome.runtime.sendMessage({ target: 'worker', type: 'dev.event', ...event }).catch(() => undefined)
    } catch {
      // the extension was reloaded or removed: this page's relay is orphaned
    }
  }

  // The sliding window of lib/devlog.js `RateLimiter`, copied; server/test/companion-fremdev-scripts.test.ts
  // runs one sequence through both.
  const passed = []
  let over = 0
  let flushing = false

  const allow = () => {
    const t = Date.now()
    while (passed.length > 0 && t - passed[0] >= 1000) passed.shift()
    if (passed.length >= PER_SECOND) return false
    passed.push(t)
    return true
  }

  const flush = () => {
    flushing = false
    if (over > 0) forward({ kind: 'count', n: over })
    over = 0
  }

  document.addEventListener(EVENT, (e) => {
    const raw = e.detail
    if (typeof raw !== 'string' || raw.length > MAX_DETAIL) return
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    if (data === null || typeof data !== 'object' || !KINDS.includes(data.kind)) return
    const kind = data.kind
    if (!allow()) {
      // Errors over the limit are counted; a dev server's signal over it is only a repeat.
      if (kind === 'error') {
        over += 1
        if (!flushing) {
          flushing = true
          setTimeout(flush, 1000)
        }
      }
      return
    }
    if (kind === 'error') forward({ kind, text: typeof data.text === 'string' ? data.text.slice(0, MAX_TEXT) : '' })
    else forward({ kind })
  })
})()
