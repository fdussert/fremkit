// Fremdev's compile error reader, run in the extension's isolated world of a dev tab beside the
// relay (fremdev/relay.js). When the dev server's error overlay shows a compile error, it says
// `{ kind: 'build', text, file?, line?, col?, frame?, stack? }`; when the overlay goes,
// `{ kind: 'build-clear' }`. `frame` is the overlay's code frame and `stack` the trace it shows,
// each a list of lines (MAX_FRAME_LINES, MAX_STACK_LINES, MAX_LINE, MAX_EXTRA, the bounds of
// lib/devlog.js `boundBuildLines`): the worker keeps them for a report copied with its stack and
// never sends them to the Edge. The text stops before the code frame some overlays repeat in the
// message, and loses the file when the overlay names it there again.
// - Vite: the `vite-error-overlay` element, whose open shadow root holds the message, the file
//   (`path:line:col`), the code frame and the stack;
// - webpack-dev-server: the `#webpack-dev-server-client-overlay` iframe (same origin), only while its
//   heading says compile problems: its runtime errors are the hook's to report. The code frame is
//   the part of the message that starts at its first `N |` line;
// - Next: inside `nextjs-portal`'s shadow root, the build error dialog only, never the runtime one;
//   `nextjs-portal` alone is the dev indicator, not an error. The code frame is SWC's `,-[` … `` `---- ``
//   block, and what follows it (`Caused by:`, the import trace) is the stack.
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
      stack: '.stack',
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
  // The bounds of lib/devlog.js `boundBuildLines`; a test keeps them equal.
  const MAX_FRAME_LINES = 20
  const MAX_STACK_LINES = 30
  const MAX_LINE = 300
  const MAX_EXTRA = 6_000
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
  /** `s` cut to `max` UTF-16 units, never on half of a surrogate pair. */
  const clip = (s, max) => {
    const cut = s.slice(0, max)
    const last = cut.charCodeAt(cut.length - 1)
    return cut.length === max && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
  }
  /** Whitespace folded, cut to `max` UTF-16 units. */
  const tidy = (s, max) => clip(s.replace(/\s+/g, ' ').trim(), max)

  /** A code frame's line: `12 |`, `> 3 |`. */
  const FRAME_LINE_RE = /^\s*>?\s*\d+\s*\|/
  /** A caret line under a code frame's line: `   |     ^`, `   : ^^^^`. */
  const CARET_RE = /^[\s|:]*\^[\s^~]*$/
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /**
   * An overlay's message without the code frame it may repeat (from its first `N |` line on, and
   * any caret line) and without the file the overlay names apart (`file`, `file:line`,
   * `file:line:col`), whitespace folded and clipped.
   */
  function cleanMessage(message, file) {
    const kept = []
    for (const l of String(message).split('\n')) {
      if (FRAME_LINE_RE.test(l)) break
      if (!CARET_RE.test(l)) kept.push(l)
    }
    let out = kept.join('\n')
    const f = typeof file === 'string' ? file.trim() : ''
    if (f !== '') out = out.replace(new RegExp(`(^|\\s)${escapeRe(f)}(?::\\d+(?::\\d+)?)?(?=\\s|$)`, 'g'), '$1')
    return tidy(out, MAX_TEXT)
  }

  /**
   * Lines of `s`, their ends trimmed and their start kept (a frame's alignment), with no blank line
   * first or last; `trimStart` trims their start too (a stack's `at …`).
   */
  const linesOf = (s, trimStart = false) => {
    const out = String(s).split('\n').map((l) => (trimStart ? l.trim() : l.replace(/\s+$/, '')))
    while (out.length > 0 && out[0].trim() === '') out.shift()
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
    return out
  }

  /**
   * `{ frame?, stack? }` within the bounds: at most MAX_FRAME_LINES and MAX_STACK_LINES lines of
   * MAX_LINE units each, MAX_EXTRA joined (the frame first, then as much of the stack as fits).
   */
  function extra(frame, stack) {
    const out = {}
    let left = MAX_EXTRA
    const take = (lines, max) => {
      const kept = []
      for (const l of lines) {
        if (kept.length >= max) break
        const cut = clip(l, MAX_LINE)
        if (cut.length + 1 > left) break
        kept.push(cut)
        left -= cut.length + 1
      }
      return kept
    }
    const f = take(frame ?? [], MAX_FRAME_LINES)
    if (f.length > 0) out.frame = f
    const s = take(stack ?? [], MAX_STACK_LINES)
    if (s.length > 0) out.stack = s
    return out
  }
  const pos = (s) => {
    const n = Number(s)
    return Number.isInteger(n) && n >= 1 && n <= MAX_POS ? n : undefined
  }

  /**
   * `{ text, file?, line?, col?, frame?, stack? }`, the fields left out when unknown; null without a
   * text. `fallback` is the text when the cleaned message is empty.
   */
  const found = (message, file, line, col, more = {}) => {
    const t = cleanMessage(message, file) || tidy(more.fallback ?? '', MAX_TEXT)
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
    return { ...out, ...extra(more.frame, more.stack) }
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
    const frameText = text(root.querySelector(r.frame))
    // A blank message (whitespace only) is none: the frame says it then.
    const more = { fallback: frameText, frame: linesOf(frameText), stack: linesOf(text(root.querySelector(r.stack)), true) }
    const message = text(root.querySelector(r.message))
    return (m ? found(message, m[1], pos(m[2]), pos(m[3]), more) : found(message, place, undefined, undefined, more)) ?? KEEP
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
      // The message, then its code frame from the first `N |` line on; webpack shows no stack.
      const body = text(header.nextElementSibling)
      const lines = linesOf(body)
      const at = lines.findIndex((l) => FRAME_LINE_RE.test(l))
      const frame = at === -1 ? [] : lines.slice(at)
      return found(body.trim() === '' ? head : body, m[1], pos(m[2]), col, { fallback: head, frame }) ?? KEEP
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
      const frameText = blockText(dialog.querySelector(r.frame))
      const m = /:(\d+):(\d+)\]/.exec(frameText)
      return found(message, text(dialog.querySelector(r.file)), m ? pos(m[1]) : undefined, m ? pos(m[2]) : undefined, nextFrame(frameText)) ?? KEEP
    }
    return null
  }

  /** A node's text with a line break before each block child (Next's import trace is a `div`). */
  function blockText(node) {
    if (!node) return ''
    let out = ''
    for (const child of node.childNodes) {
      if (child.nodeType === 1 && child.localName === 'div' && out !== '' && !out.endsWith('\n')) out += '\n'
      out += text(child)
    }
    return out
  }

  /**
   * SWC's frame in Next's dialog: the `,-[file:line:col]` line to the `` `---- `` one is the frame,
   * what follows (`Caused by:`, the import trace) the stack; the `Error: x message` before it is
   * the message again. Without a `,-[` line, all of it is the frame.
   */
  function nextFrame(s) {
    const lines = linesOf(s)
    const start = lines.findIndex((l) => /^\s*,-\[/.test(l))
    if (start === -1) return { frame: lines }
    const rel = lines.slice(start).findIndex((l) => /^\s*`-+\s*$/.test(l))
    const end = rel === -1 ? lines.length : start + rel + 1
    return { frame: lines.slice(start, end), stack: linesOf(lines.slice(end).join('\n'), true).filter((l) => l !== '') }
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
    const key = now === null ? null : JSON.stringify([now.text, now.file, now.line, now.col, now.frame, now.stack])
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
