// Fremdev's hook, run in a dev tab's own world (MAIN) before the page's scripts. It reports the
// page's errors and its dev server's console signals to the relay (fremdev/relay.js) and changes
// nothing the page relies on: `console.error` still prints first, errors still propagate (no
// `preventDefault`), `fetch` is not touched, and everything runs inside try/catch. The wrappers keep
// the originals' name and `toString`, and print a logged value without running any of its code.
//
// A classic script, registered with chrome.scripting: no import. What it shares with
// lib/devlog.js is copied, and kept equal by server/test/companion-extension-manifest.test.ts
// (the prefixes) and server/test/companion-fremdev-scripts.test.ts (the <errorText> and <frames>
// blocks).
//
// Transport: a CustomEvent of one fixed type on `document`, its detail a JSON string. Not a
// window `message` (pages' own message handlers would see every one, and some loop or throw on a
// shape they do not expect), and no attribute on <html> (frameworks warn about a hydration
// mismatch). The page can dispatch the same event itself; that only ever lands on its own tab's
// row, as a kind and a bounded text: the worker takes the tab from Chrome, not from the event.

;(() => {
const FLAG = '__fremdevHooked'
try {
  if (Object.getOwnPropertyDescriptor(window, FLAG)) return
  Object.defineProperty(window, FLAG, { value: true, configurable: true, enumerable: false, writable: false })
} catch {
  return
}

const EVENT = '__fremkit_fremdev__'
const MAX_TEXT = 300
const DOWN = ['[vite] server connection lost', '[webpack-dev-server] Disconnected!', '[WDS] Disconnected!']
const UP = [
  '[vite] connected.',
  '[webpack-dev-server] Server started',
  '[webpack-dev-server] Hot Module Replacement enabled',
  '[webpack-dev-server] Live Reloading enabled',
]
const HOT = ['[vite] hot updated:', '[HMR] App is up to date', '[HMR] Updated modules']

/**
 * `s` cut to `max` UTF-16 units, never ending on half of a surrogate pair. Through the
 * String.prototype methods taken at start (cutText, in <frames>): a page that replaces them later
 * runs no code here.
 */
function clip(s, max) {
  return cutText(s, max)
}

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

const strStartsWith = String.prototype.startsWith
const startsWithAny = (text, list) => {
  for (let i = 0; i < list.length; i++) if (reflectApply(strStartsWith, text, [list[i]])) return true
  return false
}
const signalOf = (text) => {
  if (typeof text !== 'string') return null
  if (startsWithAny(text, DOWN)) return 'down'
  if (startsWithAny(text, UP)) return 'up'
  if (startsWithAny(text, HOT)) return 'hot'
  return null
}

// Taken now, before the page can replace them.
const doc = document
const dispatch = EventTarget.prototype.dispatchEvent
const Custom = CustomEvent
const defineProperty = Object.defineProperty
const fnToString = Function.prototype.toString
const listen = window.addEventListener.bind(window)
// The events' own getters, taken now: the page may redefine `error`, `message` or `reason` on the
// prototypes later, and its code must not run from here.
const getterOf = (proto, key) => {
  try {
    const d = proto ? gopd(proto, key) : undefined
    return d && typeof d.get === 'function' ? d.get : undefined
  } catch {
    return undefined
  }
}
const eventError = getterOf(typeof ErrorEvent === 'function' ? ErrorEvent.prototype : null, 'error')
const eventMessage = getterOf(typeof ErrorEvent === 'function' ? ErrorEvent.prototype : null, 'message')
const eventReason = getterOf(typeof PromiseRejectionEvent === 'function' ? PromiseRejectionEvent.prototype : null, 'reason')
const eventFilename = getterOf(typeof ErrorEvent === 'function' ? ErrorEvent.prototype : null, 'filename')
const eventLineno = getterOf(typeof ErrorEvent === 'function' ? ErrorEvent.prototype : null, 'lineno')
const eventColno = getterOf(typeof ErrorEvent === 'function' ? ErrorEvent.prototype : null, 'colno')
const read = (getter, e) => {
  try {
    return getter ? reflectApply(getter, e, []) : undefined
  } catch {
    return undefined
  }
}

// The stack. V8's own `stack` getter and this realm's Error, taken now. The getter formats the
// stack on its first read, and formatting runs page code in three places, so each is checked
// first, by descriptors alone: `Error.prepareStackTrace` (read only while it is absent or a data
// property holding undefined), and the error's `name` and `message`, which the header line reads
// with an ordinary [[Get]] and then converts to a string (read only when the first one found up
// the chain is a data property holding a string or undefined). An own `stack` the page redefined
// is not V8's getter and is never called; a data property (older engines) is read as a value.
const NativeError = Error
const stackGetter = (() => {
  try {
    const d = gopd(new NativeError(), 'stack')
    return d && typeof d.get === 'function' ? d.get : undefined
  } catch {
    return undefined
  }
})()
const loc = location
const pageOrigin = () => {
  try {
    const o = loc.origin
    return typeof o === 'string' ? o : ''
  } catch {
    return ''
  }
}
/** The first `key` up `o`'s chain is a data property whose value V8 turns into text without code. */
const plainField = (o, key) => {
  let at = o
  for (let i = 0; i < WALK_PROTOS && at !== null; i++) {
    const d = gopd(at, key)
    if (d) return 'value' in d && (typeof d.value === 'string' || d.value === undefined)
    at = getProto(at)
  }
  return at === null
}
const formatsQuietly = (error) => {
  const p = gopd(NativeError, 'prepareStackTrace')
  if (p && !('value' in p && p.value === undefined)) return false
  return plainField(error, 'name') && plainField(error, 'message')
}
/** An Error's frames, or [] when it is none or reading them could run the page's code. */
const stackOf = (error) => {
  try {
    if (error === null || typeof error !== 'object' || !isErrorLike(error) || !formatsQuietly(error)) return []
    const d = gopd(error, 'stack')
    let text
    if (d && 'value' in d) text = d.value
    else if (d && stackGetter !== undefined && d.get === stackGetter) text = reflectApply(stackGetter, error, [])
    return typeof text === 'string' ? parseStack(text, pageOrigin()) : []
  } catch {
    return []
  }
}
/** Where an uncaught error's event says it was thrown, when it says so. */
const placeOf = (e) => {
  const file = read(eventFilename, e)
  const line = read(eventLineno, e)
  const col = read(eventColno, e)
  if (typeof file !== 'string' || typeof line !== 'number' || typeof col !== 'number') return undefined
  const where = framePlace(file, pageOrigin())
  return where ? cutText(`${where}:${line}:${col}`, MAX_FRAME) : undefined
}
/** The first Error among a console call's arguments. */
const firstError = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a !== null && typeof a === 'object' && isErrorLike(a)) return a
  }
  return undefined
}

