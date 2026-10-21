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
  /** The dev servers the extension can open a file through (DEV_SERVERS). */
  var KINDS = { vite: true, next: true, webpack: true }

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
   * One of 'loading' (no snapshot yet), 'off' (`labs.fremdev` or `labs.companion` off), 'unpaired' (no extension
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
   * Every dev tab of every install that has Fremdev on, as `{ ...tab, deviceId, browser, report,
   * features, light, seen }` (`report`: the install can copy a bug report; `features`: the modules
   * its controls depend on, `[]` when it lists none): unseen red first, then unseen orange, then the seen rows (red before orange), then
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
        row.report = install.report === true
        row.features = Array.isArray(install.features) ? install.features.slice() : []
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

  /** Whether the row's install listed the feature `name`: a control that needs it shows only then. */
  function hasFeature(row, name) {
    return !!row && Array.isArray(row.features) && row.features.indexOf(name) !== -1
  }

  /**
   * Whether a tap on the entry's file may ask to open it in the editor: the install listed
   * `fremdev.open`, and the entry is a build entry naming a file under a known dev server (the
   * extension opens nothing for an unknown one), or, under Vite, an error thrown by
   * a script on the page's own origin (`/path:line:col`; another origin's reads `host/path`). The
   * extension decides again from its own copy and builds the URL; this only says what to offer.
   */
  function openable(row, entry) {
    if (!hasFeature(row, 'fremdev.open') || !entry || typeof entry !== 'object') return false
    if (entry.kind === 'build') {
      return KINDS[row.devServer] === true && typeof entry.file === 'string' && entry.file !== ''
    }
    return row.devServer === 'vite' && entry.kind === 'error' && typeof entry.origin === 'string' &&
      entry.origin.charAt(0) === '/' && entry.origin.charAt(1) !== '/'
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

  var STATES = { open: true, seen: true, resolved: true }

  function isPos(v) {
    return typeof v === 'number' && isFinite(v) && v >= 1 && Math.floor(v) === v
  }

  /**
   * One history entry as the unfolded row draws it: `{ kind, time, text, origin, n, state,
   * noAnswer }`. An error keeps its text and origin; a request reads `METHOD path status`, and with
   * status 0 (no answer) the status is left out and `noAnswer` set for the widget to say it in the
   * user's language; a `limited` entry has no text, the widget writes its label around `n`; a
   * `build` entry (the dev server's compile error) keeps its text, its origin its `file:line:col`
   * (`file:line`, or the bare file, when the overlay gave less); a `slow` entry (a request that
   * succeeded in a second or more) reads `METHOD path` and carries its `ms` (null when it is not a
   * number), for the widget to write in seconds; a `perf` entry (a load's regression) carries its
   * `metric` ('load', 'lcp' or 'cls'), its `value` and its `ratio` (null for a "poor" value), for the
   * widget to write, and is null without a known metric and a value. Null for anything else.
   */
  function entryView(entry) {
    if (!entry || typeof entry !== 'object') return null
    var kind = entry.kind
    if (kind !== 'error' && kind !== 'request' && kind !== 'limited' && kind !== 'build' && kind !== 'slow' && kind !== 'perf') return null
    if (kind === 'perf' && (METRICS[entry.metric] !== true || !isNum(entry.value))) return null
    var view = {
      kind: kind,
      time: typeof entry.at === 'number' ? entry.at : 0,
      text: '',
      origin: null,
      n: typeof entry.n === 'number' && entry.n > 0 ? entry.n : 1,
      state: STATES[entry.state] === true ? entry.state : 'open',
      noAnswer: false
    }
    if (kind === 'error') {
      view.text = typeof entry.text === 'string' ? entry.text : ''
      view.origin = typeof entry.origin === 'string' && entry.origin ? entry.origin : null
    } else if (kind === 'build') {
      view.text = typeof entry.text === 'string' ? entry.text : ''
      if (typeof entry.file === 'string' && entry.file) {
        var at = entry.file
        if (isPos(entry.line)) {
          at += ':' + entry.line
          if (isPos(entry.col)) at += ':' + entry.col
        }
        view.origin = at
      }
    } else if (kind === 'request') {
      var parts = [String(entry.method || 'OTHER'), String(entry.path || '')]
      if (entry.status === 0) view.noAnswer = true
      // A status only when it is one: nothing else is written after the path.
      else if (typeof entry.status === 'number' && isFinite(entry.status)) parts.push(String(entry.status))
      view.text = parts.join(' ')
    } else if (kind === 'slow') {
      view.text = String(entry.method || 'OTHER') + ' ' + String(entry.path || '')
      view.ms = typeof entry.ms === 'number' && isFinite(entry.ms) && entry.ms >= 0 ? entry.ms : null
    } else if (kind === 'perf') {
      view.metric = entry.metric
      view.value = entry.value
      view.ratio = isNum(entry.ratio) ? entry.ratio : null
    }
    return view
  }

  /** The metrics a perf entry names. */
  var METRICS = { load: true, lcp: true, cls: true }
  /** A row's values, in the order they are written. */
  var PERF_KEYS = ['load', 'lcp', 'cls', 'longTasks', 'heapMb']
  /** The "poor" Web Vitals bands (LCP_POOR_MS and CLS_POOR in the extension). */
  var LCP_POOR_MS = 4000
  var CLS_POOR = 0.25

  function isNum(v) {
    return typeof v === 'number' && isFinite(v) && v >= 0
  }

  /**
   * A row's performance values as the unfolded row writes them: `[{ key, value, poor, dim }]` in
   * the order load, LCP, CLS, long tasks, heap, for the values there are. `poor`: an LCP over 4 s
   * or a CLS over 0.25, drawn in the danger colour; `dim`: the heap, which Chrome rounds off and
   * refreshes rarely.
   */
  function perfView(perf) {
    var out = []
    if (!perf || typeof perf !== 'object') return out
    PERF_KEYS.forEach(function (key) {
      var v = perf[key]
      if (!isNum(v)) return
      out.push({
        key: key,
        value: v,
        poor: (key === 'lcp' && v > LCP_POOR_MS) || (key === 'cls' && v > CLS_POOR),
        dim: key === 'heapMb'
      })
    })
    return out
  }

  /**
   * What the folded row's requests fact writes beside its count, as `{ perf, neutral }`. A load's
   * regression (`perf` entry) is counted in the requests tally but is no failed request: `perf` is
   * the newest open or seen perf entry's view when the tally has no failed request to show (`last`
   * null), for the widget to write its text; `neutral`: the history holds a perf entry, so the
   * counted items are not all failed requests and the resolved label must not say so.
   */
  function requestsFact(row) {
    var hist = row && Array.isArray(row.history) ? row.history : []
    var perfs = hist.filter(function (e) { return e && e.kind === 'perf' })
    var last = row && row.requests ? row.requests.last : null
    var live = null
    if (!last) {
      for (var i = 0; i < perfs.length && live === null; i++) {
        if (perfs[i].state === 'open' || perfs[i].state === 'seen') live = entryView(perfs[i])
      }
    }
    return { perf: live, neutral: perfs.length > 0 }
  }

  /** The longest thumbnail the server passes on (SHOT_THUMB_MAX). */
  var THUMB_MAX = 40000
  var THUMB_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/

  /**
   * The shot showing on a row, as `{ thumb, until }`, or null: none, or its time is up at `now` (the
   * server clears it then too, a publish later). `thumb` is null unless it is a JPEG data URL of
   * at most THUMB_MAX characters: the row then says "Copied" without a picture.
   */
  function shotOf(row, now) {
    var shot = row && row.shot
    if (!shot || typeof shot !== 'object' || typeof shot.until !== 'number' || !(shot.until > now)) return null
    var thumb = typeof shot.thumb === 'string' && shot.thumb.length <= THUMB_MAX && THUMB_RE.test(shot.thumb) ? shot.thumb : null
    return { thumb: thumb, until: shot.until }
  }

  root.FremkitFremdev = {
    shotOf: shotOf,
    requestsFact: requestsFact,
    entryView: entryView,
    perfView: perfView,
    stateOf: stateOf,
    rowsOf: rowsOf,
    hasFeature: hasFeature,
    openable: openable,
    lightOf: lightOf,
    stateOfTab: stateOfTab,
    hasUnseen: hasUnseen,
    summaryOf: summaryOf,
    onMac: onMac
  }
})(globalThis)
