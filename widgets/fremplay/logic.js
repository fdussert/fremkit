/**
 * Fremplay's decisions, kept out of index.html so they can be unit tested on their own: which
 * state a `companion` snapshot puts on screen, and what this frame's receiver does next. The page
 * owns the WebRTC peer and the timers; everything it decides with is here. A plain script, loaded
 * with a <script> tag in the widget and evaluated against a scope object in the test.
 */
;(function (root) {
  'use strict'

  /** The companion protocol this widget speaks. */
  var PROTOCOL = 2

  /**
   * One of 'unpaired', 'offline', 'idle', 'sharing' or 'protocol' (the server speaks another
   * protocol than this widget); null before the first snapshot.
   *
   * A share wins over the extension's socket: one that dropped (a server restart) comes back with
   * its share, and the video keeps flowing peer to peer meanwhile.
   */
  function stateOf(snap) {
    if (!snap || typeof snap !== 'object') return null
    if (snap.protocol !== PROTOCOL) return 'protocol'
    var tab = snap.tab || {}
    if (tab.state === 'sharing' && tab.sessionId) return 'sharing'
    var ext = snap.extensions || {}
    if (!(ext.paired > 0)) return 'unpaired'
    if (!(ext.connected > 0)) return 'offline'
    return 'idle'
  }

  /**
   * What the receiver does on a snapshot, given what it holds:
   * `{ receiverId, sessionId, viewed, pending, live, connected, lastOffer, hidden }` — `pending`
   * is a view sent and not yet seen in the snapshot's `receivers`, `connected` a peer whose
   * connection is up.
   *
   * - `hold`: the snapshot shows no share while this frame's peer is still connected. A server
   *   that restarted says so before the extension comes back with its share, and the picture,
   *   which goes peer to peer, never stopped: keep it, and wait for the peer to die or the share
   *   to come back.
   * - `reset`: the share this frame was on is over or replaced; drop the peer and start over.
   * - `answer`: the offer to answer — this receiver's, and not the one it answered last.
   * - `view`: ask the extension for an offer — on a new share, when the receiver has neither a
   *   pending view nor a peer, or when the server does not list it (it restarted). Not on a
   *   direct switch from one share to another: the session asks every receiver it knows itself.
   * - `refused` (set only when true): the server lists this receiver in `tab.refused`, its offer
   *   named more than this Mac. Nothing is answered or asked: asking again gets the same offer.
   *   The frame says so until the share changes, which clears the list.
   *
   * An offer stays in the snapshot after it was answered, so `lastOffer` is kept across a dead
   * peer and only forgotten with the share: a peer that died is replaced by viewing again, never
   * by answering its stale offer a second time.
   */
  function plan(snap, local) {
    var out = { hold: false, reset: false, view: false, answer: null }
    var sharing = stateOf(snap) === 'sharing'
    if (!sharing) {
      if (local.sessionId !== null && local.connected && !local.hidden) out.hold = true
      else out.reset = local.sessionId !== null
      return out
    }
    var reset = snap.tab.sessionId !== local.sessionId
    out.reset = reset
    if (local.hidden) return out
    var offers = snap.tab.offers || {}
    var offer = Object.prototype.hasOwnProperty.call(offers, local.receiverId) ? offers[local.receiverId] : null
    var receivers = Array.isArray(snap.tab.receivers) ? snap.tab.receivers : null
    var known = receivers === null || receivers.indexOf(local.receiverId) >= 0
    var lastOffer = reset ? null : local.lastOffer
    var refused = Array.isArray(snap.tab.refused) && snap.tab.refused.indexOf(local.receiverId) >= 0
    if (refused) {
      out.refused = true
      return out
    }
    if (typeof offer === 'string' && offer !== lastOffer) out.answer = offer
    else if (reset) out.view = !switched(local) || !known
    else if (!local.viewed && !local.live) out.view = true
    else if (!known && !local.pending) out.view = true
    return out
  }

  /** The frame was on another share and in it: the session re-asks it for the new one itself. */
  function switched(local) {
    return local.sessionId !== null && (local.viewed || local.live)
  }

  /** A position in seconds as m:ss, or h:mm:ss from an hour on. */
  function clock(seconds) {
    var total = typeof seconds === 'number' && isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
    var h = Math.floor(total / 3600)
    var m = Math.floor((total % 3600) / 60)
    var s = total % 60
    var ss = (s < 10 ? '0' : '') + s
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss
    return m + ':' + ss
  }

  /** The volume one step away, inside 0..1 and rounded to a tenth. An unknown one counts as full. */
  function stepVolume(volume, step) {
    var v = typeof volume === 'number' && isFinite(volume) ? volume : 1
    return Math.min(1, Math.max(0, Math.round((v + step) * 10) / 10))
  }

  /** How far one press of − or + moves the Mac's level: a wheel notch on the volume widget's knob. */
  var MAC_STEP = 5

  /**
   * What the volume buttons drive: 'mac' when the setting asks for it (the default) and the
   * `volume` provider has a good snapshot, 'video' otherwise. A Mac whose volume cannot be read
   * falls back to the video quietly rather than leaving buttons that do nothing.
   */
  function volumeTarget(setting, volume) {
    if (setting === 'video') return 'video'
    if (!volume || typeof volume !== 'object' || volume.error) return 'video'
    if (typeof volume.level !== 'number' || !isFinite(volume.level)) return 'video'
    return 'mac'
  }

  /** The Mac's level one step away, a whole number inside 0..100. */
  function stepLevel(level, step) {
    var v = typeof level === 'number' && isFinite(level) ? level : 0
    return Math.min(100, Math.max(0, Math.round(v + step)))
  }

  /**
   * Whether this frame can show a share at all: it is drawn on this Mac. The server gives the
   * page WebRTC's `local` level only on a request from this Mac; a paired iPad's copy runs at
   * `none`, where the bridge leaves no `RTCPeerConnection` (server/src/widgets/webrtc.ts), and
   * the `companion` channel is refused to it as well. No peer, no picture: say where it shows.
   * `Peer` is the frame's `RTCPeerConnection`, whatever it is.
   */
  function onMac(Peer) {
    return typeof Peer === 'function'
  }

  root.FremkitFremplay = {
    PROTOCOL: PROTOCOL, MAC_STEP: MAC_STEP, stateOf: stateOf, plan: plan, switched: switched, clock: clock,
    stepVolume: stepVolume, volumeTarget: volumeTarget, stepLevel: stepLevel, onMac: onMac
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
