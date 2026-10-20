package app.fremkit.kit

import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URISyntaxException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64

/**
 * The alphabet of a pairing code: no 0/O, no 1/I, so a code read off a screen cannot be mistyped
 * into another one. The same as the server's.
 */
val PAIRING_CODE_ALPHABET: Set<Char> = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toSet()

/**
 * A pairing code as the user typed it: any case, with spaces or a dash. Returns the 8 characters
 * the server expects, or null when they are not that.
 */
fun normaliseCode(s: String): String? {
    val code = s.uppercase().filter { it != ' ' && it != '-' }
    if (code.length != 8 || !code.all { it in PAIRING_CODE_ALPHABET }) return null
    return code
}

/**
 * What the QR code on the Mac carries:
 * `fremkit://pair?h=<name>.local&a=<lan ip>&p=4243&c=<code>&s=<secret>&k=<base64url SPKI sha256>`.
 * Every field must be present and valid, or there is no link: the app never guesses. The one
 * exception is `s`, which a Mac from before it does not send; when present it must be valid too.
 *
 * [toString] never shows the pin, the code or the secret (as good as a password while they live).
 */
data class PairingLink(
    /** The Mac's Bonjour name, ending in `.local`. */
    val host: String,
    /** The Mac's LAN address when the QR was shown, an IPv4 literal. */
    val address: String,
    val port: Int,
    /** The pairing code, normalised. */
    val code: String,
    /** The pin: base64url SHA-256 of the Mac's public key, no padding. */
    val keyHash: String,
    /**
     * The pairing secret bound to the code: 256 random bits, base64url, no padding. Sent instead
     * of the code, since the Mac takes it even while it refuses codes to someone guessing them.
     * Null from a Mac that does not issue one: the code is sent then.
     */
    val secret: String? = null,
) {
    override fun toString(): String = "PairingLink($host, $address:$port)"

    companion object {
        /** The link a `fremkit://pair` URL carries, or null when it is not a complete, valid one. */
        fun parse(url: String): PairingLink? {
            val uri = try {
                URI(url)
            } catch (_: URISyntaxException) {
                return null
            }
            if (uri.scheme?.lowercase() != "fremkit" || uri.host?.lowercase() != "pair") return null
            val fields = queryFields(uri.rawQuery ?: return null) ?: return null

            val host = fields["h"]?.let(::trimmingTrailingDot)?.takeIf(::isLocalName) ?: return null
            // IPv4 only: the Mac answers on its IPv4 addresses and its `.local` name, never on an
            // IPv6 literal (`isConnectableHost`), and it never puts one in a link.
            val address = fields["a"]?.takeIf(::isIPv4Literal) ?: return null
            val port = fields["p"]?.let(::parsePort) ?: return null
            val code = fields["c"]?.let(::normaliseCode) ?: return null
            val keyHash = fields["k"]?.takeIf(::isKeyHash) ?: return null
            val secret = fields["s"]
            if (secret != null && !isPairingSecret(secret)) return null
            return PairingLink(host, address, port, code, keyHash, secret)
        }

        /**
         * The query's items, each name and value percent-decoded as UTF-8 (a `+` stays a `+`, as
         * in URLComponents). Null when an item has no `=`, an escape is malformed, or a name is
         * repeated: an ambiguous link is refused rather than read one way.
         */
        private fun queryFields(raw: String): Map<String, String>? {
            if (raw.isEmpty()) return null
            val fields = HashMap<String, String>()
            for (item in raw.split('&')) {
                val eq = item.indexOf('=')
                if (eq < 0) return null
                val name = percentDecode(item.substring(0, eq)) ?: return null
                val value = percentDecode(item.substring(eq + 1)) ?: return null
                if (fields.put(name, value) != null) return null
            }
            return fields
        }

        private fun percentDecode(s: String): String? {
            if ('%' !in s) return s
            val bytes = ByteArrayOutputStream()
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '%') {
                    if (i + 3 > s.length) return null
                    val hi = hexValue(s[i + 1])
                    val lo = hexValue(s[i + 2])
                    if (hi < 0 || lo < 0) return null
                    bytes.write(hi * 16 + lo)
                    i += 3
                } else {
                    bytes.write(c.toString().toByteArray(Charsets.UTF_8))
                    i++
                }
            }
            return try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray()))
                    .toString()
            } catch (_: CharacterCodingException) {
                null
            }
        }

        private fun hexValue(c: Char): Int = when (c) {
            in '0'..'9' -> c - '0'
            in 'a'..'f' -> c - 'a' + 10
            in 'A'..'F' -> c - 'A' + 10
            else -> -1
        }
    }
}

/** A fully qualified name's trailing dot dropped: `studio.local.` is `studio.local`. */
fun trimmingTrailingDot(s: String): String = if (s.endsWith(".")) s.dropLast(1) else s

