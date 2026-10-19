// What the worker makes of its socket closing. Only the server's word that the record is gone
// unpairs the extension, and only once the server proved it is this extension's Fremkit: a
// refusal it cannot place keeps the token, since a token thrown away means walking over to the
// Mac to pair again.

/** The server's revocation code (`DEVICE_CLOSE_CODE`): no extension record for this token. */
export const REVOKED_CLOSE_CODE = 4401
/** Policy violation: the server could not read what the extension said. */
export const POLICY_CLOSE_CODE = 1008

/**
 * - `revoked`: the proven server says the record is gone; forget the token.
 * - `removed`: a 4401 before any proof. It is what the real server answers a challenge for a
 *   record removed in Appareils, but anything holding the port could send it: keep the token,
 *   show the extension as removed and offer Connect (a new pairing overwrites the token).
 * - `refused`: a 1008 before any proof, the answer of a server that cannot read the challenge
 *   (another version); say an update is due, and keep trying on the backoff.
 * - `retry`: a lost connection, or a 1008 after the proof (a server too slow for its own
 *   handshake timeout, not a version mismatch).
 */
export function closeOutcome(code, { proven = false, greeted = false } = {}) {
  if (code === REVOKED_CLOSE_CODE) return proven ? 'revoked' : 'removed'
  if (!proven && !greeted && code === POLICY_CLOSE_CODE) return 'refused'
  return 'retry'
}

/**
 * What a `tab.refused` does to the share. `offer`: the server would not relay one receiver's video
 * connection (the offer named more than this Mac); only that receiver's peer goes, the share and
 * the other receivers keep going, nothing is offered again, and the popup says why. Any other
 * reason ends the share: `noWidget` and `disabled` (Fremplay is off in Fremkit) as such, anything
 * else as an update due.
 */
export function refusalOf(reason) {
  if (reason === 'offer') return { endShare: false, error: 'offerRefused' }
  if (reason === 'noWidget' || reason === 'disabled') return { endShare: true, error: reason }
  return { endShare: true, error: 'protocol' }
}
