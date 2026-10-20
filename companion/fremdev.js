// Fremdev in the service worker: which tabs are dev tabs, what their pages and their requests say,
// and the rows sent to Fremkit as `dev.tabs`. worker.js owns the socket and only wires this in
// (`createFremdev` below).
//
// Permissions: nothing at install. Turning Fremdev on, the popup asks in one click for
// `{ permissions: ['webRequest'], origins: BUILTIN_PERMISSION_ORIGINS + the patterns' }` (a request
// needs the user's gesture, which the worker does not have). Both arrive in `permissions.onAdded`;
// the request listeners are added when `chrome.webRequest` exists, at start (Chrome wakes the
// worker only for listeners added then) and when the permission lands.
//
// A dev tab is one whose URL is a dev URL (lib/devhosts.js) *and* inside an origin the user granted:
// a dev URL alone is not a permission. Where the events come from:
// - the page: fremdev/hook.js (page world) → fremdev/relay.js (isolated world) → `dev.event`,
//   taken only from this extension's own content script in the top frame of a dev tab; beside the
//   relay, fremdev/kind.js tells the dev server's kind from the page's script tags (`devserver`)
//   and fremdev/build.js reads the dev server's compile error overlay (`build`, `build-clear`);
// - the requests: chrome.webRequest, for a tab that has a row; the top frame's own load tells the
//   dev server's state (answered: up; refused: down);
// - navigations and titles: chrome.tabs.onUpdated.
//
// State: `chrome.storage.local.fremdev = { on, patterns }` (the options page edits the patterns),
// `chrome.storage.session.devTabs = { [tabId]: tab }` (stacks dropped) and `chrome.storage.session.fremdevSupport`
// for the popup. Nothing Fremdev is sent unless this socket's `ready` said the server speaks it.

import { BUILTIN_PERMISSION_ORIGINS, FREMKIT_EXCLUDES, inOrigins, isDevUrl, parsePattern } from './lib/devhosts.js'
import { boundFrames, clip, isNoise, MAX_FRAME, MAX_TEXT, methodOf, pathOf } from './lib/devlog.js'
import { buildReport, reportMessage } from './lib/devreport.js'
import { DEV_SERVERS, emptyTab, fremdevSupport, reduce, restoredTabs, sessionTabs, Throttle, validBase, wireTabs } from './lib/devtabs.js'
import * as protocol from './lib/protocol.js'

const RELAY_ID = 'fremdev-relay'
const HOOK_ID = 'fremdev-hook'
const RELAY_JS = 'fremdev/relay.js'
const KIND_JS = 'fremdev/kind.js'
const BUILD_JS = 'fremdev/build.js'
const HOOK_JS = 'fremdev/hook.js'
/** The isolated-world scripts, registered as one and injected together; later features append theirs. */
export const ISOLATED_JS = [RELAY_JS, KIND_JS, BUILD_JS]
/** `dev.tabs` at most this often. */
const SEND_MS = 500
/** Keeps the worker, and so the socket, alive while a dev tab is open; also the cue to reconnect. */
const PING_MS = 20_000
/** How long a turn-on the popup announced (`expectGrant`) may wait for Chrome's prompt. */
const GRANT_MS = 60_000
/** Rows kept here; the wire carries the 32 latest (lib/devtabs.js). */
const MAX_ROWS = 64
const MAX_COUNT = 1_000_000
/** A top-frame load that failed this way: nothing listens where the dev server was. */
const SERVER_GONE = ['net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_EMPTY_RESPONSE']
const REQUEST_FILTER = { urls: ['http://*/*', 'https://*/*'] }

const validId = (id) => Number.isInteger(id) && id >= 0
/** A `dev.report.ask`'s id, which the answer carries back: the server's UUID. */
const REPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The module that says this install answers `dev.report.ask` (FREMDEV_REPORT_MODULE on the server). */
const REPORT_MODULE = 'fremdev.report'
/**
 * The modules of the features a control on the Edge depends on (FREMDEV_FEATURES on the server),
 * announced after the report's while Fremdev is on. Each feature appends its own.
 */
export const FEATURE_MODULES = ['fremdev.build']
const cleanPatterns = (list) =>
  Array.isArray(list) ? [...new Set(list.map((p) => parsePattern(p)?.pattern).filter(Boolean))] : []

