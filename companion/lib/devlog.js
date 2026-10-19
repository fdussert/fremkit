// What the page's hooks report, made safe to send: bounded text, a path with no query, no noise.

/** The longest error text or request path that leaves the tab. */
export const MAX_TEXT = 300

/** `s` cut to `max` UTF-16 units, never ending on half of a surrogate pair. */
export function clip(s, max) {
  const cut = s.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return cut.length === max && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

// Taken once: errorText reads values with these alone, so a page that replaces them later runs no
// code through it.
const gopd = Object.getOwnPropertyDescriptor
const getProto = Object.getPrototypeOf
const isArray = Array.isArray
const ownKeys = Reflect.ownKeys
const quote = JSON.stringify
const symbolDescription = gopd(Symbol.prototype, 'description').get

// <errorText> This block is copied byte for byte into fremdev/hook.js, which cannot import it
// (server/test/companion-fremdev-scripts.test.ts compares them). It never runs the logged value's
// code: no getter, no toJSON, no toString, no Proxy `get` trap; only own data properties are read,
// through property descriptors, within a depth, an item and a character budget.
const WALK_DEPTH = 2
const WALK_ITEMS = 20
const WALK_PROTOS = 10

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
  if (isErrorLike(o)) {
    const name = dataOf(o, 'name')
    const message = dataOf(o, 'message')
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
    if (shown >= WALK_ITEMS || budget.left <= 0) {
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
