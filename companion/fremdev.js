// Fremdev in the service worker: which tabs are dev tabs, what their pages, their requests and
// their navigations say, and the rows sent to Fremkit as `dev.tabs`. worker.js owns the socket and
// only wires this in (`createFremdev` below).
//
// Where the events come from:
// - the page: fremdev/hook.js (page world) → fremdev/relay.js (isolated world) → `dev.event`,
//   taken only from this extension's own content script in the top frame of a dev tab;
// - the requests: chrome.webRequest, for a tab that already has a row;
// - the dev server: chrome.webNavigation (a refused top-frame load is the server down).
//
// State: `chrome.storage.local.fremdev = { on, patterns }` (the options page edits the patterns),
// `chrome.storage.session.devTabs = { [tabId]: tab }` and `chrome.storage.session.fremdevSupport`
// for the popup. Nothing Fremdev is sent unless the server's `ready` said it speaks it.

import { BUILTIN_PERMISSION_ORIGINS, FREMKIT_EXCLUDES, isDevUrl, parsePattern } from './lib/devhosts.js'
import { clip, isNoise, MAX_TEXT, pathOf } from './lib/devlog.js'
import { emptyTab, fremdevSupport, reduce, Throttle, wireTabs } from './lib/devtabs.js'
import * as protocol from './lib/protocol.js'

const RELAY_ID = 'fremdev-relay'
const HOOK_ID = 'fremdev-hook'
const RELAY_JS = 'fremdev/relay.js'
const HOOK_JS = 'fremdev/hook.js'
/** `dev.tabs` at most this often. */
const SEND_MS = 500
/** Keeps the worker, and so the socket, alive while a dev tab is open. */
const PING_MS = 20_000
/** Rows kept here; the wire carries the 32 latest (lib/devtabs.js). */
const MAX_ROWS = 64
const MAX_COUNT = 1_000_000
/** A top-frame load that failed this way: nothing listens where the dev server was. */
const SERVER_GONE = ['net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_EMPTY_RESPONSE']

const validId = (id) => Number.isInteger(id) && id >= 0
const cleanPatterns = (list) =>
  Array.isArray(list) ? [...new Set(list.map((p) => parsePattern(p)?.pattern).filter(Boolean))] : []

/**
 * The event a page's relay may send, rebuilt from its kind and text alone; null for anything else.
 * The tab is never the message's to name.
 */
export function pageEvent(msg) {
  switch (msg?.kind) {
    case 'error':
      return { kind: 'error', text: clip(typeof msg.text === 'string' ? msg.text : '', MAX_TEXT) }
    case 'count':
      return Number.isInteger(msg.n) && msg.n > 0 ? { kind: 'count', n: Math.min(MAX_COUNT, msg.n) } : null
    case 'up':
    case 'down':
      return { kind: 'server', state: msg.kind }
    case 'hot':
      return { kind: 'hot' }
    default:
      return null
  }
}

/**
 * `send(msg)` hands a message to the greeted socket (false when there is none); `wantSocket()`
 * tells the worker that `active()` may have changed or a dev event came in.
 */
