// The pure half of the disk map: ring geometry, colours and formatting. No DOM, no Fremkit: the
// server tests load this file on its own (server/test/disk-map-widget.test.ts).
(function (root) {
  'use strict'

  var FULL = 360

  /**
   * Lays out the rings of a view (what the `view` command returns).
   *
   * Angles are in degrees, 0 at the top, clockwise. Each ring splits its parent's span in
   * proportion to size. A segment narrower than `minDegrees` — narrower than a finger — is merged
   * with its siblings into one grey "others" segment. An unreadable folder has no size to measure,
   * so it gets a fixed sliver (`lockDegrees`) drawn hatched, taken from its parent's span.
   *
   * Returns `{ arcs: [{ ring, a0, a1, kind, name, size, path, top, count, more }] }`; `path` is the
   * list of names from the centre, null for an "others" segment; `top` is the index of the
   * first-ring ancestor, which picks the hue.
   */
  function layout(view, opts) {
    opts = opts || {}
    var rings = Math.max(1, Math.min(4, opts.rings || 3))
    var minDeg = opts.minDegrees || 3.5
    var lockDeg = opts.lockDegrees || 4
    var arcs = []
    var total = Math.max(1, Number(view && view.size) || 0)

    function place(node, ring, a0, span, path, top) {
      var children = (node && node.children) || []
      if (!children.length || ring > rings || span <= 0) return
      var locked = children.filter(function (c) { return c.kind === 'x' })
      var readable = children.filter(function (c) { return c.kind !== 'x' })
      // Together they never take more than a sixth of the parent: they say "something is here",
      // not how big it is.
      var lockEach = locked.length ? Math.min(lockDeg, span / 6 / locked.length) : 0
      var readableSpan = span - lockEach * locked.length
      // What this ring is measured against: the node's own size (its subfolders, its files,
      // "others"), so the children of a folder never spill over its span.
      var size = Math.max(1, Number(node.size) || 0, readable.reduce(function (s, c) { return s + (Number(c.size) || 0) }, 0))
      var others = null
      var placed = []
      readable.forEach(function (child) {
        var deg = readableSpan * (Number(child.size) || 0) / size
        if (child.kind === 'o' || deg < minDeg) {
          others = others || { kind: 'o', name: '', size: 0, count: 0, deg: 0 }
          others.size += Number(child.size) || 0
          others.count += child.kind === 'o' ? (Number(child.count) || 0) : 1
          others.deg += deg
          return
        }
        placed.push({ node: child, deg: deg })
      })
      var at = a0
      placed.forEach(function (p, i) {
        var childTop = ring === 1 ? i : top
        var childPath = path.concat([p.node.name])
        arcs.push({ ring: ring, a0: at, a1: at + p.deg, kind: p.node.kind, name: p.node.name, size: Number(p.node.size) || 0,
          path: childPath, top: childTop, count: 0, more: !!p.node.more, unreadable: Number(p.node.unreadable) || 0 })
        place(p.node, ring + 1, at, p.deg, childPath, childTop)
        at += p.deg
      })
      // A sliver of "others" smaller than half a degree cannot be seen or touched: left out.
      if (others && others.deg >= 0.5) {
        arcs.push({ ring: ring, a0: at, a1: at + others.deg, kind: 'o', name: '', size: others.size, path: null,
          top: ring === 1 ? -1 : top, count: others.count, more: false, unreadable: 0 })
        at += others.deg
      }
      // Leave the gap that sizes leave (the folder's own blocks), then the locked slivers at the
      // end of the parent's span.
      var lockAt = a0 + span - lockEach * locked.length
      locked.forEach(function (child) {
        arcs.push({ ring: ring, a0: lockAt, a1: lockAt + lockEach, kind: 'x', name: child.name, size: 0,
          path: path.concat([child.name]), top: ring === 1 ? -1 : top, count: 0, more: false, unreadable: Number(child.unreadable) || 1 })
        lockAt += lockEach
      })
    }

    place(view, 1, 0, FULL * Math.min(1, (Number(view && view.size) || 0) / total), [], -1)
    return { arcs: arcs, rings: rings }
  }

  function point(cx, cy, r, deg) {
    var rad = (deg - 90) * Math.PI / 180
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
  }

  function n(v) { return Math.round(v * 100) / 100 }

  /** The SVG path of one ring segment: between radii r0 < r1, from angle a0 to a1. */
  function arcPath(cx, cy, r0, r1, a0, a1) {
    var span = a1 - a0
    if (span >= 359.99) {
      // A full ring: two half circles, since one arc cannot start and end at the same point.
      return 'M' + n(cx) + ' ' + n(cy - r1) + 'A' + n(r1) + ' ' + n(r1) + ' 0 1 1 ' + n(cx) + ' ' + n(cy + r1)
        + 'A' + n(r1) + ' ' + n(r1) + ' 0 1 1 ' + n(cx) + ' ' + n(cy - r1)
        + 'M' + n(cx) + ' ' + n(cy - r0) + 'A' + n(r0) + ' ' + n(r0) + ' 0 1 0 ' + n(cx) + ' ' + n(cy + r0)
        + 'A' + n(r0) + ' ' + n(r0) + ' 0 1 0 ' + n(cx) + ' ' + n(cy - r0) + 'Z'
    }
    var large = span > 180 ? 1 : 0
    var p0 = point(cx, cy, r1, a0), p1 = point(cx, cy, r1, a1)
    var p2 = point(cx, cy, r0, a1), p3 = point(cx, cy, r0, a0)
    return 'M' + n(p0[0]) + ' ' + n(p0[1])
      + 'A' + n(r1) + ' ' + n(r1) + ' 0 ' + large + ' 1 ' + n(p1[0]) + ' ' + n(p1[1])
      + 'L' + n(p2[0]) + ' ' + n(p2[1])
      + 'A' + n(r0) + ' ' + n(r0) + ' 0 ' + large + ' 0 ' + n(p3[0]) + ' ' + n(p3[1]) + 'Z'
  }

  /** The middle of a segment, for the lock drawn on an unreadable one. */
  function centroid(cx, cy, r0, r1, a0, a1) {
    return point(cx, cy, (r0 + r1) / 2, (a0 + a1) / 2)
  }

  /** `#rgb`, `#rrggbb` or `rgb(r, g, b)` → `[h, s, l]` (degrees, 0–1, 0–1); null when unreadable. */
  function parseColor(value) {
    var s = String(value || '').trim()
    var r, g, b, m
    if ((m = /^#([0-9a-f]{3})$/i.exec(s))) {
      r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16)
    } else if ((m = /^#([0-9a-f]{6})$/i.exec(s))) {
      r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16)
    } else if ((m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s))) {
      r = +m[1]; g = +m[2]; b = +m[3]
    } else {
      return null
    }
    r /= 255; g /= 255; b /= 255
    var max = Math.max(r, g, b), min = Math.min(r, g, b)
    var l = (max + min) / 2
    var h = 0, sat = 0
    if (max !== min) {
      var d = max - min
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      h *= 60
    }
    return [h, sat, l]
  }

  /**
   * The colour of a segment: one hue step per first-ring folder, starting from the accent, each
   * ring further out lighter. `count` is how many first-ring folders share the wheel.
   */
  function colorFor(base, top, ring, count) {
    var hsl = parseColor(base) || [40, 0.6, 0.64]
    var step = Math.min(42, 330 / Math.max(1, count))
    var h = (hsl[0] + step * Math.max(0, top)) % 360
    var s = Math.max(0.35, Math.min(0.85, hsl[1]))
    var l = Math.max(0.3, Math.min(0.62, hsl[2])) + 0.09 * (ring - 1)
    return 'hsl(' + Math.round(h) + ' ' + Math.round(s * 100) + '% ' + Math.round(Math.min(0.86, l) * 100) + '%)'
  }

  var UNITS = { fr: ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'], en: ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] }

  /** Decimal units, as Finder counts them. */
  function formatBytes(bytes, locale) {
    var units = UNITS[locale === 'fr' ? 'fr' : 'en']
    var v = Math.max(0, Number(bytes) || 0)
    var i = 0
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
    var digits = i === 0 || v >= 100 ? 0 : 1
    var text = v.toFixed(digits)
    if (locale === 'fr') text = text.replace('.', ',')
    return text + ' ' + units[i]
  }

  /** "2 h ago" / "il y a 2 h", from a timestamp. */
  function ago(then, now, locale) {
    var s = Math.max(0, Math.round((now - then) / 1000))
    var fr = locale === 'fr'
    if (s < 60) return fr ? 'à l’instant' : 'just now'
    var m = Math.round(s / 60)
    if (m < 60) return fr ? 'il y a ' + m + ' min' : m + ' min ago'
    var h = Math.round(m / 60)
    if (h < 48) return fr ? 'il y a ' + h + ' h' : h + ' h ago'
    var d = Math.round(h / 24)
    return fr ? 'il y a ' + d + ' j' : d + ' d ago'
  }

  root.FremkitSunburst = {
    layout: layout, arcPath: arcPath, centroid: centroid, parseColor: parseColor,
    colorFor: colorFor, formatBytes: formatBytes, ago: ago,
  }
})(globalThis)
