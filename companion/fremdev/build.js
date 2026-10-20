// Fremdev's compile error reader, run in the extension's isolated world of a dev tab beside the
// relay (fremdev/relay.js). When the dev server's error overlay shows a compile error, it says
// `{ kind: 'build', text, file?, line?, col? }`; when the overlay goes, `{ kind: 'build-clear' }`.
// - Vite: the `vite-error-overlay` element, whose open shadow root holds the message, the file
//   (`path:line:col`) and the code frame;
// - webpack-dev-server: the `#webpack-dev-server-client-overlay` iframe (same origin), only while its
//   heading says compile problems: its runtime errors are the hook's to report;
// - Next: inside `nextjs-portal`'s shadow root, the build error dialog only, never the runtime one;
//   `nextjs-portal` alone is the dev indicator, not an error.
// Every selector is in READERS below, fixed against real overlays (ui/test/fixtures/fremdev/).
//
// It reads `textContent` and attributes only, never a page object, and runs no page code: the
// shadow root through `Element.prototype.shadowRoot`, the frame's document through
// `HTMLIFrameElement.prototype.contentDocument`, both taken from this world's own prototypes. It
// watches the document (and the overlay's own root once found) and looks again 200 ms after the
// last change, sends only what changed, and at most 2 messages a second.
//
// A classic script, registered with chrome.scripting: no import. The worker validates what it
// sends (`pageEvent` in companion/fremdev.js) and takes the tab from Chrome's sender.

