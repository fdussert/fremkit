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
  /** The open ones the user has not marked seen (×). */
  function unseen(tally) {
    var seen = tally && typeof tally.seen === 'number' ? tally.seen : 0
    return Math.max(0, open(tally) - seen)
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

  /**
   * A tab's light as `{ light, seen }`. 'red': an unseen open error or a dev server that does not
   * answer (a server down is never "seen"); 'orange': an unseen open failed request. With nothing
   * unseen, open issues the user marked seen still colour the light, `seen` true (drawn hollow);
   * 'green' only for a page with nothing open since its last load or hot update.
   */
  function stateOfTab(tab) {
    if (!tab) return { light: 'green', seen: false }
    if (unseen(tab.errors) > 0 || tab.server === 'down') return { light: 'red', seen: false }
    if (unseen(tab.requests) > 0) return { light: 'orange', seen: false }
    if (open(tab.errors) > 0) return { light: 'red', seen: true }
    if (open(tab.requests) > 0) return { light: 'orange', seen: true }
    return { light: 'green', seen: false }
  }

  /** The colour alone: 'red', 'orange' or 'green' (see `stateOfTab` for whether it is seen). */
  function lightOf(tab) {
    return stateOfTab(tab).light
  }

  /** Unseen red, unseen orange, seen red, seen orange, green. */
  function groupOf(row) {
    if (row.light === 'green') return 4
    return (row.seen ? 2 : 0) + RANK[row.light]
  }

  /** Whether anything in the tab is open and not yet marked seen: what the × is for. */
  function hasUnseen(tab) {
    return !!tab && (unseen(tab.errors) > 0 || unseen(tab.requests) > 0)
  }

  /**
   * Every dev tab of every install that has Fremdev on, as `{ ...tab, deviceId, browser, light,
   * seen }`: unseen red first, then unseen orange, then the seen rows (red before orange), then
   * green; the latest activity first within a group, then by tab id.
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
        var st = stateOfTab(tab)
        row.light = st.light
        row.seen = st.seen
        rows.push(row)
      })
    })
    rows.sort(function (a, b) {
      return groupOf(a) - groupOf(b) || (b.activity || 0) - (a.activity || 0) || a.tabId - b.tabId
    })
    return rows
  }

  /**
   * The compact form as `{ light, seen, errors }`: the worst unseen colour; with nothing unseen, the
   * worst seen colour, `seen` true; 'green' with neither. `errors`: the unseen open errors.
   */
  function summaryOf(snap) {
    var rows = rowsOf(snap)
    var hot = 'green', dim = 'green', errors = 0
    rows.forEach(function (r) {
      if (r.seen) {
        if (RANK[r.light] < RANK[dim]) dim = r.light
      } else if (RANK[r.light] < RANK[hot]) hot = r.light
      errors += unseen(r.errors)
    })
    if (hot !== 'green') return { light: hot, seen: false, errors: errors }
    if (dim !== 'green') return { light: dim, seen: true, errors: errors }
    return { light: 'green', seen: false, errors: errors }
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

  root.FremkitFremdev = {
    stateOf: stateOf,
    rowsOf: rowsOf,
    lightOf: lightOf,
    stateOfTab: stateOfTab,
    hasUnseen: hasUnseen,
    summaryOf: summaryOf,
    onMac: onMac
  }
})(globalThis)
