// Builders for the messages the extension sends the server. They mirror
// server/src/companion/protocol.ts (`parseExtensionMessage`), which is strict: a page's odd values
// are clamped here so that one bad title or a live stream's Infinity duration cannot get a share refused.

/** 2: the socket opens with `challenge`/`proof` before `hello` (lib/handshake.js). */
export const PROTOCOL = 2

const MAX_TITLE = 300
const MAX_SECONDS = 604_800

const seconds = (n) => (Number.isFinite(n) ? Math.min(MAX_SECONDS, Math.max(0, n)) : 0)

/** A bare lowercase hostname from a page URL, `unknown` when there is none. */
export function hostOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) && host.length <= 253 ? host : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** A meta the server accepts, whatever the page reported. */
export function cleanMeta(m) {
  const volume = Number.isFinite(m.volume) ? Math.min(1, Math.max(0, m.volume)) : 1
  return {
    title: String(m.title ?? '').slice(0, MAX_TITLE),
    host: hostOf(`https://${m.host}/`),
    currentTime: seconds(m.currentTime),
    duration: seconds(m.duration),
    paused: Boolean(m.paused),
    muted: Boolean(m.muted),
    volume,
  }
}

export const challenge = (deviceId, nonce) => ({ type: 'challenge', deviceId, nonce })
export const hello = (token, installId, session) => ({
  type: 'hello',
  token,
  installId,
  protocol: PROTOCOL,
  ...(session ? { session: { sessionId: session.sessionId, meta: cleanMeta(session.meta) } } : {}),
})
export const started = (sessionId, meta) => ({ type: 'tab.started', sessionId, meta: cleanMeta(meta) })
export const meta = (sessionId, m) => ({ type: 'tab.meta', sessionId, meta: cleanMeta(m) })
export const offer = (sessionId, receiverId, sdp) => ({ type: 'tab.offer', sessionId, receiverId, sdp })
export const stopped = (sessionId) => ({ type: 'tab.stopped', sessionId })
