// Fremdev's hook, run in a dev tab's own world (MAIN) before the page's scripts. It reports the
// page's errors and its dev server's console signals to the relay (fremdev/relay.js) and changes
// nothing the page relies on: `console.error` still prints first, errors still propagate (no
// `preventDefault`), `fetch` is not touched, and everything runs inside try/catch. The wrappers keep
// the originals' name and `toString`, and print a logged value without running any of its code.
//
// A classic script, registered with chrome.scripting: no import. What it shares with
// lib/devlog.js is copied, and kept equal by server/test/companion-extension-manifest.test.ts
// (the prefixes) and server/test/companion-fremdev-scripts.test.ts (the <errorText> block).
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

/** `s` cut to `max` UTF-16 units, never ending on half of a surrogate pair. */
function clip(s, max) {
  const cut = s.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return cut.length === max && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
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
    const v = getter.call(o)
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
      s = String(v)
      break
    case 'bigint':
      s = `${String(v)}n`
      break
    case 'symbol': {
      const d = symbolDescription.call(v)
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
      const d = gopd(o, String(i))
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

const signalOf = (text) => {
  if (typeof text !== 'string') return null
  if (DOWN.some((p) => text.startsWith(p))) return 'down'
  if (UP.some((p) => text.startsWith(p))) return 'up'
  if (HOT.some((p) => text.startsWith(p))) return 'hot'
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
const read = (getter, e) => {
  try {
    return getter ? getter.call(e) : undefined
  } catch {
    return undefined
  }
}

const send = (kind, text) => {
  try {
    // Built by hand from primitives, and a null-prototype init: no page code reads either.
    const detail = `{"kind":${quote(kind)}${text === undefined ? '' : `,"text":${quote(text)}`}}`
    dispatch.call(doc, new Custom(EVENT, { __proto__: null, detail }))
  } catch {
    // nothing the page should notice
  }
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
      const result = original.apply(this, args)
      guarded(() => after(args))
      return result
    },
  }[name]
  try {
    defineProperty(wrapper, 'name', { value: fnName(original) || name, configurable: true })
    defineProperty(wrapper, 'toString', {
      value: function toString() {
        return fnToString.call(original)
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
  wrap('error', (args) => send('error', errorText(args)))
  for (const name of ['log', 'info', 'debug']) {
    wrap(name, (args) => {
      const signal = signalOf(args[0])
      if (signal) send(signal)
    })
  }
  listen('error', (e) =>
    guarded(() => {
      const error = read(eventError, e)
      send('error', clip(`Uncaught ${errorText([error ?? read(eventMessage, e)])}`, MAX_TEXT))
    }),
  )
  listen('unhandledrejection', (e) =>
    guarded(() => send('error', clip(`Uncaught (in promise) ${errorText([read(eventReason, e)])}`, MAX_TEXT))),
  )
} catch {
  // a console the page froze: no hook rather than a broken page
}
})()
