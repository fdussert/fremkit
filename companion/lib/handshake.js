// The socket's opening, from the extension's side: `challenge` first, the server's `proof`, and
// only then `hello` with the token. Kept apart from the worker so a test can drive it with a fake
// socket and check that the token never goes out before a valid proof.

import { newNonce, verifyProof } from './proof.js'
import { challenge } from './protocol.js'

/**
 * How long the server has to prove itself. Shorter than the server's 5 s for the whole handshake
 * (`HELLO_TIMEOUT_MS`, started at the upgrade): a proof that comes later would leave the hello
 * too little time to land before the server gives up on it.
 */
export const PROOF_TIMEOUT_MS = 4_000

/**
 * `socket` needs only `send(string)`. `hello` builds the hello message when the proof checks out
 * (it carries the token, and the share as it is then). `onImpostor` runs once when the proof is
 * wrong, is not the first message, or does not come within `timeoutMs`; the caller closes the
 * socket. Call `open()` once the socket is open, `receive(msg)` for every message until `proven`,
 * and `cancel()` when the socket closes first.
 */
export function handshake({ socket, deviceId, token, hello, onImpostor, timeoutMs = PROOF_TIMEOUT_MS, nonce = newNonce() }) {
  /** idle → challenged → checking → proven, or failed from any step before proven. */
  let state = 'idle'
  let timer = null

  const fail = () => {
    if (state === 'proven' || state === 'failed') return
    state = 'failed'
    clearTimeout(timer)
    onImpostor()
  }

  return {
    get proven() {
      return state === 'proven'
    },
    open() {
      if (state !== 'idle') return
      state = 'challenged'
      timer = setTimeout(fail, timeoutMs)
      socket.send(JSON.stringify(challenge(deviceId, nonce)))
    },
    /** Takes a message before the proof; anything but one well-formed proof, first, is an impostor. */
    async receive(msg) {
      if (state !== 'challenged') return fail()
      if (msg?.type !== 'proof' || typeof msg.mac !== 'string') return fail()
      state = 'checking'
      let ok = false
      try {
        ok = await verifyProof(token, nonce, msg.mac)
      } catch {
        ok = false
      }
      // Timed out or cancelled while checking.
      if (state !== 'checking') return
      if (!ok) return fail()
      state = 'proven'
      clearTimeout(timer)
      socket.send(JSON.stringify(hello()))
    },
    cancel() {
      clearTimeout(timer)
      if (state !== 'proven') state = 'failed'
    },
  }
}