/** An error event rebuilt: its text, and its origin and stack when they are bounded strings. */
function errorEvent(msg) {
  const event = { kind: 'error', text: clip(typeof msg.text === 'string' ? msg.text : '', MAX_TEXT) }
  if (typeof msg.origin === 'string' && msg.origin !== '') event.origin = clip(msg.origin, MAX_FRAME)
  if (Array.isArray(msg.stack) && msg.stack.every((f) => typeof f === 'string')) {
    const stack = boundFrames(msg.stack)
    if (stack.length > 0) event.stack = stack
  }
  return event
}

/** The longest file path a build event carries: the overlay's own, before homePath. */
const MAX_FILE = 1024
/** The highest line or column a build event carries. */
const MAX_POS = 10_000_000
const isPos = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_POS

/**
 * A compile error from fremdev/build.js rebuilt: its text clipped, and its file, line and column
 * when given. A field that is there but not one (a file that is no bounded string, a line 0) drops
 * the event: build.js never sends one.
 */
function buildEvent(msg) {
  if (typeof msg.text !== 'string') return null
  const event = { kind: 'build', text: clip(msg.text, MAX_TEXT) }
  if (msg.file !== undefined) {
    if (typeof msg.file !== 'string' || msg.file.length > MAX_FILE) return null
    event.file = msg.file
  }
  for (const key of ['line', 'col']) {
    if (msg[key] === undefined) continue
    if (!isPos(msg[key])) return null
    event[key] = msg[key]
  }
  return event
}

/**
 * The event a page's relay may send, rebuilt from its kind and its bounded fields alone; null for
 * anything else. The tab is never the message's to name.
 */
export function pageEvent(msg) {
  switch (msg?.kind) {
    case 'error':
      return errorEvent(msg)
    case 'count':
      return Number.isInteger(msg.n) && msg.n > 0 ? { kind: 'count', n: Math.min(MAX_COUNT, msg.n) } : null
    case 'up':
    case 'down':
      return { kind: 'server', state: msg.kind }
    case 'hot':
      return { kind: 'hot' }
    case 'build':
      return buildEvent(msg)
    case 'build-clear':
      return { kind: 'build-clear' }
    case 'devserver':
      // null: the page's kind is unknown (kind.js found a Vite base it cannot use). It carries no base.
      if (msg.server === null) return { kind: 'devserver', server: null }
      // A kind from the list, and a base that can only name a path on the tab's own origin.
      if (!DEV_SERVERS.includes(msg.server) || !validBase(msg.base, msg.server)) return null
      return { kind: 'devserver', server: msg.server, base: msg.base }
    default:
      return null
  }
}

