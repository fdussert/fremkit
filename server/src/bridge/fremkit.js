/* Fremkit bridge — injected into every widget. Talks to the dashboard over postMessage. */

/*
 * WebRTC guard. The first thing that runs in a widget document: the server injects this file
 * ahead of everything the widget wrote (see `injectBridge`), so no widget code has seen the
 * constructors before they are gone.
 *
 * A widget's CSP (`connect-src 'none'`) does not cover WebRTC, and a peer connection is a way out
 * with no permission: a STUN or TURN server, or a remote candidate, carries whatever the widget
 * puts in it. So by default every WebRTC constructor is undefined, non-writable and
 * non-configurable — nothing in the frame can put it back, and child frames, which could hold a
 * fresh copy, are refused by the widget CSP (`frame-src 'none'`).
 *
 * `data-webrtc="local"` on this script's tag is the exception, and only the server writes it, for
 * a built-in widget on its list (`server/src/widgets/webrtc.ts`); a registry widget never gets
 * it. A widget that adds a second copy of this script with the attribute gains nothing: the first
 * copy already removed the originals, and `local` can only narrow what it finds.
 */
;(function () {
  'use strict'
  var defineProperty = Object.defineProperty
  var apply = Reflect.apply
  var construct = Reflect.construct
  var split = String.prototype.split
  var slice = String.prototype.slice
  var lower = String.prototype.toLowerCase
  var NAMES = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']

  var script = typeof document !== 'undefined' ? document.currentScript : null
  var local = !!(script && script.getAttribute && script.getAttribute('data-webrtc') === 'local')
  var Original = local ? window.RTCPeerConnection : undefined
  var Wrapped = local && typeof Original === 'function'
    ? localPeerConnection(Original, script.getAttribute('data-webrtc-hosts') || '')
    : undefined

  for (var i = 0; i < NAMES.length; i++) {
    var name = NAMES[i]
    var value
    if (name === 'RTCPeerConnection' || name === 'webkitRTCPeerConnection') value = Wrapped
    // Inert value classes and a type with no constructor: harmless next to a guarded connection.
    else value = Wrapped ? window[name] : undefined
    try {
      defineProperty(window, name, { value: value, writable: false, configurable: false, enumerable: false })
    } catch (e) { /* already locked by an earlier copy of this script */ }
  }

  /**
   * An `RTCPeerConnection` that can only talk to this Mac.
   *
   * No ICE servers, ever: in the constructor and in `setConfiguration`. Only host candidates on
   * loopback or on one of `hosts` (this Mac's addresses, written by the server): in
   * `addIceCandidate`, in the SDP given to `setRemoteDescription` and to `setLocalDescription`.
   * A data channel rides the same ICE transport, so `createDataChannel` needs nothing of its own.
   *
   * Everything a widget hands in is read once, as a primitive, into a fresh object: a getter or a
   * Proxy cannot answer one thing to the check and another to the browser. The string and
   * reflection helpers used here were captured before the widget ran, so a widget that replaces
   * `String.prototype.split` changes nothing in this closure. The originals are reachable only
   * from it: the prototype's methods and its `constructor` are replaced, non-writable and
   * non-configurable.
   */
  function localPeerConnection(Native, hostList) {
    var proto = Native.prototype
    var allowed = Object.create(null)
    var listed = apply(split, hostList, [' '])
    for (var k = 0; k < listed.length; k++) if (listed[k]) allowed[apply(lower, listed[k], [])] = true

    var setConfiguration = proto.setConfiguration
    var setRemoteDescription = proto.setRemoteDescription
    var setLocalDescription = proto.setLocalDescription
    var addIceCandidate = proto.addIceCandidate

    function str(v) { return typeof v === 'string' ? v : '' }

    function isLoopback(address) {
      if (address === '::1') return true
      var parts = apply(split, address, ['.'])
      return parts.length === 4 && parts[0] === '127'
    }

    /**
     * True for `candidate:… <address> <port> typ host …` naming an allowed address. `own` is a
     * candidate of this side's, which may also be the browser's mDNS name for one of this Mac's
     * interfaces (`<uuid>.local`): it is only text handed to the peer, and the browser that wrote
     * it is the one that answers for it. A remote `.local` name is refused — resolving it asks the
     * whole network, and whoever answers picks where the checks go.
     */
    function candidateAllowed(line, own) {
      var text = line
      if (apply(slice, text, [0, 2]) === 'a=') text = apply(slice, text, [2])
      if (apply(lower, apply(slice, text, [0, 10]), []) !== 'candidate:') return false
      var f = apply(split, text, [' '])
      if (f.length < 8) return false
      for (var n = 0; n < f.length; n++) if (f[n] === '') return false
      if (apply(lower, f[6], []) !== 'typ' || apply(lower, f[7], []) !== 'host') return false
      var address = apply(lower, f[4], [])
      if (own && address.length > 6 && apply(slice, address, [-6]) === '.local') return true
      return allowed[address] === true || isLoopback(address)
    }

    /** The SDP with every `a=candidate` line it may not keep taken out. */
    function filterSdp(sdp, own) {
      var lines = apply(split, sdp, ['\n'])
      var out = ''
      for (var n = 0; n < lines.length; n++) {
        var line = lines[n]
        var bare = apply(slice, line, [-1]) === '\r' ? apply(slice, line, [0, -1]) : line
        var head = apply(lower, apply(slice, bare, [0, 12]), [])
        if (apply(slice, head, [0, 11]) === 'a=candidate' && !candidateAllowed(bare, own)) continue
        if (head === 'a=remote-can') continue
        out += (n > 0 ? '\n' : '') + line
      }
      return out
    }

    function description(desc, own) {
      if (desc === undefined || desc === null) return desc
      return { type: str(desc.type), sdp: filterSdp(str(desc.sdp), own) }
    }

    /** The configuration with no ICE server, whatever was asked; the rest read once. */
    function configuration(config) {
      var safe = { iceServers: [] }
      if (config && typeof config === 'object') {
        var bundle = config.bundlePolicy
        var mux = config.rtcpMuxPolicy
        var pool = config.iceCandidatePoolSize
        var certificates = config.certificates
        if (typeof bundle === 'string') safe.bundlePolicy = bundle
        if (typeof mux === 'string') safe.rtcpMuxPolicy = mux
        if (typeof pool === 'number') safe.iceCandidatePoolSize = pool
        if (certificates !== undefined) safe.certificates = certificates
      }
      return safe
    }

    function RTCPeerConnection(config) {
      if (new.target === undefined) throw new TypeError("Failed to construct 'RTCPeerConnection': Please use the 'new' operator")
      return construct(Native, [configuration(config)])
    }
    var generate = Native.generateCertificate
    if (typeof generate === 'function') {
      defineProperty(RTCPeerConnection, 'generateCertificate', {
        value: function generateCertificate(keygen) { return apply(generate, Native, [keygen]) },
      })
    }
    defineProperty(RTCPeerConnection, 'prototype', { value: proto, writable: false, configurable: false })

    function lock(name, fn) {
      defineProperty(proto, name, { value: fn, writable: false, configurable: false, enumerable: true })
    }
    lock('constructor', RTCPeerConnection)
    lock('setConfiguration', function (config) { return apply(setConfiguration, this, [configuration(config)]) })
    lock('setRemoteDescription', function (desc) { return apply(setRemoteDescription, this, [description(desc, false)]) })
    lock('setLocalDescription', function (desc) {
      return desc === undefined ? apply(setLocalDescription, this, []) : apply(setLocalDescription, this, [description(desc, true)])
    })
    lock('addIceCandidate', function (candidate) {
      if (candidate === undefined || candidate === null) return apply(addIceCandidate, this, [])
      var line = str(candidate.candidate)
      // An empty candidate is the end-of-candidates marker, which reaches no one.
      if (line !== '' && !candidateAllowed(line, false)) return Promise.resolve()
      var init = { candidate: line }
      var mid = candidate.sdpMid
      var index = candidate.sdpMLineIndex
      var ufrag = candidate.usernameFragment
      if (typeof mid === 'string') init.sdpMid = mid
      if (typeof index === 'number') init.sdpMLineIndex = index
      if (typeof ufrag === 'string') init.usernameFragment = ufrag
      return apply(addIceCandidate, this, [init])
    })
    // Not in Chrome or WebKit today; an identity provider would be another server to talk to.
    if ('setIdentityProvider' in proto) lock('setIdentityProvider', function () { throw new TypeError('not available') })
    return RTCPeerConnection
  }
})()

