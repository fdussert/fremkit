// Fremdev's hook, run in a dev tab's own world (MAIN) before the page's scripts. It reports the
// page's errors and its dev server's console signals to the relay (fremdev/relay.js) and changes
// nothing the page can see: `console.error` still prints first, errors still propagate (no
// `preventDefault`), `fetch` is not touched, and everything runs inside try/catch.
//
// A classic script, registered with chrome.scripting: no import. What it shares with
// lib/devlog.js is copied, and kept equal by server/test/companion-extension-manifest.test.ts
// (the prefixes) and server/test/companion-fremdev-scripts.test.ts (the text of `console.error`).
//
// The page can read the channel id and post the same messages itself. That only ever lands on
// its own tab's row, as a kind and a bounded text: the worker takes the tab from Chrome, not
// from the message, and rebuilds the event from those two fields alone.

;(() => {
  try {
    if (window.__fremdevHooked) return
    Object.defineProperty(window, '__fremdevHooked', { value: true })
  } catch {
    return
  }

  const MAX_TEXT = 300
  const DOWN = ['[vite] server connection lost', '[webpack-dev-server] Disconnected!', '[WDS] Disconnected!']
  const UP = [
    '[vite] connected.',
    '[webpack-dev-server] Server started',
    '[webpack-dev-server] Hot Module Replacement enabled',
    '[webpack-dev-server] Live Reloading enabled',
  ]
  const HOT = ['[vite] hot updated:', '[HMR] App is up to date', '[HMR] Updated modules']

  const clip = (s) => {
    const cut = s.slice(0, MAX_TEXT)
    const last = cut.charCodeAt(cut.length - 1)
    return cut.length === MAX_TEXT && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
  }

  // Taken now: the page may replace them later, and must not see its own calls come back.
  const post = window.postMessage.bind(window)
  const origin = location.origin

  const show = (v) => {
    if (typeof v === 'string') return v
    if (v instanceof Error) return String(v)
    if (v !== null && typeof v === 'object') {
      try {
        const json = JSON.stringify(v)
        if (typeof json === 'string') return json
      } catch {
        // circular, or a toJSON that throws: the plain string
      }
    }
    return String(v)
  }

  /** The arguments joined the way the console prints them (lib/devlog.js `errorText`). */
  const textOf = (args) => {
    const parts = []
    try {
      for (const a of Array.from(args ?? [])) {
        try {
          parts.push(show(a))
        } catch {
          parts.push('[unprintable]')
        }
      }
      return clip(parts.join(' '))
    } catch {
      return ''
    }
  }

  const signalOf = (text) => {
    if (typeof text !== 'string') return null
    if (DOWN.some((p) => text.startsWith(p))) return 'down'
    if (UP.some((p) => text.startsWith(p))) return 'up'
    if (HOT.some((p) => text.startsWith(p))) return 'hot'
    return null
  }

  // Read at each event: the relay sets it before the page runs, and a relay injected again (the
  // extension reloaded) sets a new one.
  const send = (kind, text) => {
    try {
      const ch = document.documentElement?.dataset?.fremdevCh
      if (!ch) return
      post(text === undefined ? { ch, kind } : { ch, kind, text }, origin)
    } catch {
      // nothing the page should notice
    }
  }

  const wrap = (name, after) => {
    const original = console[name]
    if (typeof original !== 'function') return
    console[name] = function (...args) {
      const result = original.apply(this, args)
      try {
        after(args)
      } catch {
        // the page's call already printed
      }
      return result
    }
  }

  try {
    wrap('error', (args) => send('error', textOf(args)))
    for (const name of ['log', 'info', 'debug']) {
      wrap(name, (args) => {
        const signal = signalOf(args[0])
        if (signal) send(signal)
      })
    }
    window.addEventListener('error', (e) => {
      try {
        send('error', clip(`Uncaught ${textOf([e.error ?? e.message])}`))
      } catch {
        // ignored
      }
    })
    window.addEventListener('unhandledrejection', (e) => {
      try {
        send('error', clip(`Uncaught (in promise) ${textOf([e.reason])}`))
      } catch {
        // ignored
      }
    })
  } catch {
    // a console the page froze: no hook rather than a broken page
  }
})()
