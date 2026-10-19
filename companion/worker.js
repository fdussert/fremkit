// The extension's service worker: pairing, the socket to Fremkit, Fremplay's share (which tab, which
// frame, its meta), the page controls, the shortcut and the badge. The offscreen document holds the
// capture and the peers; it ticks this worker every second, which keeps it alive while sharing and
// wakes it again if Chrome stopped it.
//
// What must survive the worker being stopped is in chrome.storage: the install id, the token and a
// pairing waiting for its code in `local`; the share and the link state in `session`.

import { browserName } from './lib/browser.js'
import { handshake } from './lib/handshake.js'
import { grantToReturn } from './lib/grant.js'
import { closeOutcome, refusalOf } from './lib/link.js'
import { fremplaySwitch } from './lib/errors.js'
import { confirmCode, normalizeCode, pairingDeadline } from './lib/pairProof.js'
import { newNonce } from './lib/proof.js'
import { navigationClearsRect } from './lib/navigation.js'
import { idleDelay } from './lib/presence.js'
import { isOwnContext } from './lib/sender.js'
import * as protocol from './lib/protocol.js'
import { withVolumeHint } from './lib/volume.js'
import { cleanFrames, cleanState, control, embeddedPlayer, pickVideo, survey, youtubeVolume } from './lib/video.js'