/**
 * `send(msg)` hands a message to the greeted socket (false when there is none). `wantSocket()`
 * tells the worker that `active()` may have changed, or that a dev event came in;
 * `wantSocket({ relearn: true })` asks for one connection even though Fremdev does not want the
 * socket, to hear again whether the server speaks Fremdev. The worker throttles both.
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
  // The report's words, in the browser's UI language, and its local time and date.
  t = (key, ...subs) => api.i18n?.getMessage(key, subs.map(String)) || key,
  time = (ms) => new Date(ms).toLocaleTimeString(),
  date = (ms) => new Date(ms).toLocaleString(),
}) {
  let on = false
  let patterns = []
  /** The candidate origins the user granted, refreshed when a permission comes or goes. */
  let granted = []
  /** tabId (as a string key) → tab, lib/devtabs.js's shape. */
  let tabs = {}
  /**
   * What this socket's `ready` said (`fremdevSupport`): null from the moment a socket closes until
   * the next one is greeted, so nothing Fremdev goes out on a stale answer (Fremkit downgraded
   * between two sockets). Every send reads this.
   */
  let support = null
  /**
   * The last answer heard, from any socket and in an earlier worker life too (it is persisted, for
   * the popup's note): whether Fremdev wants the socket at all (`active`). Never a reason to send.
   */
  let known = null
  let tickTimer = null
  let wasActive = false
  /** Until when a grant landing turns Fremdev on: the popup asked, and may have closed on the prompt. */
  let grantUntil = null
  /** The start under way, so a second one (the popup and the grant both) joins it. */
  let starting = null
  const throttle = new Throttle(SEND_MS, now, setTimer)

  const supported = () => known === null || known === 'yes'
  const active = () => on && supported() && Object.keys(tabs).length > 0
  const modules = () => (on ? ['fremplay', 'fremdev', REPORT_MODULE, ...FEATURE_MODULES] : ['fremplay'])
  const isDev = (url) => typeof url === 'string' && isDevUrl(url, patterns) && inOrigins(url, granted)

  function flush() {
    // Without stacks (sessionTabs): a restarted worker gets its rows back, not their stacks.
    storage.session.set({ devTabs: sessionTabs(tabs) }).catch(() => undefined)
    if (support === 'yes' && on) send(protocol.devTabs(wireTabs(Object.values(tabs))))
  }

  /** Every 20 s while active: the keep-alive, and a chance for the socket to come back. */
  function tick() {
    if (support === 'yes') send(protocol.ping())
    wantSocket()
  }

  /** After any change: the rows go out (throttled), the keep-alive and the socket follow `active()`. */
  function refresh({ changed = false, event = false } = {}) {
    if (changed) throttle.push(flush)
    const act = active()
    if (act && tickTimer === null) tickTimer = every(tick, PING_MS)
    if (!act && tickTimer !== null) {
      stopEvery(tickTimer)
      tickTimer = null
    }
    if (act !== wasActive || (act && event)) {
      wasActive = act
      wantSocket()
    } else if (event && on && !supported()) {
      // An older or switched-off Fremkit: a dev event may look again, at the worker's pace.
      wantSocket({ relearn: true })
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

  /** Rows whose tab is no longer a dev tab (a pattern removed, a permission taken back) go. */
  function dropOutside() {
    for (const tab of Object.values(tabs)) if (!isDev(tab.url)) drop(tab.tabId)
  }

  // --- permissions and content scripts ----------------------------------------------------------

  /** The dev origins the user granted: the built-in hosts and the patterns' permissions. */
  async function refreshGranted() {
    const wanted = [...new Set([...BUILTIN_PERMISSION_ORIGINS, ...patterns.flatMap((p) => parsePattern(p)?.permissions ?? [])])]
    const next = []
    for (const origin of wanted) {
      try {
        if (await api.permissions.contains({ origins: [origin] })) next.push(origin)
      } catch { /* not a pattern this browser takes */ }
    }
    granted = next
    return next
  }

  async function unregister() {
    try {
      const existing = await api.scripting.getRegisteredContentScripts({ ids: [RELAY_ID, HOOK_ID] })
      if (existing.length > 0) await api.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) })
    } catch { /* none registered */ }
  }

  /** Registers the isolated-world scripts (the relay first) and the hook on the granted dev origins. */
  async function register() {
    await unregister()
    if (granted.length === 0) return
    const common = {
      matches: granted,
      excludeMatches: FREMKIT_EXCLUDES,
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: true,
    }
    await api.scripting.registerContentScripts([
      { id: RELAY_ID, js: ISOLATED_JS, ...common },
      { id: HOOK_ID, js: [HOOK_JS], world: 'MAIN', ...common },
    ])
  }

  /** The dev tabs already open get the scripts now (each skips itself when it already runs there). */
  async function injectOpen() {
    if (granted.length === 0) return
    let open = []
    try {
      open = await api.tabs.query({ url: granted })
    } catch {
      return
    }
    for (const t of open) {
      if (!validId(t.id) || !isDev(t.url)) continue
      try {
        await api.scripting.executeScript({ target: { tabId: t.id }, files: ISOLATED_JS })
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
  // Turning off unregisters the scripts for the next loads; a page already open keeps its hook
  // until it reloads, and the worker drops whatever it still sends.
  const sync = ({ inject }) =>
    serial(async () => {
      if (!on) return unregister()
      await refreshGranted()
      dropOutside()
      await register()
      if (inject) await injectOpen()
    })

  async function readSaved() {
    const { fremdev: saved } = await storage.local.get('fremdev')
    return saved && typeof saved === 'object' ? saved : {}
  }

  // --- requests (optional permission) ------------------------------------------------------------

  const onRequestDone = (d) => void request(d, d.statusCode)
  const onRequestFailed = (d) => void request(d, 0, d.error)

  async function request(d, status, error) {
    await loaded
    if (!on || !validId(d.tabId)) return
    // Only requests to dev hosts, inside a granted origin: the tab's own checks. A call to another
    // domain, or to Fremkit's ports, is none of Fremdev's business.
    if (!isDev(d.url)) return
    if (d.type === 'main_frame') {
      if (d.frameId !== 0 && d.frameId !== undefined) return
      // The top frame's own load: an answer is the dev server up, a refusal is it gone.
      if (error === undefined) apply(d.tabId, { kind: 'server', state: 'up' }, { url: d.url, title: '' })
      else if (SERVER_GONE.includes(error)) {
        const row = tabs[String(d.tabId)]
        if (row && row.url !== d.url) apply(d.tabId, { kind: 'navigated', url: d.url, title: row.title })
        apply(d.tabId, { kind: 'server', state: 'down' }, { url: d.url, title: '' })
      }
      if (error !== undefined || status < 400) return
    }
    if (!tabs[String(d.tabId)] || (error === undefined && status < 400) || isNoise(d.url, error)) return
    apply(d.tabId, { kind: 'request', method: methodOf(d.method), path: pathOf(d.url), status })
  }

  let listening = false
  /** The request listeners, only while on and only once `chrome.webRequest` exists. */
  function listen(want) {
    const web = api.webRequest
    if (!web) {
      listening = false
      return
    }
    if (want === listening) return
    try {
      if (want) {
        // Only the hosts the extension holds a permission for reach these, whatever the filter says.
        web.onCompleted.addListener(onRequestDone, REQUEST_FILTER)
        web.onErrorOccurred.addListener(onRequestFailed, REQUEST_FILTER)
      } else {
        web.onCompleted.removeListener(onRequestDone)
        web.onErrorOccurred.removeListener(onRequestFailed)
      }
      listening = want
    } catch {
      // Not granted yet: `permissions.onAdded` tries again. Fremdev sees less, nothing breaks.
      listening = false
    }
  }
  listen(true)

  // --- tabs ---------------------------------------------------------------------------------------

  api.tabs.onRemoved.addListener(async (tabId) => {
    await loaded
    drop(tabId)
  })
  api.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    await loaded
    if (!on || !validId(tabId)) return
    const url = typeof info.url === 'string' ? info.url : tab?.url
    const row = tabs[String(tabId)]
    if ((info.url !== undefined || info.status === 'loading') && !isDev(url)) return drop(tabId)
    // A load starting in the tab: a new row, or the same one navigated (a reload resolves its errors).
    if (info.status === 'loading' && typeof url === 'string') {
      if (row) apply(tabId, { kind: 'navigated', url, title: row.title })
      else apply(tabId, { kind: 'server', state: 'up' }, { url, title: tab?.title ?? '' })
    }
    if (typeof info.title === 'string' && tabs[String(tabId)]) apply(tabId, { kind: 'title', title: info.title })
  })

  /** Whether what the popup asks for to turn on is all held: webRequest and every built-in origin. */
  async function holdsTurnOn() {
    try {
      return await api.permissions.contains({ permissions: ['webRequest'], origins: BUILTIN_PERMISSION_ORIGINS })
    } catch {
      return false
    }
  }

  // A dev origin or webRequest granted or taken back (the popup, the options page, Chrome's settings).
  api.permissions.onAdded.addListener(async () => {
    await loaded
    if (!on) {
      // The popup announced a turn-on and Chrome's prompt closed it: the grant is the user's yes.
      if (grantUntil !== null && now() <= grantUntil && (await holdsTurnOn())) await startOnce()
      return
    }
    listen(true)
    await sync({ inject: true })
  })
  api.permissions.onRemoved.addListener(async (removed) => {
    await loaded
    if ((removed?.permissions ?? []).includes('webRequest')) listening = false
    if (on) await sync({ inject: false })
  })

  // --- boot -------------------------------------------------------------------------------------

  const loaded = (async () => {
    const saved = await readSaved()
    const session = await storage.session.get(['devTabs', 'fremdevSupport'])
    on = saved.on === true
    patterns = cleanPatterns(saved.patterns)
    if (known === null && ['yes', 'disabled', 'unsupported'].includes(session.fremdevSupport)) known = session.fremdevSupport
    // Only well-formed rows come back (restoredTabs): the session copy is not trusted to be ours.
    tabs = on ? restoredTabs(session.devTabs) : {}
    listen(on)
    if (!on) {
      // Off, nothing may be left registered or kept (a crash between the two writes of `stop`).
      await serial(unregister)
      await storage.session.set({ devTabs: {} })
      return
    }
    await refreshGranted()
    // The tabs closed or moved away while the worker was stopped lose their rows.
    try {
      const open = new Map((await api.tabs.query({})).map((t) => [String(t.id), t]))
      for (const key of Object.keys(tabs)) {
        const t = open.get(key)
        if (!t || !isDev(typeof t.url === 'string' ? t.url : tabs[key].url)) delete tabs[key]
      }
    } catch { /* keep them: the next event corrects */ }
    // An ordinary restart of the worker: the pages' scripts are still alive, nothing to inject.
    await sync({ inject: false })
  })().catch(() => undefined).then(() => refresh({ changed: on }))

  // Installed, updated or reloaded (chrome://extensions ↻): Chrome orphaned every content script it
  // had injected, so the dev tabs already open get the scripts again and their rows, as at turn-on.
  // The page keeps the previous run's hook, which still dispatches to the new relay; the new hook
  // finds it and stands aside (fremdev/hook.js), so each error is told once. Registered here, while
  // the worker's first task runs: Chrome delivers the event only to a listener added then.
  // A registration that fails here is tried again at the next turn-on, grant or pattern change.
  api.runtime.onInstalled?.addListener(async () => {
    await loaded
    if (on) await sync({ inject: true }).catch(() => undefined)
  })

  async function doStart() {
    await loaded
    grantUntil = null
    if (on) return
    const saved = await readSaved()
    patterns = cleanPatterns(saved.patterns)
    on = true
    await storage.local.set({ fremdev: { ...saved, on: true } })
    listen(true)
    await sync({ inject: true })
    if (support === 'yes') send(protocol.modulesMsg(modules()))
    refresh({ changed: true })
  }

  /** One start at a time, and none while already on. */
  function startOnce() {
    starting ??= doStart().finally(() => {
      starting = null
    })
    return starting
  }

  return {
    /** Turns Fremdev on (the popup asked for webRequest and the host permissions first, with the user's click). */
    start: startOnce,

    /**
     * The popup is about to ask Chrome for Fremdev's permissions. Chrome's prompt may close it before
     * it can say `fremdevOn`, so a grant landing within GRANT_MS turns Fremdev on here.
     */
    expectGrant() {
      grantUntil = now() + GRANT_MS
    },

    /** Turns Fremdev off: no script registered, no row, and the server hears the module is gone. */
    async stop() {
      await loaded
      grantUntil = null
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
      if (on) await sync({ inject: true })
    },

    /**
     * The server's `ready`: whether it speaks Fremdev. Once the boot is done, the modules go first
     * (a hello sent before it listed Fremdev off), then the rows.
     */
    onReady(ready) {
      support = fremdevSupport(ready)
      known = support
      storage.session.set({ fremdevSupport: known }).catch(() => undefined)
      void loaded.then(() => {
        if (support === 'yes' && on) send(protocol.modulesMsg(modules()))
        refresh({ changed: on && support === 'yes' })
        // Whatever the answer, the worker decides whether the socket is still wanted.
        wantSocket()
      })
    },

    /**
     * The socket closed: nothing Fremdev is sent until the next one's `ready` has run `onReady`.
     * The answer stays known (the popup's note, and whether to want a socket), just not trusted.
     */
    socketClosed() {
      support = null
    },

    /**
     * `dev.focus`, `dev.clear` and `dev.report.ask`: only for a tab this install has a row for. A
     * report asked for another tab gets no answer, and the server's wait times out.
     */
    async onServer(msg) {
      await loaded
      if (!on || !validId(msg?.tabId) || !tabs[String(msg.tabId)]) return
      if (msg.type === 'dev.clear') return apply(msg.tabId, { kind: 'clear' })
      if (msg.type === 'dev.report.ask') {
        if (support !== 'yes' || typeof msg.id !== 'string' || !REPORT_ID_RE.test(msg.id)) return
        const fmt = { stack: msg.stack === true, now: now(), t, time, date }
        return void send(reportMessage(msg.id, msg.tabId, tabs[String(msg.tabId)], fmt))
      }
      if (msg.type !== 'dev.focus') return
      const tab = await api.tabs.get(msg.tabId).catch(() => null)
      if (!tab) return
      await api.tabs.update(tab.id, { active: true }).catch(() => undefined)
      if (validId(tab.windowId)) await api.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
    },

    /**
     * A `dev.event` from a page's relay. Taken only from this extension's content script in the top
     * frame of a dev tab; the tab is Chrome's sender, never the message's say.
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

    /** The popup's copy: the report of a tab this install has a row for, or null. */
    async report(tabId, stack) {
      await loaded
      const tab = on && validId(tabId) ? tabs[String(tabId)] : undefined
      return tab ? buildReport(tab, { stack: stack === true, now: now(), t, time, date }) : null
    },

    active,
    modules,
  }
}
