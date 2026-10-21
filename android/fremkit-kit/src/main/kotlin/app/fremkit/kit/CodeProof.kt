package app.fremkit.kit

import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * What the tablet sends for a typed pairing code: never the code itself, but a proof of it bound
 * to the key of the Mac it is talking to. The Mac checks it against its own key, so a machine that
 * took the Mac's name on the network, showed its own key and relays the request gets a proof that
 * does not pair the real Mac, and cannot read the code back out of it in the code's five minutes.
 * The same derivation as `server/src/devices/codeProof.ts`; both test the same vector.
 */
object CodeProof {
    const val ITERATIONS = 600_000

    /**
     * PBKDF2-HMAC-SHA256 of the normalised code, salted with `fremkit-pair-code-v1:<keyHash>`,
     * 32 bytes, base64url without padding.
     *
     * The code is ASCII (the pairing alphabet), so `PBEKeySpec`'s chars-to-bytes step, which
     * providers do in UTF-8, gives the same password bytes as the server's. Slow on purpose (a
     * few seconds on a low-end tablet): call it off the main thread.
     */
    fun proof(code: String, keyHash: String): String {
        val salt = "fremkit-pair-code-v1:$keyHash".toByteArray(Charsets.UTF_8)
        val spec = PBEKeySpec(code.toCharArray(), salt, ITERATIONS, 256)
        try {
            val key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec)
            return base64UrlEncode(key.encoded)
        } finally {
            spec.clearPassword()
        }
    }
}
