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
// it sends reaches only its own tab's row: this relay forwards a known kind, a bounded text and,
// for an error, a bounded origin and stack, nothing else, and the worker takes the tab from
// Chrome's sender, never from the message.

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
  // The stack bounds of lib/devlog.js (MAX_FRAMES, MAX_FRAME, MAX_STACK); a test keeps them equal.
  const MAX_FRAMES = 10
  const MAX_FRAME = 300
  const MAX_STACK = 2000
  /** JSON-escaped text, origin and stack are at most six times longer, plus the envelope. */
  const MAX_DETAIL = 6 * (2 * MAX_TEXT + MAX_STACK) + 256
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

  /** lib/devlog.js `clip`: `s` cut to `max` UTF-16 units, never ending on half of a surrogate pair. */
  const clip = (s, max) => {
    const cut = s.slice(0, max)
    const last = cut.charCodeAt(cut.length - 1)
    return cut.length === max && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
  }

  /** A list of strings, each clipped, kept while it fits; undefined for anything else. */
  const frames = (list) => {
    if (!Array.isArray(list) || !list.every((f) => typeof f === 'string')) return undefined
    const out = []
    let length = 0
    for (const f of list) {
      if (out.length >= MAX_FRAMES) break
      const frame = clip(f, MAX_FRAME)
      const next = length + (out.length > 0 ? 1 : 0) + frame.length
      if (next > MAX_STACK) break
      out.push(frame)
      length = next
    }
    return out.length > 0 ? out : undefined
  }

  const errorOf = (data) => {
    const event = { kind: 'error', text: typeof data.text === 'string' ? clip(data.text, MAX_TEXT) : '' }
    if (typeof data.origin === 'string' && data.origin !== '') event.origin = clip(data.origin, MAX_FRAME)
    const stack = frames(data.stack)
    if (stack) event.stack = stack
    return event
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
    if (kind === 'error') forward(errorOf(data))
    else forward({ kind })
  })
})()