;(() => {
  // Once per page; one left behind by an extension reload no longer reaches the worker, and the
  // one injected after it takes over.
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id)
    } catch {
      return false
    }
  }
  if (window.__fremdevBuild?.() === true) return
  window.__fremdevBuild = alive

  /** Where each dev server's overlay keeps what is read. */
  const READERS = {
    vite: {
      host: 'vite-error-overlay',
      message: '.message-body',
      file: '.file',
      frame: '.frame',
    },
    webpack: {
      frame: 'iframe#webpack-dev-server-client-overlay',
      root: '#webpack-dev-server-client-overlay-div',
      heading: '#webpack-dev-server-client-overlay-div > div:first-child',
      /** The headings of a compile problem; "Uncaught runtime errors:" is not one. */
      compile: ['Compiled with problems', 'Failed to compile'],
      /** Each problem: a header (`ERROR in ./src/index.js 2:0`), then its message. */
      entries: '#webpack-dev-server-client-overlay-div > div:last-child > div',
    },
    next: {
      host: 'nextjs-portal',
      dialog: '[data-nextjs-dialog]',
      label: '#nextjs__container_errors_label',
      /** The build error dialog's labels; "Runtime Error", "Console Error" and the like are not. */
      build: ['Build Error', 'Failed to compile'],
      message: '#nextjs__container_errors_desc',
      file: '[data-nextjs-codeframe] .code-frame-link [data-text]',
      frame: '[data-nextjs-codeframe] .code-frame-lines',
    },
  }

  const MAX_TEXT = 300
  const MAX_FILE = 1024
  const MAX_POS = 10_000_000
  const DEBOUNCE_MS = 200
  /** A run waits no longer than this however busy the page (an overlay animating). */
  const MAX_WAIT_MS = 1_000
  /** At most 2 messages a second. */
  const GAP_MS = 500

  const shadowOf = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot').get
  const frameDocOf = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument').get
  const textOf = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').get

  const text = (node) => (node ? String(textOf.call(node) ?? '') : '')
  /** Whitespace folded, cut to `max` UTF-16 units, never on half of a surrogate pair. */
  const tidy = (s, max) => {
    const cut = s.replace(/\s+/g, ' ').trim().slice(0, max)
    const last = cut.charCodeAt(cut.length - 1)
    return cut.length === max && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
  }
  const pos = (s) => {
    const n = Number(s)
    return Number.isInteger(n) && n >= 1 && n <= MAX_POS ? n : undefined
  }

  /** `{ text, file?, line?, col? }`, the fields left out when unknown; null without a text. */
  const found = (message, file, line, col) => {
    const t = tidy(message, MAX_TEXT)
    if (t === '') return null
    const out = { text: t }
    const f = typeof file === 'string' ? file.trim() : ''
    if (f !== '' && f.length <= MAX_FILE) {
      out.file = f
      if (line !== undefined) {
        out.line = line
        if (col !== undefined) out.col = col
      }
    }
    return out
  }

  /**
   * A compile error overlay is showing but has no text to read yet (a frame mid-render): what was
   * last said stands, never a `build-clear` while the overlay is there.
   */
  const KEEP = 'keep'

  /** The roots read this pass: watched too, as a change inside them is not the document's. */
  let roots = []

  function readVite() {
    const r = READERS.vite
    const host = document.querySelector(r.host)
    const root = host ? shadowOf.call(host) : null
    if (!root) return null
    roots.push(root)
    const place = text(root.querySelector(r.file)).trim()
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(place)
    // A blank message (whitespace only) is none: the frame says it then.
    const message = text(root.querySelector(r.message)).trim() || text(root.querySelector(r.frame))
    return (m ? found(message, m[1], pos(m[2]), pos(m[3])) : found(message, place)) ?? KEEP
  }

  function readWebpack() {
    const r = READERS.webpack
    const frame = document.querySelector(r.frame)
    if (!frame) return null
    watchLoad(frame)
    const doc = frameDocOf.call(frame)
    if (!doc) return null
    roots.push(doc)
    const heading = text(doc.querySelector(r.heading)).trim()
    if (!r.compile.some((h) => heading.startsWith(h))) return null
    for (const entry of doc.querySelectorAll(r.entries)) {
      const header = entry.firstElementChild
      const head = text(header).trim()
      // An error only: a warning is not a failed build.
      const m = /^ERROR(?: in (\S+)(?: (\d+):(\d+))?)?/.exec(head)
      if (!m) continue
      // webpack counts columns from 0, the editors from 1.
      const col = m[3] === undefined ? undefined : pos(Number(m[3]) + 1)
      return found(text(header.nextElementSibling).trim() || head, m[1], pos(m[2]), col) ?? KEEP
    }
    return null
  }

  function readNext() {
    const r = READERS.next
    const host = document.querySelector(r.host)
    const root = host ? shadowOf.call(host) : null
    if (!root) return null
    roots.push(root)
    for (const dialog of root.querySelectorAll(r.dialog)) {
      const label = text(dialog.querySelector(r.label)).trim()
      if (!r.build.includes(label)) continue
      // SWC writes its errors as `  x message`.
      const message = text(dialog.querySelector(r.message)).replace(/^\s*x\s+/, '')
      const m = /:(\d+):(\d+)\]/.exec(text(dialog.querySelector(r.frame)))
      return found(message, text(dialog.querySelector(r.file)), m ? pos(m[1]) : undefined, m ? pos(m[2]) : undefined) ?? KEEP
    }
    return null
  }

  function read() {
    roots = []
    for (const reader of [readVite, readWebpack, readNext]) {
      let out = null
      try {
        out = reader()
      } catch {
        out = null
      }
      if (out) return out
    }
    return null
  }

  // --- sending -----------------------------------------------------------------------------------

  /** What was last said: the error's key, or null for no overlay. */
  let lastKey = null
  let lastSentAt = -Infinity

  const send = (msg) => {
    if (!alive()) return
    try {
      chrome.runtime.sendMessage({ target: 'worker', type: 'dev.event', ...msg }).catch(() => undefined)
    } catch {
      // the extension was reloaded or removed: this page's script is orphaned
    }
  }

  let timer = null
  let firstAt = null

  function run() {
    timer = null
    firstAt = null
    const wait = lastSentAt + GAP_MS - Date.now()
    if (wait > 0) {
      timer = setTimeout(run, wait)
      return
    }
    const now = read()
    watchRoots()
    if (now === KEEP) return
    const key = now === null ? null : JSON.stringify([now.text, now.file, now.line, now.col])
    if (key === lastKey) return
    lastKey = key
    lastSentAt = Date.now()
    send(now === null ? { kind: 'build-clear' } : { kind: 'build', ...now })
  }

  /** A run 200 ms after the last change, and no later than 1 s after the first. */
  function schedule() {
    const at = Date.now()
    if (firstAt === null) firstAt = at
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(run, Math.max(0, Math.min(DEBOUNCE_MS, firstAt + MAX_WAIT_MS - at)))
  }

  // --- watching ----------------------------------------------------------------------------------

  const OPTIONS = { subtree: true, childList: true, characterData: true }
  let observer = null
  const watched = new WeakSet()
  const loads = new WeakSet()

  function watchRoots() {
    if (!observer) return
    for (const root of roots) {
      if (watched.has(root)) continue
      watched.add(root)
      try {
        observer.observe(root, OPTIONS)
      } catch { /* a root gone meanwhile */ }
    }
  }

  /** webpack's frame fills its document once loaded, and may swap it: look again then. */
  function watchLoad(frame) {
    if (loads.has(frame)) return
    loads.add(frame)
    frame.addEventListener('load', schedule)
  }

  const start = () => {
    try {
      observer = new MutationObserver(schedule)
      observer.observe(document.documentElement, OPTIONS)
    } catch {
      observer = null
    }
    schedule()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
