import { pbkdf2Sync } from 'node:crypto'

/**
 * How a typed pairing code reaches the Mac: never as itself, but bound to the key the device saw.
 *
 * On the manual path the iPad picks a Mac from Bonjour and pins whatever key answers, so a machine
 * on the LAN can advertise itself under the Mac's name, show the person its own words, take the
 * code they type and replay it to the real Mac. The words alone cannot stop that: they are 32 bits
 * of the key's hash, and a key whose hash starts the same is found offline. So the iPad sends
 * `codeProof(code, keyHash)` for the key it is talking to, and the Mac checks it against its own
 * key: a proof made for another key does not pair here, and the code cannot be read back out of
 * it within its five minutes (40 bits behind PBKDF2 at `CODE_PROOF_ITERATIONS`, so ~2^60 hashes).
 *
 * The same derivation as `CodeProof.swift` in FremkitKit; both test the same vector.
 */
export const CODE_PROOF_ITERATIONS = 600_000

/** `code` is the normalized code (8 characters from `CODE_ALPHABET`), `keyHash` the base64url SPKI hash. */
export function codeProof(code: string, keyHash: string): string {
  return pbkdf2Sync(code, `fremkit-pair-code-v1:${keyHash}`, CODE_PROOF_ITERATIONS, 32, 'sha256').toString('base64url')
}
