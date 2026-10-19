/**
 * Fremdev's decisions, kept out of index.html so they can be unit tested on their own: which
 * state a `companion:dev` snapshot puts on screen, the colour of each dev tab and the order the
 * rows come in. The colour is decided here and nowhere else: the server sends counters only.
 * A plain script, loaded with a <script> tag in the widget and evaluated against a scope object
 * in the test.
 */
;(function (root) {
  'use strict'

  var RANK = { red: 0, orange: 1, green: 2 }

  function installsOf(snap) {
    return snap && typeof snap === 'object' && Array.isArray(snap.installs) ? snap.installs : []
  }
  function open(tally) {
    return tally && typeof tally.open === 'number' ? tally.open : 0
  }

  /**
   * One of 'loading' (no snapshot yet), 'off' (`labs.companion` off), 'unpaired' (no extension
   * record), 'offline' (no install has said hello since Fremkit started), 'moduleOff' (none listed
   * has Fremdev on), 'empty' (no dev tab open) or 'rows'. A listed install that is not connected is
   * the ordinary idle state: the extension closes its socket while no dev tab is open.
   */
  function stateOf(snap) {
    if (!snap || typeof snap !== 'object') return 'loading'
    if (snap.enabled === false) return 'off'
    if (!(snap.paired > 0)) return 'unpaired'
    var installs = installsOf(snap)
    if (installs.length === 0) return 'offline'
    if (!installs.some(function (i) { return i && i.on })) return 'moduleOff'
    return rowsOf(snap).length === 0 ? 'empty' : 'rows'
  }

  /** 'red': an open error or a dev server that does not answer; 'orange': an open failed request. */
  function lightOf(tab) {
    if (!tab) return 'green'
    if (open(tab.errors) > 0 || tab.server === 'down') return 'red'
    if (open(tab.requests) > 0) return 'orange'
    return 'green'
  }

  /**
   * Every dev tab of every install that has Fremdev on, as `{ ...tab, deviceId, browser, light }`:
   * red first, then orange, then green, the latest activity first within a colour, then by tab id.
   */
  function rowsOf(snap) {
    if (!snap || typeof snap !== 'object' || snap.enabled === false) return []
    var rows = []
    installsOf(snap).forEach(function (install) {
      if (!install || !install.on || !Array.isArray(install.tabs)) return
      install.tabs.forEach(function (tab) {
        var row = {}
        for (var k in tab) if (Object.prototype.hasOwnProperty.call(tab, k)) row[k] = tab[k]
        row.deviceId = install.deviceId
        row.browser = install.name
        row.light = lightOf(tab)
        rows.push(row)
      })
    })
    rows.sort(function (a, b) {
      return RANK[a.light] - RANK[b.light] || (b.activity || 0) - (a.activity || 0) || a.tabId - b.tabId
    })
    return rows
  }

  /** The compact form: the worst colour of all rows ('green' with none) and the open errors. */
  function summaryOf(snap) {
    var rows = rowsOf(snap)
    var light = 'green', errors = 0
    rows.forEach(function (r) {
      if (RANK[r.light] < RANK[light]) light = r.light
      errors += open(r.errors)
    })
    return { light: light, errors: errors }
  }

  /**
   * Whether this frame is drawn on this Mac. A paired device's page comes over the pinned TLS
   * listener (https), this Mac's over plain loopback http, and the frame shares the page's
   * address (the host's `isRemotePage` makes the same test). The hub refuses `companion:dev` to a
   * paired device: there, the widget says where it shows rather than wait for a snapshot.
   * Fremplay asks WebRTC instead; Fremdev gets no WebRTC to ask.
   */
  function onMac(loc) {
    return !!loc && loc.protocol !== 'https:'
  }

  root.FremkitFremdev = { stateOf: stateOf, rowsOf: rowsOf, lightOf: lightOf, summaryOf: summaryOf, onMac: onMac }
})(globalThis)
