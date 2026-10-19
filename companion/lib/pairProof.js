// Pairing by the code the user types from the Edge. It mirrors server/src/companion/pairProof.ts:
// keep the two in step (both test the same vector).
//
// The Edge is the one screen a program holding Fremkit's port cannot write to: with the helper, a
// server that fails /auth/proof never gets the kiosk to load its page. So the code is never sent
// to the extension; the user types it, the extension proves it first (a program that made the
// request itself gets one online guess per try), and the server proves it back with the token.
// The token is kept only if that proof checks and came back within PAIR_ANSWER_MS: a program
// holding the port that got the extension's proof could only search the code offline, ~2^20 codes
// at 600 000 PBKDF2 rounds each, which takes minutes on a large GPU, not two seconds.

import { base64url, fromBase64url, newNonce, sameBytes } from './proof.js'

export const PAIR_KEY_ITERATIONS = 600_000
export const PAIR_SALT_PREFIX = 'fremkit-companion-pair-code-v1:'
export const PAIR_SERVER_LABEL = 'fremkit-companion-pair-server-v1|'
export const PAIR_CLIENT_LABEL = 'fremkit-companion-pair-client-v1|'

/** The Edge's code: 4 characters of the pairing alphabet (server/src/devices/codes.ts). */
export const CODE_LENGTH = 4
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const utf8 = (s) => new TextEncoder().encode(s)

/** A pairing request's life on the server (REQUEST_TTL_MS in server/src/companion/pairing.ts). */
export const PAIR_TTL_MS = 120_000

/**
 * When the extension stops waiting on a request: the server's `expiresAt`, but never later than a
 * request's life from `now`, so whatever answers on the port cannot keep the poll and the worker
 * alive for ever. Null when the server gave no usable deadline.
 */
export function pairingDeadline(expiresAt, now) {
  return Number.isFinite(expiresAt) ? Math.min(expiresAt, now + PAIR_TTL_MS) : null
}

/** The code as typed, upper-cased and without spaces or dashes; null when it cannot be one. */
export function normalizeCode(typed) {
  const code = String(typed ?? '').toUpperCase().replace(/[\s-]/g, '')
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null
}

/**
 * K(code) for one request: PBKDF2-SHA256, 32 bytes, salted with the request id and `saltE`, the
 * extension's own random salt sent with the request (newNonce()): the id is the server's to pick,
 * so without it a program holding the port could reuse one id and a table built once.
 */
export async function pairKey(code, requestId, saltE, iterations = PAIR_KEY_ITERATIONS) {
  const subtle = globalThis.crypto.subtle
  const base = await subtle.importKey('raw', utf8(code), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: utf8(`${PAIR_SALT_PREFIX}${requestId}|${saltE}`), iterations }, base, 256)
  return new Uint8Array(bits)
}

/** How long the server's proof may take to come back after the extension sent its own. */
export const PAIR_ANSWER_MS = 2_000

async function hmac(key, text) {
  const subtle = globalThis.crypto.subtle
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64url(new Uint8Array(await subtle.sign('HMAC', k, utf8(text))))
}

/** base64url(HMAC-SHA256(K, PAIR_CLIENT_LABEL + requestId + "|" + nonceE)): the extension's proof. */
export const pairClientMac = (key, requestId, nonceE) => hmac(key, `${PAIR_CLIENT_LABEL}${requestId}|${nonceE}`)

/** base64url(HMAC-SHA256(K, PAIR_SERVER_LABEL + requestId + "|" + nonceE + "|" + nonceS)): the server's. */
export const pairServerMac = (key, requestId, nonceE, nonceS) => hmac(key, `${PAIR_SERVER_LABEL}${requestId}|${nonceE}|${nonceS}`)

const B64_32 = /^[A-Za-z0-9_-]{43}$/
const LATE = Symbol('late')

/**
 * One try at the typed `code` for `requestId`, whose K is salted with `salt` (the extension's). `post(step, body)` sends to
 * `/api/companion/pair/<requestId>/<step>` and resolves the JSON answer, or null. `now` and `wait`
 * are the clock and the timer, for tests.
 *
 * Resolves `{ state: 'paired', token, deviceId }` only when the server's proof checks against the
 * typed code and came back within `PAIR_ANSWER_MS` of sending the extension's; a token that came
 * any other way is dropped and the answer is `impostor`. Otherwise `wrong` (not the Edge's code),
 * `exhausted` (that wrong one was the last try), `refused` or `expired` as the server says, or
 * `failed`.
 */
export async function confirmCode({ post, requestId, salt, code, nonce = newNonce(), now = () => Date.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const key = await pairKey(code, requestId, salt)
  const mac = await pairClientMac(key, requestId, nonce)
  const sent = now()
  const answer = await Promise.race([post('confirm', { nonce, mac }), wait(PAIR_ANSWER_MS).then(() => LATE)])
  if (answer === LATE || now() - sent > PAIR_ANSWER_MS) return { state: 'impostor' }
  const state = answer?.state
  if (['wrong', 'exhausted', 'refused', 'expired'].includes(state)) return { state }
  if (state !== 'paired') return { state: 'failed' }
  const proven = typeof answer.nonce === 'string' && B64_32.test(answer.nonce) && answer.nonce !== nonce &&
    sameBytes(fromBase64url(answer.mac), fromBase64url(await pairServerMac(key, requestId, nonce, answer.nonce)))
  if (!proven || typeof answer.token !== 'string' || typeof answer.deviceId !== 'string') return { state: 'impostor' }
  return { state: 'paired', token: answer.token, deviceId: answer.deviceId }
}