;(function () {
  'use strict'
  // A widget that loads the bridge a second time gets the first one: a second copy would say a
  // second hello, which the host reads as a new document and stops answering.
  if (window.Fremkit) return
  var subs = new Map()        // channel -> Set<cb>
  var pending = new Map()     // id -> { resolve, reject }
  var resizeCbs = new Set()
  var settingsCbs = new Set()
  var localeCbs = new Set()
  var readyCbs = []
  var seq = 0

  /**
   * The host answers this document over a `MessagePort` it hands over in reply to the hello, and
   * only once the port has carried the same nonce back: a port is bound to the document that
   * received it, so a frame that navigates leaves the conversation behind. What the widget sends
   * before the port arrives waits here.
   */
  var port = null
  var outbox = []
  var nonce = makeNonce()

  function makeNonce() {
    var bytes = new Uint8Array(16)
    var c = window.crypto || (typeof crypto !== 'undefined' ? crypto : null)
    if (c && c.getRandomValues) c.getRandomValues(bytes)
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
    var hex = ''
    for (var j = 0; j < bytes.length; j++) hex += (bytes[j] < 16 ? '0' : '') + bytes[j].toString(16)
    return hex
  }

  function post(msg) { if (port) port.postMessage(msg); else outbox.push(msg) }

  /**
   * The host frame paints the tile; a widget follows it through these classes and variables.
   * The per-instance accent is mirrored onto <html> as --accent, so widget CSS written as
   * `var(--accent, #d9b36a)` follows the colour chosen in the admin without any extra code.
   *
   * `onSurface` is the text colour the host computed from the luminance of the body it painted.
   * It arrives as --on-surface, with `on-light` or `on-dark` on <html> saying which way round the
   * tile is, and `accent-fill` when the body *is* the accent — a bar drawn in the accent would
   * then be invisible, so those widgets paint it with --on-surface instead.
   */
  function applyAppearance(accentColor, accentMode, onSurface) {
    F.accentMode = accentMode === 'frame' || accentMode === 'fill' ? accentMode : 'none'
    F.accentColor = accentColor || null
    F.onSurface = onSurface || null
    var root = document.documentElement
    root.classList.remove('on-light', 'on-dark', 'accent-fill')
    // A dark text colour means the surface under it is the light one.
    root.classList.add(isDark(F.onSurface) ? 'on-light' : 'on-dark')
    if (F.accentMode === 'fill') root.classList.add('accent-fill')
    if (F.onSurface) root.style.setProperty('--on-surface', F.onSurface)
    else restoreToken('--on-surface')
    if (F.accentColor) {
      root.style.setProperty('--accent', F.accentColor)
      // Text on a light accent must be dark: same luminance rule as the host frame.
      root.style.setProperty('--on-accent', onAccent(F.accentColor))
    } else {
      restoreToken('--accent')
      restoreToken('--on-accent')
    }
  }

  /**
   * Back to what the theme painted — not to nothing. This runs after `applyTokens` on every
   * appearance message, and most tiles carry no accent of their own, so removing the property
   * here would take the theme's accent away from every widget on the screen and leave each one
   * on the fallback written into its own CSS.
   */
  function restoreToken(name) {
    var root = document.documentElement
    var tokens = F.tokens
    if (tokens && Object.prototype.hasOwnProperty.call(tokens, name)) {
      root.style.setProperty(name, String(tokens[name]))
    } else {
      root.style.removeProperty(name)
    }
  }

  /** Which cluster of the navigation bar the widget sits in, or null outside the bar. */
  /**
   * The theme's design tokens, as custom properties on the widget's own <html>. A widget reads
   * them the way the dashboard does — var(--accent), var(--text-muted), var(--text-scale) — and a
   * widget that reads none of them keeps its own colours. The tile's accent is painted after, so
   * a colour chosen in the admin still wins over the theme.
   */
  function applyTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') return
    var root = document.documentElement
    var previous = F.tokens ? Object.keys(F.tokens) : []
    previous.forEach(function (name) { if (!(name in tokens)) root.style.removeProperty(name) })
    Object.keys(tokens).forEach(function (name) {
      if (/^--[a-z0-9-]+$/.test(name)) root.style.setProperty(name, String(tokens[name]))
    })
    F.tokens = tokens
    applyAppearance(F.accentColor, F.accentMode, F.onSurface)
  }

  function applySlot(slot) {
    F.slot = slot === 'left' || slot === 'right' ? slot : null
    var root = document.documentElement
    root.classList.remove('slot-left', 'slot-right')
    if (F.slot) root.classList.add('slot-' + F.slot)
  }

  /** WCAG relative luminance of a `#rrggbb`, or null when it is not one. */
  function luminance(hex) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '')
    if (!m) return null
    var lin = function (c) { c = parseInt(c, 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3])
  }

  /** White on a dark accent, near-black on a light one (relative luminance, sRGB). */
  function onAccent(hex) {
    var l = luminance(hex)
    // Same threshold as ui/src/shared/color.ts onAccent(): keep the two in step.
    return l !== null && l > 0.45 ? '#0b0d10' : '#fff'
  }

  /** True for a colour dark enough to be text on a light surface. */
  function isDark(hex) {
    var l = luminance(hex)
    return l !== null && l < 0.5
  }

  /** `{name}` placeholders, filled from `params`; an unknown one is left alone. */
  function interpolate(text, params) {
    if (!params) return text
    return text.replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
    })
  }

  function request(msg) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + (++seq)
      pending.set(id, { resolve: resolve, reject: reject })
      msg.id = id
      post(msg)
    })
  }

  var F = {
    ready: false,
    /**
     * The SDK generation this bridge speaks. A widget may branch on it; a manifest declares the
     * lowest generation it needs, and the server refuses to install one asking for more than it
     * has. Kept in step with `SDK_VERSION` in ./sdk.ts by bridge.test.ts.
     */
    sdk: 3,
    instanceId: null,
    /**
     * The id of the screen this frame is drawn on (the Edge, a paired device), or null when the
     * host did not say — a preview in the admin's library, say. Generation 3.
     */
    screen: null,
    settings: {},
    /**
     * The language the dashboard is showing, 'fr' or 'en'. English until the host says otherwise,
     * which it does in the very first message; that matches the fallback order `t()` uses, so a
     * widget that somehow renders before init reads the same way as one that lost a translation.
     */
    locale: 'en',
    /** How much of the tile the accent paints: 'none', 'frame' or 'fill'. */
    accentMode: 'none',
    accentColor: null,
    /** The text colour that reads on the tile's body, also set as --on-surface on <html>. */
    onSurface: null,
    showTitle: true,
    /**
     * True while the widget is drawn inside the navigation bar: the host draws no title and no
     * surface there, so the widget lays itself out as one readable line instead of a tile.
     */
    compact: false,
    /** Which cluster of the navigation bar the widget sits in, or null outside the bar. */
    slot: null,
    size: { w: 0, h: 0, px: { width: 0, height: 0 } },
    whenReady: function (cb) { if (F.ready) cb(); else readyCbs.push(cb) },
    subscribe: function (channel, cb) {
      if (!subs.has(channel)) { subs.set(channel, new Set()); post({ type: 'fremkit:subscribe', channel: channel }) }
      subs.get(channel).add(cb)
      return function () {
        var s = subs.get(channel)
        if (!s || !s.delete(cb) || s.size) return
        // Last listener gone: tell the host, so it stops relaying a channel nobody reads and the
        // provider behind it can stop once no widget is left on it.
        subs.delete(channel)
        post({ type: 'fremkit:unsubscribe', channel: channel })
      }
    },
    sendCommand: function (channel, name, payload) {
      return request({ type: 'fremkit:command', channel: channel, name: name, payload: payload })
    },
    /**
     * Tells the host a finger is working a control in this frame — a slider, a knob — so the page
     * does not swipe for the next half second. Call it on every move. The touch driver turns a
     * quick slide into wheel events at the finger's position; once the finger leaves the frame they
     * land on the dashboard, which would otherwise take the end of the slide for a swipe.
     * Generation 3.
     */
    holdSwipe: function () { post({ type: 'fremkit:hold-swipe' }) },
    /**
     * Fetches through the host.
     *
     * Two shapes. An `https://…` URL goes to a host the manifest declared in
     * `permissions.network`, read-only, as it always has. A `conn:/some/path` goes to the
     * *connection this instance is bound to*: the server resolves which one, adds the
     * credentials, and only makes the requests the manifest declared and the user agreed to.
     *
     * A widget never sees the secret, and never needs to: it does not name a host, a token or a
     * connection. It names a path.
     */
    fetch: function (url, init) {
      var isConn = typeof url === 'string' && url.indexOf('conn:') === 0
      if (isConn && !F.instanceId) {
        // No instance means no connection to resolve, and the answer would be the same after a
        // round trip. Told here so a widget can render "not configured" without a flicker.
        return Promise.reject(new Error('unconfigured'))
      }
      var safeInit = init
        ? (isConn
          ? { method: init.method, headers: init.headers, body: init.body }
          : { method: init.method, headers: init.headers })
        : undefined
      return request({ type: 'fremkit:fetch', url: url, init: safeInit }).then(function (r) {
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: r.headers,
          text: function () { return Promise.resolve(r.body) },
          json: function () { return Promise.resolve(JSON.parse(r.body)) }
        }
      })
    },
    /**
     * The favicon of the site `url` is on, as a `data:` URL to put in an `<img>`; rejects when
     * the site has none the server keeps (an SVG, a private address, a site that is down).
     *
     * Not a URL to fetch: a widget's frame has an opaque origin, so the browser labels an `<img
     * src="/api/favicon…">` from here as cross-site and the server refuses it, like it would from
     * any other page. The host makes the request from its own origin and hands the bytes over.
     */
    favicon: function (url) {
      return request({ type: 'fremkit:favicon', url: url })
    },
    /**
     * The image at exactly `url`, as a `data:` URL, under the same rules as `favicon` (no SVG,
     * no private address). Only an address the user typed into this widget's settings is fetched;
     * anything else rejects. For an icon picked by hand, where the site's own is not the one.
     */
    image: function (url) {
      return request({ type: 'fremkit:image', url: url })
    },
    /**
     * The applications installed on this Mac, as `{ name, bundleId, file }` — enough to name one
     * and to ask for its icon with `appIcon(bundleId)`, and nothing about where it lives.
     *
     * Asked of the host for the same reason as a favicon, one step earlier: a widget's frame is
     * served with `connect-src 'none'`, so a `fetch` from here never leaves the page at all. The
     * host page makes the request from the server's own origin and hands the list over.
     */
    installedApps: function () {
      return request({ type: 'fremkit:apps' })
    },
    /** A local application's icon as a data URL. Requires a Dock subscription. */
    appIcon: function (bundleId) {
      return request({ type: 'fremkit:app-icon', bundleId: bundleId })
    },
    /**
     * Escapes a string for HTML.
     *
     * Almost everything a widget draws is remote data it did not write: a volume name, a calendar
     * title, a printer field, a pull request. Any of them can contain `<img src=x onerror=…>`, so
     * anything going into `innerHTML` goes through here first. `'` and `"` are escaped too, so
     * the result is also safe inside a quoted attribute.
     */
    esc: function (value) {
      return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      })
    },
    /**
     * One element, with an optional class and text. The text is set as `textContent`, so building
     * a tree this way needs no escaping at all — the shortest way to stay out of trouble.
     */
    el: function (tag, className, text) {
      var node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = String(text)
      return node
    },
    /**
     * A `#rrggbb` colour, or `fallback` for anything else.
     *
     * Colours arrive from a connection's settings and end up in a `style` attribute, where
     * `red; background: url(…)` would be two declarations rather than one bad colour. Only the
     * six-digit hex form gets through.
     */
    color: function (value, fallback) {
      return /^#[0-9a-f]{6}$/i.test(String(value === null || value === undefined ? '' : value))
        ? String(value)
        : (fallback === undefined ? null : fallback)
    },
    onResize: function (cb) { resizeCbs.add(cb); return function () { resizeCbs.delete(cb) } },
    /**
     * Called with the new settings whenever the admin edits them, without a reload. A widget
     * that ignores this keeps the settings it got at init until it is mounted again.
     */
    onSettings: function (cb) { settingsCbs.add(cb); return function () { settingsCbs.delete(cb) } },
    /**
     * Translates a `{ fr: '…', en: '…' }` table entry. A missing language falls back to English,
     * then French, then whatever the table does hold, so a half-translated widget still shows
     * words rather than a blank. A plain string is returned as written, which keeps a widget that
     * has only ever had one language working unchanged.
     */
    t: function (dict, params) {
      if (dict === null || dict === undefined) return ''
      if (typeof dict === 'string') return interpolate(dict, params)
      var text = dict[F.locale]
      if (text === undefined) text = dict.en
      if (text === undefined) text = dict.fr
      if (text === undefined) {
        var keys = Object.keys(dict)
        text = keys.length ? String(dict[keys[0]]) : ''
      }
      return interpolate(String(text), params)
    },
    /**
     * Called with the new language whenever the config changes it, without a reload. A widget
     * re-renders whatever it drew with `t()` from here.
     */
    onLocale: function (cb) { localeCbs.add(cb); return function () { localeCbs.delete(cb) } }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent || port) return
    var m = ev.data
    if (!m || m.type !== 'fremkit:connect' || !ev.ports || !ev.ports[0]) return
    port = ev.ports[0]
    port.onmessage = function (e) { onHostMessage(e.data) }
    port.postMessage({ type: 'fremkit:hello', nonce: nonce })
    outbox.splice(0).forEach(function (msg) { port.postMessage(msg) })
  })

  function onHostMessage(m) {
    if (!m || typeof m.type !== 'string') return
    if (m.type === 'fremkit:init') {
      F.instanceId = m.instanceId
      F.screen = typeof m.screen === 'string' ? m.screen : null
      F.settings = m.settings || {}
      F.size = m.size
      F.showTitle = m.showTitle !== false
      F.compact = m.compact === true
      if (F.compact) document.documentElement.classList.add('compact')
      if (m.locale === 'fr' || m.locale === 'en') F.locale = m.locale
      applyAppearance(m.accentColor, m.accentMode, m.onSurface)
      applyTokens(m.tokens)
      applySlot(m.slot)
      F.ready = true
      document.dispatchEvent(new Event('fremkit:ready'))
      readyCbs.splice(0).forEach(function (cb) { cb() })
    } else if (m.type === 'fremkit:data') {
      var s = subs.get(m.channel)
      if (s) s.forEach(function (cb) { try { cb(m.data) } catch (e) { console.error(e) } })
    } else if (m.type === 'fremkit:resize') {
      F.size = m.size
      resizeCbs.forEach(function (cb) { cb(m.size) })
    } else if (m.type === 'fremkit:appearance') {
      applyAppearance(m.accentColor, m.accentMode, m.onSurface)
      applyTokens(m.tokens)
      applySlot(m.slot)
    } else if (m.type === 'fremkit:locale') {
      if (m.locale !== 'fr' && m.locale !== 'en') return
      if (m.locale === F.locale) return
      F.locale = m.locale
      localeCbs.forEach(function (cb) { try { cb(F.locale) } catch (e) { console.error(e) } })
    } else if (m.type === 'fremkit:settings') {
      F.settings = m.settings || {}
      settingsCbs.forEach(function (cb) { try { cb(F.settings) } catch (e) { console.error(e) } })
    } else if (m.type === 'fremkit:result') {
      var p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result)
    }
  }

  /**
   * Makes a widget document stop behaving like a web page.
   *
   * The Edge is a touch panel with no keyboard and no window chrome. A long press inside a
   * widget used to raise WebKit's own context menu — "Open Frame in New Window" — and a drag
   * used to select text or pick an image up. The helper turns those off natively too; this is
   * the same thing for the Chrome kiosk path (scripts/kiosk.sh), and defence in depth either way.
   *
   * A widget with a real text field opts back in with `user-select: text` on it; see
   * docs/writing-widgets.md.
   */
  function applyKioskBehaviour() {
    // The marker guards the whole function: the two listeners below are anonymous, so a second
    // call would add a second pair that nothing can ever take off again.
    if (document.querySelector('style[data-fremkit="kiosk"]')) return
    document.addEventListener('contextmenu', function (e) { e.preventDefault() })
    document.addEventListener('dragstart', function (e) { e.preventDefault() })
    var css = 'html{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;'
      + '-webkit-tap-highlight-color:transparent;cursor:default}'
      + 'img,a{-webkit-user-drag:none}'
      + '::-webkit-scrollbar{display:none}'
      + ':focus{outline:none}'
    var style = document.createElement('style')
    style.setAttribute('data-fremkit', 'kiosk')
    style.textContent = css
    // Before the widget's own <style>, so a widget that wants text selection back can simply
    // say so and win on specificity and order.
    var head = document.head || document.documentElement
    if (head.firstChild) head.insertBefore(style, head.firstChild)
    else head.appendChild(style)
  }

  applyKioskBehaviour()

  Object.defineProperty(window, 'Fremkit', { value: F, writable: false, configurable: false, enumerable: true })
  window.parent.postMessage({ type: 'fremkit:hello', nonce: nonce }, '*')
})()
