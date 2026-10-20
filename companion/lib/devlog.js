// What the page's hooks report, made safe to send: bounded text, a path with no query, no noise.

/** The longest error text or request path that leaves the tab. */
export const MAX_TEXT = 300

/** `s` cut to `max` UTF-16 units, never ending on half of a surrogate pair. */
export function clip(s, max) {
  const cut = s.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return cut.length === max && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/**
 * `s` with every home folder written `~/`: `/Users/<name>/` becomes `~/`, whatever the name holds
 * but a slash or a line break (`/Users/Jane Example/` too). What leaves the extension (the wire, the
 * Edge, the report, the popup) goes through this; the extension keeps the full path for itself.
 */
export function homePath(s) {
  return String(s).replace(/\/Users\/[^/\n]+\//g, '~/')
}

// Taken once: errorText reads values with these alone, so a page that replaces them later runs no
// code through it.
const gopd = Object.getOwnPropertyDescriptor
const getProto = Object.getPrototypeOf
const isArray = Array.isArray
const ownKeys = Reflect.ownKeys
const quote = JSON.stringify
const symbolDescription = gopd(Symbol.prototype, 'description').get
// A DOMException's name and message are accessors on its prototype: their native getters, taken now.
const domProto = typeof DOMException === 'function' ? DOMException.prototype : null
const domName = domProto ? gopd(domProto, 'name')?.get : undefined
const domMessage = domProto ? gopd(domProto, 'message')?.get : undefined
const Url = URL
const reflectApply = Reflect.apply
const defineProp = Reflect.defineProperty
const strSlice = String.prototype.slice
const strIndexOf = String.prototype.indexOf
const strCharCodeAt = String.prototype.charCodeAt
const regexpExec = RegExp.prototype.exec
const urlOrigin = gopd(URL.prototype, 'origin').get
const urlHost = gopd(URL.prototype, 'host').get
const urlPathname = gopd(URL.prototype, 'pathname').get
const urlProtocol = gopd(URL.prototype, 'protocol').get

// <errorText> This block is copied byte for byte into fremdev/hook.js, which cannot import it
// (server/test/companion-fremdev-scripts.test.ts compares them). It never runs the logged value's
// code: no getter, no toJSON, no toString, no Proxy `get` trap; only own data properties are read,
// through property descriptors, within a depth, an item and a character budget.
const WALK_DEPTH = 2
const WALK_ITEMS = 20
const WALK_PROTOS = 10
/** Keys looked at in one object, shown or not (non-enumerable ones count too). */
const WALK_KEYS = 50

/** A data property of `o` or of its prototypes; an accessor reads as undefined, unrun. */
function dataOf(o, key) {
  let at = o
  for (let i = 0; i < WALK_PROTOS && at !== null && (typeof at === 'object' || typeof at === 'function'); i++) {
    const d = gopd(at, key)
    if (d) return 'value' in d ? d.value : undefined
    at = getProto(at)
  }
  return undefined
}

/** The name of a function, when it is a plain string. */
function fnName(f) {
  const d = gopd(f, 'name')
  return d && typeof d.value === 'string' ? d.value : ''
}

/** The constructor's name of `o` (`Object`, `Map`, `HTMLDivElement`, a class), from data properties. */
function classOf(o) {
  const ctor = dataOf(o, 'constructor')
  return (typeof ctor === 'function' && fnName(ctor)) || 'Object'
}

function inChain(o, proto) {
  let at = getProto(o)
  for (let i = 0; i < WALK_PROTOS && at !== null; i++) {
    if (at === proto) return true
    at = getProto(at)
  }
  return false
}

/** A native getter called on `o`; undefined when `o` is not what it reads (a brand check throws). */
function nativeText(o, getter) {
  if (typeof getter !== 'function') return undefined
  try {
    const v = reflectApply(getter, o, [])
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

function isErrorLike(o) {
  let at = getProto(o)
  for (let i = 0; i < WALK_PROTOS && at !== null; i++) {
    const d = gopd(at, 'constructor')
    if (d && typeof d.value === 'function' && fnName(d.value) === 'Error') return true
    at = getProto(at)
  }
  return false
}

function walk(v, depth, budget) {
  if (budget.left <= 0) return ''
  let s
  switch (typeof v) {
    case 'string':
      s = depth === 0 ? v : quote(v)
      break
    case 'number':
    case 'boolean':
    case 'undefined':
      // Template conversion: a primitive needs no call, and the page's global String is never run.
      s = `${v}`
      break
    case 'bigint':
      s = `${v}n`
      break
    case 'symbol': {
      const d = reflectApply(symbolDescription, v, [])
      s = `Symbol(${typeof d === 'string' ? d : ''})`
      break
    }
    case 'function': {
      const name = fnName(v)
      s = name ? `[Function: ${name}]` : '[Function]'
      break
    }
    default:
      // An object's leaves and keys were counted as it was walked.
      if (v !== null) return walkObject(v, depth, budget)
      s = 'null'
  }
  budget.left -= s.length
  return s
}

function walkObject(o, depth, budget) {
  const dom = domProto !== null && inChain(o, domProto)
  if (dom || isErrorLike(o)) {
    const name = dom ? nativeText(o, domName) : dataOf(o, 'name')
    const message = dom ? nativeText(o, domMessage) : dataOf(o, 'message')
    const head = typeof name === 'string' && name ? name : 'Error'
    return typeof message === 'string' && message ? `${head}: ${message}` : head
  }
  if (isArray(o)) {
    if (depth >= WALK_DEPTH) return '[Array]'
    const len = gopd(o, 'length')
    const n = len && typeof len.value === 'number' ? len.value : 0
    let out = ''
    let i = 0
    for (; i < n && i < WALK_ITEMS && budget.left > 0; i++) {
      const d = gopd(o, `${i}`)
      out += (i > 0 ? ',' : '') + (!d ? '' : 'value' in d ? walk(d.value, depth + 1, budget) : '[Getter]')
    }
    return `[${out}${i < n ? (i > 0 ? ',…' : '…') : ''}]`
  }
  const name = classOf(o)
  const plain = name === 'Object' || getProto(o) === null
  if (depth >= WALK_DEPTH) return plain ? '{…}' : `[object ${name}]`
  const keys = ownKeys(o)
  let out = ''
  let shown = 0
  let more = false
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k]
    if (typeof key !== 'string') continue
    if (k >= WALK_KEYS || shown >= WALK_ITEMS || budget.left <= 0) {
      more = true
      break
    }
    const d = gopd(o, key)
    if (!d || !d.enumerable) continue
    const value = 'value' in d ? walk(d.value, depth + 1, budget) : '[Getter]'
    budget.left -= key.length + 4
    out += `${shown > 0 ? ',' : ''}${quote(key)}:${value}`
    shown += 1
  }
  if (!plain && shown === 0 && !more) return `[object ${name}]`
  const body = `{${out}${more ? (shown > 0 ? ',…' : '…') : ''}}`
  return plain ? body : `${name} ${body}`
}

/** The arguments of a `console.error` joined the way the console prints them. Never throws. */
function errorText(args) {
  const budget = { left: MAX_TEXT + 1 }
  let out = ''
  try {
    const n = args && typeof args.length === 'number' ? args.length : 0
    for (let i = 0; i < n && budget.left > 0; i++) {
      let part
      try {
        part = walk(args[i], 0, budget)
      } catch {
        part = '[unprintable]'
      }
      out += (i > 0 ? ' ' : '') + part
    }
    return clip(out, MAX_TEXT)
  } catch {
    return ''
  }
}
// </errorText>

export { errorText }

// <frames> This block is copied byte for byte into fremdev/hook.js, like <errorText> above. It reads
// V8's stack text only: no source map is looked up and line numbers stay as Chrome reports them.
// It calls only builtins taken at load and writes lists by definition, never by assignment: a page
// that later puts an accessor on Array.prototype['0'] or replaces String.prototype.slice runs nothing.
/** At most this many frames leave the tab, each this long, and this long joined by newlines. */
const MAX_FRAMES = 10
const MAX_FRAME = 300
const MAX_STACK = 2000
/** A line longer than this is not a frame worth parsing. */
const MAX_LINE = 2000
const FRAME = /^\s+at (?:(.+) \((.+):(\d+):(\d+)\)|(async )?(.+):(\d+):(\d+))$/

/** `clip` with the builtins taken at load. */
function cutText(s, max) {
  const cut = reflectApply(strSlice, s, [0, max])
  const last = reflectApply(strCharCodeAt, cut, [cut.length - 1])
  return cut.length === max && last >= 0xd800 && last <= 0xdbff ? reflectApply(strSlice, cut, [0, -1]) : cut
}

/** Appends `value` to `list` as an own data property: no setter up the chain is called. */
function append(list, value) {
  defineProp(list, list.length, { __proto__: null, value, writable: true, enumerable: true, configurable: true })
}

/** The own data value at `i` in `list`, or undefined. */
function itemOf(list, i) {
  const d = gopd(list, i)
  return d && 'value' in d ? d.value : undefined
}

/** Where a script lives: its path on the page's origin, `host/path` elsewhere, '' when unknown. */
function framePlace(url, pageOrigin) {
  if (typeof url !== 'string' || url === '') return ''
  try {
    const u = new Url(url)
    const protocol = reflectApply(urlProtocol, u, [])
    if (protocol === 'data:' || protocol === 'blob:' || protocol === 'javascript:' || protocol === 'about:') return ''
    const path = reflectApply(urlPathname, u, [])
    const same = reflectApply(urlOrigin, u, []) === pageOrigin
    return cutText(same ? path : `${reflectApply(urlHost, u, [])}${path}`, MAX_FRAME)
  } catch {
    return ''
  }
}

/** Frames clipped one by one, kept while there are no more than MAX_FRAMES and they fit MAX_STACK. */
function boundFrames(frames) {
  const out = []
  let length = 0
  for (let i = 0; i < frames.length && out.length < MAX_FRAMES; i++) {
    const item = itemOf(frames, i)
    if (typeof item !== 'string') break
    const frame = cutText(item, MAX_FRAME)
    const next = length + (out.length > 0 ? 1 : 0) + frame.length
    if (next > MAX_STACK) break
    append(out, frame)
    length = next
  }
  return out
}

/**
 * V8's `at fn (url:line:col)`, `at url:line:col` and `at async url:line:col` lines as
 * `fn place:line:col` (`async place:line:col` for the last); the rest skipped.
 */
function parseStack(stack, pageOrigin) {
  if (typeof stack !== 'string') return []
  const frames = []
  let start = 0
  while (start < stack.length && frames.length < MAX_FRAMES) {
    let end = reflectApply(strIndexOf, stack, ['\n', start])
    if (end < 0) end = stack.length
    const line = reflectApply(strSlice, stack, [start, end])
    start = end + 1
    if (line.length > MAX_LINE) continue
    const m = reflectApply(regexpExec, FRAME, [line])
    if (!m) continue
    const named = itemOf(m, 1) !== undefined
    const fn = named ? itemOf(m, 1) : itemOf(m, 5) !== undefined ? 'async' : ''
    const place = framePlace(itemOf(m, named ? 2 : 6), pageOrigin)
    if (!place) continue
    const at = named ? `${itemOf(m, 3)}:${itemOf(m, 4)}` : `${itemOf(m, 7)}:${itemOf(m, 8)}`
    append(frames, `${fn ? `${fn} ` : ''}${place}:${at}`)
  }
  return boundFrames(frames)
}
// </frames>

export { boundFrames, framePlace, MAX_FRAME, MAX_FRAMES, MAX_STACK, parseStack }

/** The request methods reported as themselves; any other reads `OTHER`. The one list: devtabs.js reads it too. */
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/** A request's method from the closed list, `OTHER` for anything else. */
export function methodOf(m) {
  if (typeof m !== 'string') return 'OTHER'
  const upper = m.toUpperCase()
  return METHODS.includes(upper) ? upper : 'OTHER'
}

const DOWN = ['[vite] server connection lost', '[webpack-dev-server] Disconnected!', '[WDS] Disconnected!']
const UP = [
  '[vite] connected.',
  '[webpack-dev-server] Server started',
  '[webpack-dev-server] Hot Module Replacement enabled',
  '[webpack-dev-server] Live Reloading enabled',
]
const HOT = ['[vite] hot updated:', '[HMR] App is up to date', '[HMR] Updated modules']

/** What a dev server's console line says about it: `down`, `up`, `hot` (a reload landed) or null. */
export function hotReloadSignal(text) {
  if (typeof text !== 'string') return null
  if (DOWN.some((p) => text.startsWith(p))) return 'down'
  if (UP.some((p) => text.startsWith(p))) return 'up'
  if (HOT.some((p) => text.startsWith(p))) return 'hot'
  return null
}

/** The path of a URL, no query and no fragment; `/` when it does not parse. */
export function pathOf(url) {
  try {
    const u = new URL(url)
    // Only the schemes a page requests over; a `data:` URL's payload is not a path.
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return '/'
    return clip(u.pathname, MAX_TEXT) || '/'
  } catch {
    return '/'
  }
}

/** Requests the dev tooling makes for itself, and aborts the page caused: not counted. */
export function isNoise(url, error) {
  if (typeof error === 'string' && error.includes('net::ERR_ABORTED')) return true
  const path = pathOf(url)
  return (
    path.endsWith('/favicon.ico') ||
    path.startsWith('/@vite/') ||
    path === '/__webpack_hmr' ||
    path.startsWith('/sockjs-node/') ||
    path.includes('.hot-update.')
  )
}

/** At most `perSecond` passes in any sliding second; the caller keeps counting what it refuses. */
export class RateLimiter {
  constructor(perSecond = 10, now = Date.now) {
    this.perSecond = perSecond
    this.now = now
    this.passed = []
  }

  allow() {
    const t = this.now()
    while (this.passed.length > 0 && t - this.passed[0] >= 1000) this.passed.shift()
    if (this.passed.length >= this.perSecond) return false
    this.passed.push(t)
    return true
  }
}