export function createFremdev({
  send,
  wantSocket,
  api = globalThis.chrome,
  storage = api.storage,
  now = Date.now,
  setTimer = setTimeout,
  every = setInterval,
  stopEvery = clearInterval,
}) {
  let on = false
  let patterns = []
  /** tabId (as a string key) → tab, lib/devtabs.js's shape. */
  let tabs = {}
  /** `fremdevSupport(lastReady)`; null until a server said, here or in an earlier worker life. */
  let support = null
  let pingTimer = null
  let wasActive = false
  const throttle = new Throttle(SEND_MS, now, setTimer)

  const supported = () => support === null || support === 'yes'
  const active = () => on && supported() && Object.keys(tabs).length > 0
  const modules = () => (on ? ['fremplay', 'fremdev'] : ['fremplay'])
  const isDev = (url) => typeof url === 'string' && isDevUrl(url, patterns)

  function flush() {
    storage.session.set({ devTabs: tabs }).catch(() => undefined)
    if (support === 'yes' && on) send(protocol.devTabs(wireTabs(Object.values(tabs))))
  }

  /** After any change: the rows go out (throttled), the keep-alive and the socket follow `active()`. */
  function refresh({ changed = false, event = false } = {}) {
    if (changed) throttle.push(flush)
    const act = active()
    const pinging = act && support === 'yes'
    if (pinging && pingTimer === null) pingTimer = every(() => send(protocol.ping()), PING_MS)
    if (!pinging && pingTimer !== null) {
      stopEvery(pingTimer)
      pingTimer = null
    }
    // A dev event while active is also the cue to come back after the socket gave up.
    if (act !== wasActive || (act && event)) {
      wasActive = act
      wantSocket()
    }
  }

  /** Applies an event to a tab's row; `seed` creates the row when there is none. */
  function apply(tabId, event, seed = null) {
    const key = String(tabId)
    let tab = tabs[key]
    if (!tab) {
      if (!seed || !isDev(seed.url)) return
      tab = emptyTab(tabId, seed.url, seed.title, now())
      const keys = Object.keys(tabs)
      if (keys.length >= MAX_ROWS) {
        const oldest = keys.reduce((a, b) => (tabs[a].activity <= tabs[b].activity ? a : b))
        tabs = { ...tabs }
        delete tabs[oldest]
      }
    }
    tabs = { ...tabs, [key]: reduce(tab, event, now()) }
    refresh({ changed: true, event: true })
  }

  function drop(tabId) {
    const key = String(tabId)
    if (!tabs[key]) return
    tabs = { ...tabs }
    delete tabs[key]
    refresh({ changed: true })
  }

  // --- content scripts --------------------------------------------------------------------------

  /** The dev origins the user granted: the built-in hosts and the patterns' permissions. */
  async function grantedOrigins() {
    const wanted = [...new Set([...BUILTIN_PERMISSION_ORIGINS, ...patterns.map((p) => parsePattern(p)?.permission).filter(Boolean)])]
    const granted = []
    for (const origin of wanted) {
      try {
        if (await api.permissions.contains({ origins: [origin] })) granted.push(origin)
      } catch { /* not a pattern this browser takes */ }
    }
    return granted
  }

  async function unregister() {
    try {
      const existing = await api.scripting.getRegisteredContentScripts({ ids: [RELAY_ID, HOOK_ID] })
      if (existing.length > 0) await api.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) })
    } catch { /* none registered */ }
  }

  /** Registers the relay and the hook on the granted dev origins; returns them. */
  async function register() {
    await unregister()
    const origins = await grantedOrigins()
    if (origins.length === 0) return origins
    const common = {
      matches: origins,
      excludeMatches: FREMKIT_EXCLUDES,
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: true,
    }
    // The relay first: it puts the channel id on the page before the page's own scripts run.
    await api.scripting.registerContentScripts([
      { id: RELAY_ID, js: [RELAY_JS], ...common },
      { id: HOOK_ID, js: [HOOK_JS], world: 'MAIN', ...common },
    ])
    return origins
  }

  /** The dev tabs already open get the scripts now (each skips itself when it already runs there). */
  async function injectOpen(origins) {
    if (origins.length === 0) return
    let open = []
    try {
      open = await api.tabs.query({ url: origins })
    } catch {
      return
    }
    for (const t of open) {
      if (!validId(t.id) || !isDev(t.url)) continue
      try {
        await api.scripting.executeScript({ target: { tabId: t.id }, files: [RELAY_JS] })
        await api.scripting.executeScript({ target: { tabId: t.id }, files: [HOOK_JS], world: 'MAIN' })
      } catch {
        continue
      }
      if (on && !tabs[String(t.id)]) apply(t.id, { kind: 'server', state: 'up' }, { url: t.url, title: t.title })
    }
  }

  // One registration at a time: a pattern saved while the permission lands must not race it.
  let queue = Promise.resolve()
  const serial = (fn) => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }
  const sync = ({ inject }) =>
    serial(async () => {
      if (!on) return unregister()
      const origins = await register()
      if (inject) await injectOpen(origins)
    })

  async function readSaved() {
    const { fremdev: saved } = await storage.local.get('fremdev')
    return saved && typeof saved === 'object' ? saved : {}
  }

  // --- listeners (registered at once: Chrome wakes the worker only for those) -----------------

  const onRequestDone = (d) => {
    if (d.statusCode >= 400) void request(d, d.statusCode)
  }
  // A top-frame load that failed is the dev server's state (webNavigation), not a request.
  const onRequestFailed = (d) => {
    if (d.type !== 'main_frame') void request(d, 0, d.error)
  }
  async function request(d, status, error) {
    await loaded
    if (!on || !validId(d.tabId) || !tabs[String(d.tabId)] || isNoise(d.url, error)) return
    apply(d.tabId, { kind: 'request', path: pathOf(d.url), status })
  }

  async function onCommitted(d) {
    await loaded
    if (!on || d.frameId !== 0 || !validId(d.tabId)) return
    if (!isDev(d.url)) return drop(d.tabId)
    // The row exists before anything is awaited: the page's first requests follow at once.
    const row = tabs[String(d.tabId)]
    if (row) apply(d.tabId, { kind: 'navigated', url: d.url, title: row.title })
    apply(d.tabId, { kind: 'server', state: 'up' }, { url: d.url, title: '' })
    const title = (await api.tabs.get(d.tabId).catch(() => null))?.title
    if (typeof title === 'string' && tabs[String(d.tabId)]) apply(d.tabId, { kind: 'title', title })
  }

  async function onNavigationError(d) {
    await loaded
    if (!on || d.frameId !== 0 || !validId(d.tabId) || !SERVER_GONE.includes(d.error) || !isDev(d.url)) return
    const row = tabs[String(d.tabId)]
    if (row && row.url !== d.url) apply(d.tabId, { kind: 'navigated', url: d.url, title: row.title })
    apply(d.tabId, { kind: 'server', state: 'down' }, { url: d.url, title: '' })
  }

  const REQUEST_FILTER = { urls: ['http://*/*', 'https://*/*'] }
  const NAV_FILTER = { url: [{ schemes: ['http', 'https'] }] }
  let listening = false
  /** The request and navigation listeners only while on: off, they would wake the worker for nothing. */
  function listen(want) {
    if (want === listening) return
    listening = want
    try {
      if (want) {
        // Only the hosts the extension holds a permission for reach these, whatever the filter says.
        api.webRequest.onCompleted.addListener(onRequestDone, REQUEST_FILTER)
        api.webRequest.onErrorOccurred.addListener(onRequestFailed, REQUEST_FILTER)
        api.webNavigation.onCommitted.addListener(onCommitted, NAV_FILTER)
        api.webNavigation.onErrorOccurred.addListener(onNavigationError, NAV_FILTER)
      } else {
        api.webRequest.onCompleted.removeListener(onRequestDone)
        api.webRequest.onErrorOccurred.removeListener(onRequestFailed)
        api.webNavigation.onCommitted.removeListener(onCommitted)
        api.webNavigation.onErrorOccurred.removeListener(onNavigationError)
      }
    } catch { /* an API missing in this browser: Fremdev sees less, nothing breaks */ }
  }
  listen(true)

  api.tabs.onRemoved.addListener(async (tabId) => {
    await loaded
    drop(tabId)
  })
  api.tabs.onUpdated.addListener(async (tabId, info) => {
    await loaded
    if (!on || !tabs[String(tabId)]) return
    if (typeof info.url === 'string' && !isDev(info.url)) return drop(tabId)
    if (typeof info.title === 'string') apply(tabId, { kind: 'title', title: info.title })
  })
  // A dev origin granted or taken back (the popup, the options page, Chrome's own settings).
  api.permissions.onAdded.addListener(async () => {
    await loaded
    if (on) await sync({ inject: true })
  })
  api.permissions.onRemoved.addListener(async () => {
    await loaded
    if (on) await sync({ inject: false })
  })

  // --- boot -------------------------------------------------------------------------------------

  const loaded = (async () => {
    const saved = await readSaved()
    const session = await storage.session.get(['devTabs', 'fremdevSupport'])
    on = saved.on === true
    patterns = cleanPatterns(saved.patterns)
    if (support === null && ['yes', 'disabled', 'unsupported'].includes(session.fremdevSupport)) support = session.fremdevSupport
    tabs = on && session.devTabs && typeof session.devTabs === 'object' ? session.devTabs : {}
    listen(on)
    if (!on) {
      // Off, nothing may be left registered or kept (a crash between the two writes of `stop`).
      await serial(unregister)
      await storage.session.set({ devTabs: {} })
      return
    }
    // The tabs closed or moved away while the worker was stopped lose their rows.
    try {
      const open = new Map((await api.tabs.query({})).map((t) => [String(t.id), t]))
      for (const key of Object.keys(tabs)) {
        const t = open.get(key)
        if (!t || (typeof t.url === 'string' && !isDev(t.url))) delete tabs[key]
      }
    } catch { /* keep them: the next event corrects */ }
    // A hello sent before this finished listed Fremdev off.
    if (support === 'yes') send(protocol.modulesMsg(modules()))
    await sync({ inject: false })
  })().catch(() => undefined).then(() => refresh({ changed: on }))

  return {
    /** Turns Fremdev on (the popup asked for the host permissions first, with the user's click). */
    async start() {
      await loaded
      const saved = await readSaved()
      patterns = cleanPatterns(saved.patterns)
      on = true
      await storage.local.set({ fremdev: { ...saved, on: true } })
      listen(true)
      await sync({ inject: true })
      if (support === 'yes') send(protocol.modulesMsg(modules()))
      refresh({ changed: true })
    },

    /** Turns Fremdev off: no script, no row, and the server hears the module is gone. */
    async stop() {
      await loaded
      const saved = await readSaved()
      on = false
      await storage.local.set({ fremdev: { ...saved, on: false } })
      listen(false)
      await sync({ inject: false })
      tabs = {}
      await storage.session.set({ devTabs: {} })
      if (support === 'yes') send(protocol.modulesMsg(modules()))
      refresh()
    },

    /** The options page changed the patterns: scripts where they now apply, no row where they no longer do. */
    async patternsChanged() {
      await loaded
      patterns = cleanPatterns((await readSaved()).patterns)
      if (!on) return
      for (const tab of Object.values(tabs)) if (!isDev(tab.url)) drop(tab.tabId)
      await sync({ inject: true })
    },

    /** The server's `ready`: whether it speaks Fremdev, for the popup and for what may be sent. */
    onReady(ready) {
      support = fremdevSupport(ready)
      storage.session.set({ fremdevSupport: support }).catch(() => undefined)
      void loaded.then(() => refresh({ changed: on && support === 'yes' }))
    },

    /** `dev.focus` and `dev.clear`: only for a tab this install has a row for. */
    async onServer(msg) {
      await loaded
      if (!on || !validId(msg?.tabId) || !tabs[String(msg.tabId)]) return
      if (msg.type === 'dev.clear') return apply(msg.tabId, { kind: 'clear' })
      if (msg.type !== 'dev.focus') return
      const tab = await api.tabs.get(msg.tabId).catch(() => null)
      if (!tab) return
      await api.tabs.update(tab.id, { active: true }).catch(() => undefined)
      if (validId(tab.windowId)) await api.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
    },

    /**
     * A `dev.event` from a page's relay. Taken only from this extension's content script in the top
     * frame of a tab whose URL is a dev URL; the tab is Chrome's sender, never the message's say.
     */
    async onPageEvent(msg, sender) {
      await loaded
      if (!on || !sender || sender.id !== api.runtime.id || sender.frameId !== 0) return
      const tab = sender.tab
      if (!tab || !validId(tab.id) || !isDev(tab.url)) return
      if (sender.url !== undefined && !isDev(sender.url)) return
      const event = pageEvent(msg)
      if (event) apply(tab.id, event, { url: tab.url, title: tab.title })
    },

    active,
    modules,
  }
}