const send = (kind, text, origin, stack) => {
  try {
    // Built by hand from primitives, and a null-prototype init: no page code reads either.
    let detail = `{"kind":${quote(kind)}`
    if (text !== undefined) detail += `,"text":${quote(text)}`
    if (typeof origin === 'string' && origin !== '') detail += `,"origin":${quote(origin)}`
    if (stack !== undefined && stack.length > 0) {
      let list = ''
      for (let i = 0; i < stack.length; i++) list += `${i > 0 ? ',' : ''}${quote(itemOf(stack, i))}`
      detail += `,"stack":[${list}]`
    }
    reflectApply(dispatch, doc, [new Custom(EVENT, { __proto__: null, detail: `${detail}}` })])
  } catch {
    // nothing the page should notice
  }
}
/** An error's text, with the frames of `error` and the first one as its origin, else `place`. */
const sendError = (text, error, place) => {
  const stack = stackOf(error)
  send('error', text, stack.length > 0 ? itemOf(stack, 0) : place, stack)
}

// A value whose inspection logs again (a Proxy trap calling console.error) is not followed.
let busy = false
const guarded = (fn) => {
  if (busy) return
  busy = true
  try {
    fn()
  } catch {
    // the page's own call already ran
  } finally {
    busy = false
  }
}

const wrap = (name, after) => {
  const original = console[name]
  if (typeof original !== 'function') return
  // A method: no `prototype`, `length` 0, like the console's own.
  const wrapper = {
    [name](...args) {
      const result = reflectApply(original, this, args)
      guarded(() => after(args))
      return result
    },
  }[name]
  try {
    defineProperty(wrapper, 'name', { value: fnName(original) || name, configurable: true })
    defineProperty(wrapper, 'toString', {
      value: function toString() {
        return reflectApply(fnToString, original, [])
      },
      configurable: true,
      writable: true,
      enumerable: false,
    })
  } catch {
    // a plain wrapper still works
  }
  console[name] = wrapper
}

try {
  wrap('error', (args) => sendError(errorText(args), firstError(args)))
  for (const name of ['log', 'info', 'debug']) {
    wrap(name, (args) => {
      const signal = signalOf(args[0])
      if (signal) send(signal)
    })
  }
  listen('error', (e) =>
    guarded(() => {
      const error = read(eventError, e)
      sendError(clip(`Uncaught ${errorText([error ?? read(eventMessage, e)])}`, MAX_TEXT), error, placeOf(e))
    }),
  )
  listen('unhandledrejection', (e) =>
    guarded(() => {
      const reason = read(eventReason, e)
      sendError(clip(`Uncaught (in promise) ${errorText([reason])}`, MAX_TEXT), reason)
    }),
  )
} catch {
  // a console the page froze: no hook rather than a broken page
}
})()