/** Fremkit's local server. The extension never talks to anything else. */
const PORT = 4242
const HTTP = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/companion/ws`

const RETRY_FIRST_MS = 1_000
const RETRY_MAX_MS = 30_000
/** After a minute of failures the socket waits for the next click. */
const GIVE_UP_MS = 60_000
/** How long the socket stays open for a popup when nothing is shared. */
const PRESENCE_MS = 30_000
/** A share whose tab has shown no video for this long ends. */
const NO_VIDEO_MS = 10_000
/** How long a start waits for the server's answer. */
const START_TIMEOUT_MS = 8_000
const PAIR_POLL_MS = 1_500
const FLASH_MS = 1_500

const GOLD = '#d9b36a'
const INK = '#0b0d10'
const DANGER = '#d9463f'

/** Mirrors of chrome.storage, loaded once per worker life. */
const local = { installId: null, token: null, deviceId: null, name: null, pairing: null, pairError: null, revoked: false }
const session = { link: 'unpaired', share: null, lastError: null, fremplayOff: false }

const ready = (async () => {
  // The token lives in `local`: only the extension's own pages and this worker may read it, never
  // the code it injects into a page. (`session` is trusted contexts only by default; said again.)
  await Promise.all(['local', 'session'].map(async (area) => {
    try {
      await chrome.storage[area].setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    } catch { /* there since Chrome 102, under the manifest's minimum 116: kept defensively */ }
  }))
  Object.assign(local, await chrome.storage.local.get(Object.keys(local)))
  Object.assign(session, await chrome.storage.session.get(Object.keys(session)))
  if (!local.installId) await saveLocal({ installId: crypto.randomUUID() })
  // A share without its offscreen document did not survive whatever stopped the worker.
  if (session.share && !(await hasOffscreen())) await saveSession({ share: null })
  // And a document left without a share (the worker stopped mid-start) holds a capture nobody sees.
  if (!session.share && (await hasOffscreen())) await chrome.offscreen.closeDocument().catch(() => undefined)
  // A token without its device id cannot open the socket's handshake: pair again. Only an install
  // from before the id was stored has one, and none left this unreleased branch, so no message.
  if (local.token && !local.deviceId) await saveLocal({ token: null })
  if (!local.token) await saveSession({ link: local.revoked ? 'revoked' : 'unpaired' })
  paintBadge()
  if (session.share) connect()
  if (local.pairing) pollPairing()
})()

async function saveLocal(patch) {
  Object.assign(local, patch)
  await chrome.storage.local.set(patch)
}

async function saveSession(patch) {
  Object.assign(session, patch)
  await chrome.storage.session.set(patch)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Chrome throws synchronously on a negative or non-integer tab id, before any promise. */
const validId = (id) => Number.isInteger(id) && id >= 0

// --- badge ------------------------------------------------------------------------------------

let flashText = null

function paintBadge() {
  // While a share waits for the server to come back (a restart), the badge keeps showing it.
  const bang = ['revoked', 'refused', 'impostor'].includes(session.link) || (session.link === 'unreachable' && !session.share)
  const text = flashText ?? (bang ? '!' : session.share ? '▶' : '')
  const alarm = text === '!'
  chrome.action.setBadgeBackgroundColor({ color: alarm ? DANGER : GOLD })
  chrome.action.setBadgeTextColor?.({ color: alarm ? '#ffffff' : INK })
  chrome.action.setBadgeText({ text })
}

function flash(text) {
  flashText = text
  paintBadge()
  setTimeout(() => {
    flashText = null
    paintBadge()
  }, FLASH_MS)
}

async function setLink(link) {
  if (session.link === link) return
  await saveSession({ link })
  paintBadge()
}

// --- pairing ----------------------------------------------------------------------------------

async function pair() {
  await saveLocal({ pairError: null })
  const name = browserName(navigator.userAgentData?.brands)
  // Ours, fresh for each request: K(code) is salted with it as well as the server's request id.
  const salt = newNonce()
  let res
  try {
    res = await fetch(`${HTTP}/api/companion/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, installId: local.installId, salt }),
      cache: 'no-store',
    })
  } catch {
    return saveLocal({ pairError: 'unreachable' })
  }
  // 409: another extension's request waits on the Edge, or the companion is off in Fremkit;
  // 423: pairing locked after too many wrong codes; 429: too many, or refused a moment ago.
  if (res.status === 409 || res.status === 423 || res.status === 429) {
    const reason = (await res.json().catch(() => null))?.reason
    const known = { 409: ['busy', 'disabled'], 423: ['locked'], 429: ['limited', 'cooldown'] }[res.status]
    const fallback = { 409: 'busy', 423: 'locked', 429: 'limited' }[res.status]
    return saveLocal({ pairError: known.includes(reason) ? reason : fallback })
  }
  const body = res.ok ? await res.json().catch(() => null) : null
  // The code is not in the answer: it shows on the Edge only, and the user types it here
  // (lib/pairProof.js). The deadline is the server's, bounded by a request's life.
  const expiresAt = pairingDeadline(body?.expiresAt, Date.now())
  if (typeof body?.requestId !== 'string' || expiresAt === null) return saveLocal({ pairError: 'failed' })
  await saveLocal({ pairing: { requestId: body.requestId, expiresAt, salt }, name })
  pollPairing()
}

let polling = false
/** A typed code being confirmed: one at a time, and the poll does not end the pairing under it. */
let confirming = false

/** Watches for a refusal or the expiry until the code is confirmed. Resumed when the worker restarts. */
async function pollPairing() {
  if (polling) return
  polling = true
  try {
    while (local.pairing) {
      const pending = local.pairing
      if (Date.now() > pending.expiresAt) {
        if (!confirming) return await endPairing('expired')
      } else {
        let answer = null
        try {
          // A POST: Chrome sends no Origin on this extension's GETs to 127.0.0.1, and the server needs it.
          const res = await fetch(`${HTTP}/api/companion/pair/${encodeURIComponent(pending.requestId)}`, { method: 'POST', cache: 'no-store' })
          if (res.ok) answer = await res.json()
        } catch { /* not running yet: keep asking until the code expires */ }
        if (local.pairing?.requestId !== pending.requestId) continue
        // `expired` also follows a confirmation that paired, which ends the pairing itself.
        if (!confirming && (answer?.state === 'refused' || answer?.state === 'expired')) return await endPairing(answer.state)
      }
      // fetch and timers do not keep an MV3 worker alive; an extension API call does, so a
      // refusal is still seen when no popup and no socket are around.
      await chrome.runtime.getPlatformInfo()
      await delay(PAIR_POLL_MS)
    }
  } finally {
    polling = false
  }
}

