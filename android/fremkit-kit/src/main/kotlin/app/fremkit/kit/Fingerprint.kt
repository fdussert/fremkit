package app.fremkit.kit

import java.security.MessageDigest

/**
 * Four words for the Mac's key, so a person can compare what the tablet shows with what the Mac
 * shows by eye. The same list and algorithm as `server/src/devices/fingerprint.ts`.
 */
object Fingerprint {
    /** Hex SHA-256 of `fingerprint-words.txt`: the server's `FINGERPRINT_LIST_SHA256`. */
    const val LIST_SHA256 = "247bec0519f05acf5f8716f8515af0532676cce180409949d265f5670797c930"

    /**
     * The PGP word list's even column, byte value -> word, from the copy of the server's file the
     * build puts on the classpath. A copy that does not hash to [LIST_SHA256] is a build mistake
     * and stops the app.
     */
    internal val list: List<String> by lazy {
        val stream = Fingerprint::class.java.getResourceAsStream("/fingerprint-words.txt")
            ?: error("fingerprint-words.txt is missing")
        checked(stream.use { it.readBytes() })
    }

    /** The words of [data], or an [IllegalStateException] when it is not the server's list. */
    internal fun checked(data: ByteArray): List<String> {
        val digest = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
        check(digest == LIST_SHA256) { "fingerprint-words.txt differs from the server's" }
        val words = String(data, Charsets.UTF_8).split("\n").filter { it.isNotEmpty() }
        check(words.size == 256) { "fingerprint-words.txt must hold 256 words" }
        return words
    }

    /**
     * The words of the first four bytes of [keyHash] (base64url, the QR's `k`). Empty when the
     * hash does not decode to at least four bytes: the server throws there, and an empty list is
     * the app's "nothing to compare", never four made-up words.
     */
    fun words(keyHash: String): List<String> {
        val bytes = base64UrlDecode(keyHash) ?: return emptyList()
        if (bytes.size < 4) return emptyList()
        return (0 until 4).map { list[bytes[it].toInt() and 0xff] }
    }
}
