// The server's proof that it is this extension's Fremkit, checked before the token leaves the
// browser. It mirrors `proofMac` in server/src/companion/protocol.ts: keep the two in step.
//
// Another account's process can hold 127.0.0.1:4242 and pose as Fremkit. It can answer a
// challenge only if it knows sha256(token), which the device store keeps and nobody else has, so
// a wrong or missing proof means the token is not sent.

export const PROOF_LABEL = 'fremkit-companion-proof-v1|'

const utf8 = (s) => new TextEncoder().encode(s)

export function base64url(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Bytes from unpadded base64url; null for anything else. */
export function fromBase64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** 32 random bytes in base64url: a fresh one per socket. */
export function newNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** HMAC-SHA256(key = sha256(token) raw bytes, PROOF_LABEL + nonce), as bytes. */
async function macBytes(token, nonce) {
  const subtle = globalThis.crypto.subtle
  const key = await subtle.digest('SHA-256', utf8(token))
  const hmac = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', hmac, utf8(PROOF_LABEL + nonce)))
}

/** The proof the server should send, in base64url as it travels. */
export async function expectedMac(token, nonce) {
  return base64url(await macBytes(token, nonce))
}

/** Byte-wise comparison with no early exit, so the time taken says nothing of where they differ. */
export function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** True when `mac` is the proof this token's record gives for this nonce. */
export async function verifyProof(token, nonce, mac) {
  const got = fromBase64url(mac)
  return sameBytes(got, await macBytes(token, nonce))
}
