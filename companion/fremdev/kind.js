// Fremdev's dev server detector, run in the extension's isolated world of a dev tab beside the
// relay (fremdev/relay.js). It tells which dev server served the page from the page's own tags and
// says it once, as `{ kind: 'devserver', server, base }`:
// - Vite: a `<script type="module">` whose URL path ends in `/@vite/client`; `base` is the path
//   before `@vite/client` (`/app/` for a Vite app served under `/app/`);
// - Next: a `<script>` whose path starts with `/_next/`;
// - webpack-dev-server: a `<script>` whose path contains `webpack-dev-server`, or its overlay
//   element `#webpack-dev-server-client-overlay`.
// `base` is `/` for anything but Vite. Only the kind leaves the extension (the row's `devServer`);
// the base is kept for building the dev server's own URLs.
//
// It reads attributes and element ids only, never a page object, and runs no page code. It looks at
// DOMContentLoaded (at once when the document is past `loading`), then watches the document for
// added nodes until a kind is found or 30 s have passed.
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
  if (window.__fremdevKind?.() === true) return
  window.__fremdevKind = alive

  const GIVE_UP_MS = 30_000
  const VITE_CLIENT = '@vite/client'
  /** lib/devtabs.js `validBase`, copied: a bounded absolute path ending in `/`, no empty or dot segment. */
  const BASE_RE = /^\/[A-Za-z0-9._~\-/]{0,99}$/
  const validBase = (base) =>
    BASE_RE.test(base) && base.endsWith('/') && !base.includes('//') && !base.split('/').some((s) => s === '.' || s === '..')

  let done = false
  let observer = null
  let timer = null

  /** The path of a `src` attribute, resolved against the document; null when it is not a URL. */
  const pathOf = (el) => {
    const raw = el.getAttribute('src')
    if (typeof raw !== 'string' || raw === '') return null
    try {
      return new URL(raw, document.baseURI).pathname
    } catch {
      return null
    }
  }

  /** `{ server, base }` for the page as it stands, or null. */
  const detect = () => {
    const scripts = [...document.querySelectorAll('script[src]')]
    for (const el of scripts) {
      if (el.getAttribute('type') !== 'module') continue
      const path = pathOf(el)
      if (path !== null && path.endsWith(`/${VITE_CLIENT}`)) {
        const base = path.slice(0, -VITE_CLIENT.length)
        // A base the worker would refuse: the kind is not told rather than told wrong.
        return validBase(base) ? { server: 'vite', base } : 'unusable'
      }
    }
    if (scripts.some((el) => pathOf(el)?.startsWith('/_next/'))) return { server: 'next', base: '/' }
    if (scripts.some((el) => pathOf(el)?.includes('webpack-dev-server')) || document.getElementById('webpack-dev-server-client-overlay')) {
      return { server: 'webpack', base: '/' }
    }
    return null
  }

  const stop = () => {
    done = true
    observer?.disconnect()
    observer = null
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const send = (found) => {
    if (!alive()) return
    try {
      chrome.runtime.sendMessage({ target: 'worker', type: 'dev.event', kind: 'devserver', server: found.server, base: found.base }).catch(() => undefined)
    } catch {
      // the extension was reloaded or removed: this page's script is orphaned
    }
  }

  const look = () => {
    if (done) return
    let found = null
    try {
      found = detect()
    } catch {
      found = null
    }
    if (found === null) return
    stop()
    if (found !== 'unusable') send(found)
  }

  const start = () => {
    look()
    if (done) return
    try {
      observer = new MutationObserver(look)
      observer.observe(document.documentElement, { subtree: true, childList: true })
    } catch {
      observer = null
    }
    timer = setTimeout(stop, GIVE_UP_MS)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
