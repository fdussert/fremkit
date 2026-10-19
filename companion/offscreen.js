// The offscreen document: captures the shared tab (video only, no audio), crops it to the page's
// main video, and sends that picture to each widget frame watching, one RTCPeerConnection each.
// The worker holds the socket and relays the signalling; this document holds the media.

import { loopbackAnswer, offerSdp } from './lib/sdp.js'
import { isOwnContext } from './lib/sender.js'
import { cropRect } from './lib/video.js'

const FPS = 30
const MAX_PEERS = 4
/** How long an offer waits for its host candidates (no trickle: the offer carries them). */
const GATHER_MS = 3_000

const src = document.getElementById('src')
const canvas = document.getElementById('out')
const ctx = canvas.getContext('2d', { alpha: false })

let capture = null
let output = null
/** The video's rectangle in the tab, fractions of the viewport; null holds the last frame. */
let rect = null
let timers = []
let ticking = false
/** Goes up on every `hold`: a tick answered from before it must not bring the old rectangle back. */
let held = 0
/** receiverId → its peer, oldest first. */
const peers = new Map()

const toWorker = (type, extra = {}) => chrome.runtime.sendMessage({ target: 'worker', type, ...extra }).catch(() => null)

function draw() {
  // Video only: with no plausible rectangle nothing is drawn, so the last frame stays.
  const crop = cropRect(rect, src.videoWidth, src.videoHeight)
  if (!crop) return
  if (canvas.width !== crop.w || canvas.height !== crop.h) {
    canvas.width = crop.w
    canvas.height = crop.h
  }
  ctx.drawImage(src, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.w, crop.h)
}

/** Asks the worker where the video is now; it also sends the meta and may end the share. */
async function tick() {
  if (ticking || !capture) return
  ticking = true
  try {
    const before = held
    const res = await toWorker('tick')
    if (res?.stop) stop()
    else if (res && 'rect' in res && held === before) rect = res.rect
  } finally {
    ticking = false
  }
}

async function start(streamId, initialRect) {
  stop()
  capture = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: FPS },
    },
  })
  rect = initialRect ?? null
  src.srcObject = capture
  await src.play()
  draw()
  output = canvas.captureStream(FPS)
  for (const track of output.getVideoTracks()) track.contentHint = 'motion'
  timers.push(setInterval(draw, 1000 / FPS), setInterval(tick, 1000))
  // The tab closed, or the browser ended the capture.
  capture.getVideoTracks()[0].onended = () => {
    stop()
    toWorker('ended')
  }
  return { ok: true }
}

function stop() {
  for (const timer of timers) clearInterval(timer)
  timers = []
  for (const pc of peers.values()) pc.close()
  peers.clear()
  capture?.getTracks().forEach((t) => t.stop())
  output?.getTracks().forEach((t) => t.stop())
  capture = output = rect = null
  src.srcObject = null
}

function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, GATHER_MS)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

function drop(receiverId) {
  const pc = peers.get(receiverId)
  peers.delete(receiverId)
  pc?.close()
}

/** A new peer for a receiver; one it already had is replaced (its frame lost the old one). */
async function view(receiverId) {
  if (!output) return null
  drop(receiverId)
  if (peers.size >= MAX_PEERS) drop(peers.keys().next().value)
  const pc = new RTCPeerConnection({ iceServers: [] })
  peers.set(receiverId, pc)
  for (const track of output.getVideoTracks()) pc.addTrack(track, output)
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' && peers.get(receiverId) === pc) drop(receiverId)
  })
  await pc.setLocalDescription(await pc.createOffer())
  await gathered(pc)
  // Replaced or dropped while gathering: that offer answers nobody.
  if (peers.get(receiverId) !== pc) return null
  // On loopback rather than mDNS names: the widget's WebRTC level dials nothing else (lib/sdp.js).
  return offerSdp(pc.localDescription.sdp)
}

async function answer(receiverId, sdp) {
  const pc = peers.get(receiverId)
  if (pc?.signalingState !== 'have-local-offer' || typeof sdp !== 'string') return
  // Defence in depth only: ICE learns the receiver's address from its incoming checks whatever
  // the answer lists, and a `.local` name resolves to whoever announces it. What keeps the video
  // from a server posing as Fremkit is the socket's challenge proof (lib/handshake.js): an impostor
  // never gets an offer to answer. This drops the answer's candidates that are not loopback or
  // `.local`, and an answer whose `c=` line names another host.
  const filtered = loopbackAnswer(sdp)
  if (filtered === null) {
    // Refused whole: drop the peer so the widget's retry asks for a new one now.
    drop(receiverId)
    return
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: filtered })
}

/** Only the worker talks to this document; no page in a tab does. */
const OWN = { id: chrome.runtime.id, base: chrome.runtime.getURL('') }

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!isOwnContext(sender, OWN) || msg?.target !== 'offscreen') return
  const reply = (promise) => {
    promise.then(respond, (e) => respond({ ok: false, error: String(e?.message ?? e) }))
    return true
  }
  switch (msg.type) {
    case 'start':
      return reply(start(msg.streamId, msg.rect).catch((e) => {
        stop()
        throw e
      }))
    case 'stop':
      stop()
      respond({ ok: true })
      return
    case 'view':
      return reply(view(msg.receiverId).then((sdp) => ({ sdp })))
    case 'answer':
      return reply(answer(msg.receiverId, msg.sdp).then(() => ({ ok: true })))
    case 'detach':
      drop(msg.receiverId)
      respond({ ok: true })
      return
    // The tab is loading another page: draw nothing until the next survey finds the video.
    case 'hold':
      held += 1
      rect = null
      respond({ ok: true })
      return
  }
})
