// Fremdev's performance reader, run in the extension's isolated world of a dev tab beside the relay
// (fremdev/relay.js). It reads the page's performance timeline, which the isolated world sees as the
// page does (checked in Chromium), and tells the worker the current document's values as
// `{ kind: 'perf', load?, lcp?, cls?, longTasks?, heapMb? }`:
// - load: the navigation entry's `loadEventEnd`, once it is above 0;
// - lcp: the latest `largest-contentful-paint` entry's `startTime`;
// - cls: the sum of the `layout-shift` entries' values, those right after an input left out;
// - longTasks: the `longtask` entries (50 ms or more) since the page started (buffered: those before the load count);
// - heapMb: `performance.memory.usedJSHeapSize` in MB, where Chrome has it (coarse, and refreshed
//   rarely: read again every HEAP_MS).
// The observers are `buffered`, so what happened before this script ran counts too. Every value is
// rounded and bounded as the worker expects (`perfValues` in lib/devperf.js); the worker judges
// whether the load regressed.
//
// It sends at most once per SEND_MS, the whole set of values, and only when one changed: the first
// change waits SEND_MS for the others. It calls no page code: `performance` and
// `PerformanceObserver` are the isolated world's own.
//
// A classic script, registered with chrome.scripting: no import. The worker validates what it
// sends and takes the tab and the document from Chrome's sender.

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
  if (window.__fremdevPerf?.() === true) return
  window.__fremdevPerf = alive

  const SEND_MS = 1_000
  const HEAP_MS = 10_000
  /** How often, and how long, a load not finished yet (`loadEventEnd` 0) is looked at again. */
  const LOAD_RETRY_MS = 250
  const LOAD_GIVE_UP_MS = 30_000
  const MAX_MS = 600_000
  const MAX_CLS = 100
  const MAX_TASKS = 100_000
  const MAX_HEAP_MB = 65_536
  const LONG_TASK_MS = 50

  const ms = (v) => Math.min(MAX_MS, Math.max(0, Math.round(v)))
  const values = {}
  let cls = 0
  let longTasks = 0
  let timer = null
  let heapTimer = null
  let lastSent = ''

  const readHeap = () => {
    try {
      const used = performance.memory?.usedJSHeapSize
      if (typeof used === 'number' && Number.isFinite(used) && used >= 0) values.heapMb = Math.min(MAX_HEAP_MB, Math.round(used / 1_048_576))
    } catch {
      // not Chrome's, or not here
    }
  }

  const send = () => {
    timer = null
    readHeap()
    const msg = { target: 'worker', type: 'dev.event', kind: 'perf' }
    for (const key of ['load', 'lcp', 'cls', 'longTasks', 'heapMb']) if (values[key] !== undefined) msg[key] = values[key]
    if (!alive()) {
      // Orphaned: nothing reaches the worker any more, and nothing is read again.
      if (heapTimer !== null) clearInterval(heapTimer)
      heapTimer = null
      return
    }
    const text = JSON.stringify(msg)
    if (text === lastSent || Object.keys(msg).length === 3) return
    lastSent = text
    try {
      chrome.runtime.sendMessage(msg).catch(() => undefined)
    } catch {
      // the extension was reloaded or removed: this page's script is orphaned
    }
  }

  /** A value may have changed: the values go out within SEND_MS, together. */
  const schedule = () => {
    if (timer === null) timer = setTimeout(send, SEND_MS)
  }

  const observe = (type, onEntries) => {
    try {
      new PerformanceObserver((list) => {
        try {
          onEntries(list.getEntries())
        } catch {
          return
        }
        schedule()
      }).observe({ type, buffered: true })
    } catch {
      // an entry type this browser does not have
    }
  }

  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1]
    if (last && typeof last.startTime === 'number') values.lcp = ms(last.startTime)
  })
  observe('layout-shift', (entries) => {
    for (const e of entries) if (!e.hadRecentInput && typeof e.value === 'number' && e.value > 0) cls += e.value
    values.cls = Math.min(MAX_CLS, Math.round(cls * 1000) / 1000)
  })
  observe('longtask', (entries) => {
    for (const e of entries) if (typeof e.duration === 'number' && e.duration >= LONG_TASK_MS) longTasks++
    values.longTasks = Math.min(MAX_TASKS, longTasks)
  })

  /** The load time once the load event has ended; looked at again until then. */
  let loadTries = 0
  const readLoad = () => {
    let end = 0
    try {
      end = performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? 0
    } catch {
      end = 0
    }
    if (typeof end === 'number' && end > 0) {
      values.load = ms(end)
      schedule()
      return
    }
    if (++loadTries * LOAD_RETRY_MS < LOAD_GIVE_UP_MS) setTimeout(readLoad, LOAD_RETRY_MS)
  }
  // `loadEventEnd` is set once the load handlers have run: after the event, not in it.
  if (document.readyState === 'complete') readLoad()
  else window.addEventListener('load', () => setTimeout(readLoad, 0), { once: true })

  // The heap moves with nothing else happening.
  heapTimer = setInterval(schedule, HEAP_MS)
  schedule()
})()