/** `name.local` (or `name.local.`), each label letters, digits and hyphens: what Bonjour gives a Mac. */
fun isLocalName(s: String): Boolean {
    val name = trimmingTrailingDot(s)
    if (!name.lowercase().endsWith(".local")) return false
    val labels = name.split('.')
    return labels.size >= 2 && labels.all { label ->
        label.isNotEmpty() && label.length <= 63 && label.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' }
    }
}

/**
 * The four bytes of an IPv4 literal as the Mac's `inet_pton(AF_INET)` reads it, or null: exactly
 * four dot-separated parts of ASCII digits, each at most 255. A leading zero is read as decimal
 * (`010` is 10, `0300` is 300 and refused), never octal. Written out on purpose:
 * `InetAddress.getByName` takes other spellings and may look a name up in the DNS.
 */
internal fun parseIPv4(s: String): IntArray? {
    val parts = s.split('.')
    if (parts.size != 4) return null
    val bytes = IntArray(4)
    for ((i, part) in parts.withIndex()) {
        if (part.isEmpty()) return null
        var value = 0
        for (c in part) {
            if (c !in '0'..'9') return null
            value = value * 10 + (c - '0')
            if (value > 255) return null
        }
        bytes[i] = value
    }
    return bytes
}

/** An IPv4 literal. */
fun isIPv4Literal(s: String): Boolean = parseIPv4(s) != null

/**
 * A private IPv4 literal (RFC 1918: 10/8, 172.16/12, 192.168/16): what the app accepts as one of
 * the Mac's other addresses from the wire. Never a public, CGNAT, link-local or IPv6 one.
 */
fun isPrivateIPv4Literal(s: String): Boolean {
    val b = parseIPv4(s) ?: return false
    return b[0] == 10 || (b[0] == 172 && b[1] in 16..31) || (b[0] == 192 && b[1] == 168)
}

/**
 * A host the app connects to: a `.local` name or an IPv4 literal. The Mac answers on those only
 * (its remote listener's Host set is its `.local` name and its IPv4 addresses, and anything else
 * gets 421), and an IPv6 literal would also carry its zone into the cookie domain, the CSP and
 * the Origin check. A connection made by name may still run over IPv6.
 */
fun isConnectableHost(s: String): Boolean = isIPv4Literal(s) || isLocalName(s)

/** An IPv4 or IPv6 literal (an IPv6 one may carry a `%zone` of ASCII letters and digits). */
fun isIPLiteral(s: String): Boolean {
    if (isIPv4Literal(s)) return true
    val percent = s.indexOf('%')
    val address = if (percent < 0) s else s.substring(0, percent)
    if (percent >= 0) {
        val zone = s.substring(percent + 1)
        if (zone.isEmpty() || !zone.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' }) return false
    }
    return isIPv6Text(address)
}

/**
 * The text forms `inet_pton(AF_INET6)` takes: eight groups of one to four hex digits, one `::`
 * standing for at least one zero group, and an optional dotted IPv4 tail counting as two groups.
 */
private fun isIPv6Text(s: String): Boolean {
    if (s.isEmpty()) return false
    val double = s.indexOf("::")
    if (double >= 0 && s.indexOf("::", double + 1) >= 0) return false
    val (head, tail) = if (double >= 0) s.substring(0, double) to s.substring(double + 2) else s to null
    val headGroups = if (head.isEmpty()) emptyList() else head.split(':')
    val tailGroups = if (tail.isNullOrEmpty()) emptyList() else tail.split(':')
    val groups = headGroups + tailGroups
    var count = 0
    for ((i, group) in groups.withIndex()) {
        val last = i == groups.lastIndex
        if (last && '.' in group && s.endsWith(group)) {
            // An IPv4 tail ends the address: after `::`, or as the seventh and eighth groups.
            if (parseIPv4(group) == null) return false
            count += 2
        } else {
            if (group.isEmpty() || group.length > 4 || !group.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return false
            count += 1
        }
    }
    return if (double >= 0) count <= 7 else count == 8
}

internal fun parsePort(s: String): Int? {
    if (s.isEmpty() || s.length > 5 || !s.all { it in '0'..'9' }) return null
    return s.toInt().takeIf { it in 1..65535 }
}

/**
 * 43 base64url characters that decode to 32 bytes and re-encode to themselves (so the two
 * unused low bits are zero and there is exactly one spelling of each hash).
 */
fun isKeyHash(s: String): Boolean {
    if (s.length != 43) return false
    val bytes = base64UrlDecode(s) ?: return false
    return bytes.size == 32 && base64UrlEncode(bytes) == s
}

/** A pairing secret has the shape of a key hash: 32 bytes in canonical base64url. */
fun isPairingSecret(s: String): Boolean = isKeyHash(s)

/** Base64url without padding, as the server's `toString('base64url')`. */
fun base64UrlEncode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

/** Strict base64url: only `A–Z a–z 0–9 - _`, no padding. Null for anything else. */
fun base64UrlDecode(s: String): ByteArray? {
    if (!s.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }) return null
    if (s.length % 4 == 1) return null
    return try {
        Base64.getUrlDecoder().decode(s)
    } catch (_: IllegalArgumentException) {
        null
    }
}
