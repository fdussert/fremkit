/* Fremkit bridge — injected into every widget. Talks to the dashboard over postMessage. */
(function () {
  'use strict'
  var subs = new Map()        // channel -> Set<cb>
  var pending = new Map()     // id -> { resolve, reject }
  var resizeCbs = new Set()
  var settingsCbs = new Set()
  var localeCbs = new Set()
  var readyCbs = []
  var seq = 0

  function post(msg) { window.parent.postMessage(msg, '*') }

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
    else root.style.removeProperty('--on-surface')
    if (F.accentColor) {
      root.style.setProperty('--accent', F.accentColor)
      // Text on a light accent must be dark: same luminance rule as the host frame.
      root.style.setProperty('--on-accent', onAccent(F.accentColor))
    } else {
      root.style.removeProperty('--accent')
      root.style.removeProperty('--on-accent')
    }
  }

  /** Which cluster of the navigation bar the widget sits in, or null outside the bar. */
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
    sdk: 1,
    instanceId: null,
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
    fetch: function (url, init) {
      var safeInit = init ? { method: init.method, headers: init.headers } : undefined
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
    if (ev.source !== window.parent) return
    var m = ev.data
    if (!m || typeof m.type !== 'string') return
    if (m.type === 'fremkit:init') {
      F.instanceId = m.instanceId
      F.settings = m.settings || {}
      F.size = m.size
      F.showTitle = m.showTitle !== false
      F.compact = m.compact === true
      if (F.compact) document.documentElement.classList.add('compact')
      if (m.locale === 'fr' || m.locale === 'en') F.locale = m.locale
      applyAppearance(m.accentColor, m.accentMode, m.onSurface)
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
  })

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

  window.Fremkit = F
  post({ type: 'fremkit:hello' })
})()