/**
 * The code the user typed from the Edge: proved to the server, which proves it back with the
 * token, kept only if that proof checks and came in time (lib/pairProof.js). Resolves `{ ok }` or `{ ok: false, error }`.
 */
async function confirmTyped(typed) {
  const pending = local.pairing
  if (!pending || Date.now() > pending.expiresAt) return { ok: false, error: 'expired' }
  // A pairing saved before the salt existed cannot be confirmed: ask again.
  if (typeof pending.salt !== 'string') return { ok: false, error: 'expired' }
  const code = normalizeCode(typed)
  if (!code) return { ok: false, error: 'badCode' }
  if (confirming) return { ok: false, error: 'busy' }
  confirming = true
  try {
    const post = async (step, body) => {
      try {
        const res = await fetch(`${HTTP}/api/companion/pair/${encodeURIComponent(pending.requestId)}/${step}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        })
        return await res.json().catch(() => null)
      } catch {
        return null
      }
    }
    const result = await confirmCode({ post, requestId: pending.requestId, salt: pending.salt, code })
    if (result.state === 'paired') {
      await saveLocal({ token: result.token, deviceId: result.deviceId, pairing: null, pairError: null, revoked: false })
      await setLink('connecting')
      stayFor(PRESENCE_MS)
      connect()
      return { ok: true }
    }
    if (local.pairing?.requestId !== pending.requestId) return { ok: false, error: 'expired' }
    if (result.state === 'wrong') return { ok: false, error: 'wrongCode' }
    // A token without the server's timely proof is not taken: whatever answered is not Fremkit.
    if (['refused', 'expired', 'exhausted', 'impostor'].includes(result.state)) {
      await endPairing(result.state)
      return { ok: false, error: result.state }
    }
    return { ok: false, error: 'failed' }
  } finally {
    confirming = false
  }
}

async function endPairing(why) {
  await saveLocal({ pairing: null, pairError: why })
}

/** Forgets the token. The device record stays in Fremkit until it is removed in the admin. */
async function unpair({ revoked = false } = {}) {
  await endShare({ notify: !revoked })
  closeSocket()
  await saveLocal({ token: null, deviceId: null, pairing: null, pairError: null, revoked })
  await saveSession({ link: revoked ? 'revoked' : 'unpaired' })
  paintBadge()
}

// --- socket -----------------------------------------------------------------------------------

let ws = null
/** True once the server answered hello with `ready`. */
let greeted = false
let retryDelay = RETRY_FIRST_MS
let failingSince = 0
let retryTimer = null
let presenceUntil = 0
let idleTimer = null
const readyWaiters = new Set()

/** The socket is wanted while sharing, and for a while after the popup opened. */
const wanted = () => Boolean(local.token) && (Boolean(session.share) || Date.now() < presenceUntil)

function stayFor(ms) {
  presenceUntil = Math.max(presenceUntil, Date.now() + ms)
  armIdle()
}

/** Closes the socket once nothing wants it; checks again at the end of the presence window. */
function armIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!wanted()) closeSocket()
    // Still wanted by the presence window alone: look again when it ends. A share re-arms this
    // when it ends (`endShare`), so it needs no timer while it runs.
    else if (!session.share) armIdle()
  }, idleDelay(presenceUntil, Date.now()))
}

function send(msg) {
  if (!ws || !greeted) return false
  try {
    ws.send(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}

function connect() {
  if (ws || retryTimer || !local.token || !local.deviceId) return
  // A warning stays up while the next attempts run: they meet it again, or a server that greets.
  if (!['ok', 'impostor', 'refused', 'revoked'].includes(session.link)) setLink('connecting')
  const socket = new WebSocket(WS_URL)
  ws = socket
  greeted = false
  // The server proves it holds this extension's record before the token is sent (lib/handshake.js).
  const opening = handshake({
    socket,
    deviceId: local.deviceId,
    token: local.token,
    hello: () => {
      const share = session.share
      return protocol.hello(local.token, local.installId, share?.accepted ? share : undefined)
    },
    onImpostor: () => impostor(socket),
  })
  socket.onopen = () => opening.open()
  socket.onmessage = (event) => {
    if (ws !== socket) return
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      msg = null
    }
    if (!opening.proven) return void opening.receive(msg)
    if (msg === null) return
    onServerMessage(msg).catch(() => undefined)
  }
  socket.onclose = (event) => {
    opening.cancel()
    if (ws !== socket) return
    const wasGreeted = greeted
    ws = null
    greeted = false
    const outcome = closeOutcome(event.code, { proven: opening.proven, greeted: wasGreeted })
    // The proven server says the record this token named is gone.
    if (outcome === 'revoked') {
      unpair({ revoked: true })
      return
    }
    // The same answer, unproven: shown as removed, but the token stays until a new pairing.
    if (outcome === 'removed') {
      removed()
      return
    }
    // The challenge was not understood: an update is due, unless it was an impostor talking.
    if (outcome === 'refused') {
      refused()
      return
    }
    if (wasGreeted) {
      retryDelay = RETRY_FIRST_MS
      failingSince = 0
    } else setLink('unreachable')
    retry()
  }
}

/**
 * The server on the port did not prove it is this extension's Fremkit: another program holds it.
 * The token was not sent and is kept; the socket closes and the next attempt runs on the backoff.
 */
function impostor(socket) {
  if (ws !== socket) return
  ws = null
  greeted = false
  try {
    socket.close(1000)
  } catch { /* already closed */ }
  setLink('impostor')
  retry()
}

function retry() {
  if (!wanted()) {
    failingSince = 0
    retryDelay = RETRY_FIRST_MS
    return
  }
  const now = Date.now()
  if (!failingSince) failingSince = now
  if (now - failingSince >= GIVE_UP_MS) return giveUp()
  retryTimer = setTimeout(() => {
    retryTimer = null
    connect()
  }, retryDelay)
  retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2)
}

/**
 * The server would not read this extension's challenge: an update is due on one side or the
 * other. Nothing proved who said so, so the attempts go on, on the backoff, within the presence
 * window; a server that answers properly puts the link back to `ok`.
 */
async function refused() {
  for (const waiter of readyWaiters) waiter(false)
  readyWaiters.clear()
  await setLink('refused')
  if (session.share) await endShare({ notify: false, error: 'protocol' })
  retry()
}

/**
 * A 4401 before any proof: the real server's answer for a removed record, or anything holding the
 * port. The extension shows itself removed and offers Connect, but keeps its token: a new pairing
 * overwrites it, and a server that proves itself and greets it clears this (`ready`).
 */
async function removed() {
  failingSince = 0
  retryDelay = RETRY_FIRST_MS
  presenceUntil = 0
  for (const waiter of readyWaiters) waiter(false)
  readyWaiters.clear()
  if (session.share) await endShare({ notify: false })
  await saveLocal({ revoked: true })
  await saveSession({ link: 'revoked' })
  paintBadge()
}

/** No server for a minute: stop trying until the next click, and end a share nobody can see. */
async function giveUp() {
  failingSince = 0
  retryDelay = RETRY_FIRST_MS
  presenceUntil = 0
  for (const waiter of readyWaiters) waiter(false)
  readyWaiters.clear()
  // The last thing heard was an impostor or a refusal: that is still what the user needs to know.
  await setLink(['impostor', 'refused'].includes(session.link) ? session.link : 'unreachable')
  if (session.share) await endShare({ notify: false, error: 'unreachable' })
}

function closeSocket() {
  clearTimeout(retryTimer)
  retryTimer = null
  failingSince = 0
  retryDelay = RETRY_FIRST_MS
  const socket = ws
  ws = null
  greeted = false
  try {
    socket?.close(1000)
  } catch { /* already closed */ }
}

/** Opens the socket now, even after a give-up: a click is a reason to try again. */
function reconnectNow(ms = PRESENCE_MS) {
  if (!local.token) return
  stayFor(ms)
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  connect()
}

/** Resolves true once the socket is greeted, false when the server stays unreachable. */
function whenGreeted(timeoutMs) {
  if (greeted) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer)
      readyWaiters.delete(done)
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    readyWaiters.add(done)
  })
}

// --- Fremplay ---------------------------------------------------------------------------------

/** sessionId → resolver of the start waiting for the server's answer. */
const decisions = new Map()
let lastVideoAt = 0

async function onServerMessage(msg) {
  const share = session.share
  switch (msg.type) {
    case 'ready':
      greeted = true
      // A proven server greeted this token: an unproven 4401 before was not its word.
      if (local.revoked) await saveLocal({ revoked: false })
      // Whether Fremkit has Fremplay on (`labs.companion`), for the popup to say before a click.
      // Sent again when the switch turns; a server that does not say is taken as on.
      {
        const off = msg.modules?.fremplay === false
        const patch = fremplaySwitch(session, off)
        if (patch) await saveSession(patch)
      }
      failingSince = 0
      retryDelay = RETRY_FIRST_MS
      await setLink('ok')
      for (const waiter of readyWaiters) waiter(true)
      readyWaiters.clear()
      // A start that was waiting on the socket (or lost it before the answer) announces itself now.
      if (share && !share.accepted) send(protocol.started(share.sessionId, share.meta))
      return
    case 'tab.accepted':
      if (share?.sessionId !== msg.sessionId) return
      share.accepted = true
      await saveSession({ share, lastError: null })
      decide(msg.sessionId, { ok: true })
      return
    case 'tab.refused': {
      if (share?.sessionId !== msg.sessionId) return
      const refusal = refusalOf(msg.reason)
      if (refusal.error === 'disabled') await saveSession({ fremplayOff: true })
      if (refusal.endShare) return endShare({ notify: false, error: refusal.error })
      // One receiver's offer refused (lib/link.js): its peer goes, with no new offer; the badge
      // flashes and the popup says why next time it opens (not "update needed").
      if (typeof msg.receiverId === 'string') await toOffscreen('detach', { receiverId: msg.receiverId })
      await saveSession({ lastError: refusal.error })
      flash('!')
      return
    }
    case 'tab.stop':
      return endShare({ notify: false })
    case 'revoked':
      return unpair({ revoked: true })
    case 'tab.view':
      if (!share?.accepted || typeof msg.receiverId !== 'string') return
      // A known receiver asking again means its peer is gone: the offscreen document replaces it.
      {
        const res = await toOffscreen('view', { receiverId: msg.receiverId })
        if (res?.sdp && session.share?.sessionId === share.sessionId) {
          send(protocol.offer(share.sessionId, msg.receiverId, res.sdp))
        }
      }
      return
    case 'tab.answer':
      if (share?.accepted) await toOffscreen('answer', { receiverId: msg.receiverId, sdp: msg.sdp })
      return
    case 'tab.detach':
      if (share) await toOffscreen('detach', { receiverId: msg.receiverId })
      return
    case 'tab.control':
      return onControl(msg)
  }
}

function decide(sessionId, result) {
  const resolve = decisions.get(sessionId)
  decisions.delete(sessionId)
  resolve?.(result)
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  return contexts.length > 0
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'WEB_RTC'],
      justification: "Crops the shared tab to its video and sends it to Fremkit's dashboard on this Mac.",
    })
  } catch (e) {
    // Two starts at once: the other one created it.
    if (!(await hasOffscreen())) throw e
  }
}

function toOffscreen(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...extra }).catch(() => null)
}

/**
 * Survey every frame of a tab, in the extension's isolated world, each report checked and bounded.
 * Null when the browser does not let the extension in.
 */
async function surveyTab(tabId) {
  try {
    return cleanFrames(await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: survey }))
  } catch {
    return null
  }
}

/**
 * Runs a control (or just reads the state, for `null`) on the shared video, in its frame, in the
 * isolated world. Volume and mute try YouTube's player first, the one call made in the page's own
 * world (`youtubeVolume`), whose only answer heard is whether it took it.
 */
async function runControl(share, action, args = null) {
  const target = { tabId: share.tabId, frameIds: [share.frameId] }
  try {
    if (action === 'volume' || action === 'mute') {
      const [yt] = await chrome.scripting.executeScript({
        target, world: 'MAIN', func: youtubeVolume, args: [action, action === 'volume' ? args?.value : null],
      })
      if (yt?.result === true) {
        if (action === 'volume') share.volumeHint = null
        const state = await runControl(share, null)
        // YouTube scales the element's volume by its loudness normalisation: show what was set.
        if (state && action === 'volume') {
          share.volumeHint = { element: state.volume, value: Math.min(1, Math.max(0, Number(args?.value) || 0)) }
          state.volume = share.volumeHint.value
        }
        return state
      }
    }
    const [res] = await chrome.scripting.executeScript({ target, func: control, args: [action, args] })
    return withVolumeHint(share, cleanState(res?.result))
  } catch {
    return null
  }
}

/** The tab's URL and title, as Chrome reports them while the extension holds the tab's grant. */
async function tabInfo(tabId) {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return null
  }
}

/** The meta the server is sent: the page's state, the tab's title, the host from the tab's URL. */
function metaOf(previous, state, tab, frames) {
  const topTitle = frames?.find((f) => f.result?.top)?.result?.title
  return {
    ...(previous ?? { paused: true, currentTime: 0, duration: 0, volume: 1, muted: false }),
    ...(state ?? {}),
    title: tab?.title || topTitle || previous?.title || '',
    host: tab?.url ? protocol.hostOf(tab.url) : (previous?.host ?? 'unknown'),
  }
}

/**
 * Starts sharing a tab's main video, replacing any running share. From the popup or the shortcut,
 * both of which gave the extension this tab's grant. `grantedOrigin` is a player's origin the user
 * has just allowed from the popup. Resolves `{ ok }` or `{ ok: false, error }`.
 */
async function start(tabId, { fromShortcut = false, grantedOrigin = null } = {}) {
  const seen = { frames: null }
  let result = { ok: false, error: 'failed' }
  try {
    result = await startShare(tabId, { fromShortcut }, seen)
    return result
  } finally {
    // Whatever way the start ended: a grant it did not use goes back (lib/grant.js).
    await giveBack(grantToReturn(grantedOrigin, { ok: result.ok, frames: seen.frames }))
  }
}

/** Takes back the host permission of `origin`; nothing for null. */
async function giveBack(origin) {
  if (origin) await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => undefined)
}

/** The start itself; `seen.frames` gets the survey it ran on, for `start` to judge the grant. */
async function startShare(tabId, { fromShortcut }, seen) {
  await ready
  if (!local.token || local.revoked) return { ok: false, error: 'unpaired' }
  if (!validId(tabId)) return { ok: false, error: 'failed' }
  // Fremkit said Fremplay is off on this very socket: no capture to start for a sure refusal.
  // Without a live socket the server answers `disabled` itself.
  if (greeted && session.fremplayOff) return { ok: false, error: 'disabled' }
  const frames = await surveyTab(tabId)
  if (!frames) return { ok: false, error: 'capture' }
  seen.frames = frames
  const picked = pickVideo(frames)
  // A player in another site's iframe needs that site's permission, which only the popup can ask for.
  if (fromShortcut && embeddedPlayer(frames, picked)) return { ok: false, error: 'needsPermission' }
  if (!picked) return { ok: false, error: 'noVideo' }
  const tab = await tabInfo(tabId)
  if (!tab) return { ok: false, error: 'failed' }

  reconnectNow()
  let streamId
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
  } catch {
    return { ok: false, error: 'capture' }
  }
  try {
    await ensureOffscreen()
  } catch {
    return { ok: false, error: 'capture' }
  }
  const previous = session.share
  // The offscreen document drops the previous capture and its peers. The server swaps the share
  // when the new one starts, and asks again for every receiver, so nothing is sent for the old one.
  const res = await toOffscreen('start', { streamId, rect: picked.rect })
  if (!res?.ok) {
    if (session.share) await endShare({ notify: true })
    else await chrome.offscreen.closeDocument().catch(() => undefined)
    return { ok: false, error: 'capture' }
  }
  const share = {
    tabId,
    windowId: tab.windowId,
    frameId: picked.frameId,
    sessionId: crypto.randomUUID(),
    rect: picked.rect,
    accepted: false,
    meta: null,
  }
  share.meta = metaOf(null, await runControl(share, null), tab, frames)
  lastVideoAt = Date.now()
  const decision = new Promise((resolve) => decisions.set(share.sessionId, resolve))
  await saveSession({ share, lastError: null })
  paintBadge()
  if (greeted) send(protocol.started(share.sessionId, share.meta))
  // Otherwise `ready` announces it.

  const result = await Promise.race([
    decision,
    whenGreeted(START_TIMEOUT_MS).then((ok) => (ok ? new Promise(() => {}) : { ok: false, error: 'unreachable' })),
    delay(START_TIMEOUT_MS).then(() => ({ ok: false, error: greeted ? 'failed' : 'unreachable' })),
  ])
  decisions.delete(share.sessionId)
  if (!result.ok && session.share?.sessionId === share.sessionId) {
    await endShare({ notify: greeted, error: result.error })
  }
  // The share this one was to replace is gone with the capture: the server hears it from here.
  if (!result.ok && previous?.accepted) send(protocol.stopped(previous.sessionId))
  if (!result.ok && result.error === 'unreachable') await setLink('unreachable')
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

/** Ends the share: the capture, the peers and the badge. `notify` tells the server. */
async function endShare({ notify, error = null }) {
  const share = session.share
  if (!share) return
  if (notify) send(protocol.stopped(share.sessionId))
  await saveSession({ share: null, ...(error ? { lastError: error } : {}) })
  decide(share.sessionId, { ok: false, error: error ?? 'failed' })
  paintBadge()
  await toOffscreen('stop')
  await chrome.offscreen.closeDocument().catch(() => undefined)
  stayFor(0)
}

/** Every second, from the offscreen document: where the video is now, and the meta for the server. */
async function tick() {
  await ready
  const share = session.share
  if (!share) return { stop: true }
  if (!ws && !retryTimer) connect()
  const frames = await surveyTab(share.tabId)
  const picked = frames ? pickVideo(frames) : null
  const now = Date.now()
  if (picked) {
    lastVideoAt = now
    share.frameId = picked.frameId
    share.rect = picked.rect
    share.meta = metaOf(share.meta, await runControl(share, null), await tabInfo(share.tabId), frames)
  } else {
    // Video only: no rectangle holds the last frame, and a tab without a video for long ends the share.
    share.rect = null
    if (now - (lastVideoAt || now) >= NO_VIDEO_MS) {
      await endShare({ notify: true, error: 'noVideoLeft' })
      return { stop: true }
    }
    if (!lastVideoAt) lastVideoAt = now
  }
  if (session.share?.sessionId !== share.sessionId) return { stop: true }
  await saveSession({ share })
  if (share.accepted) send(protocol.meta(share.sessionId, share.meta))
  return { rect: share.rect }
}

async function onControl(c) {
  const share = session.share
  if (!share?.accepted) return
  if (c.action === 'stop') return endShare({ notify: true })
  if (c.action === 'show') {
    if (!validId(share.tabId)) return
    const tab = await tabInfo(share.tabId)
    if (!tab) return
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined)
    if (validId(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
    return
  }
  const args = c.action === 'seek' ? { delta: c.delta } : c.action === 'volume' ? { value: c.value } : null
  const state = await runControl(share, c.action, args)
  if (!state || session.share?.sessionId !== share.sessionId) return
  share.meta = metaOf(share.meta, state, null, null)
  await saveSession({ share })
  send(protocol.meta(share.sessionId, share.meta))
}

// --- events -----------------------------------------------------------------------------------

const FLASHES = { noVideo: '∅' }

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fremplay-toggle') return
  await ready
  if (!tab || !validId(tab.id)) return
  if (session.share?.tabId === tab.id) return endShare({ notify: true })
  const res = await start(tab.id, { fromShortcut: true })
  if (res.ok) return
  if (res.error !== 'noVideo') await saveSession({ lastError: res.error })
  flash(FLASHES[res.error] ?? '!')
})

// The shared tab navigates: stop cropping the old rectangle out of the new page (lib/navigation.js).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await ready
  const share = session.share
  if (!navigationClearsRect(share, tabId, changeInfo)) return
  share.rect = null
  await saveSession({ share })
  await toOffscreen('hold')
})

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready
  if (session.share?.tabId === tabId) await endShare({ notify: true })
})

// A player origin granted from the popup. The popup may have closed when the browser asked, so the
// worker starts the share it was asked for.
let awaitingGrant = null

chrome.permissions.onAdded.addListener(async (permissions) => {
  const pending = awaitingGrant
  if (!pending || Date.now() > pending.until) return
  if (!(permissions.origins ?? []).includes(`${pending.origin}/*`)) return
  awaitingGrant = null
  await start(pending.tabId, { grantedOrigin: pending.origin }).then(async (res) => {
    if (!res.ok) await saveSession({ lastError: res.error })
  })
})

/** The popup and the offscreen document, plus the options page, which opens in a tab. */
const OWN = { id: chrome.runtime.id, base: chrome.runtime.getURL(''), tabPages: [chrome.runtime.getURL('options.html')] }

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!isOwnContext(sender, OWN) || msg?.target !== 'worker') return
  const reply = (promise) => {
    promise.then(respond, (e) => respond({ ok: false, error: 'failed', detail: String(e?.message ?? e) }))
    return true
  }
  switch (msg.type) {
    // The popup opened: be connected while it shows, to tell the link state.
    case 'open':
      return reply(ready.then(() => {
        reconnectNow()
        return { ok: true }
      }))
    case 'pair':
      return reply(ready.then(pair).then(() => ({ ok: true })))
    case 'confirmCode':
      return reply(ready.then(() => confirmTyped(msg.code)))
    case 'unpair':
      return reply(ready.then(() => unpair()).then(() => ({ ok: true })))
    case 'start':
      return reply(start(msg.tabId))
    case 'stop':
      return reply(ready.then(() => endShare({ notify: true })).then(() => ({ ok: true })))
    case 'expectGrant':
      if (validId(msg.tabId) && typeof msg.origin === 'string' && /^https?:\/\/[^/]+$/.test(msg.origin)) {
        awaitingGrant = { tabId: msg.tabId, origin: msg.origin, until: Date.now() + 60_000 }
      }
      return
    // The popup showed the last error.
    case 'seen':
      return reply(ready.then(() => saveSession({ lastError: null })).then(() => ({ ok: true })))
    case 'tick':
      return reply(tick())
    // The capture ended on Chrome's side: the tab closed, or Chrome stopped it.
    case 'ended':
      return reply(ready.then(() => endShare({ notify: true })).then(() => ({ ok: true })))
  }
})
