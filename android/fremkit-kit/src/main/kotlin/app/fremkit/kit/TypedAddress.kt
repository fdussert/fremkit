package app.fremkit.kit

/**
 * A Mac's address as the user typed it on the manual path, when discovery finds nothing: what
 * Settings → Devices shows beside the code. `TypedAddress.swift` follows the same rule, and both
 * read `typedAddresses` in `test-vectors/devices.json`.
 *
 * Only what the Mac's remote listener answers on is taken ([isConnectableHost]): its `.local` name
 * or one of its IPv4 addresses, with an optional port. The host comes out as the Mac's Host set
 * writes it (lower case, no trailing dot, IPv4 without leading zeros), so the request it makes is
 * not refused 421 for a spelling.
 */
data class TypedAddress(val host: String, val port: Int) {
    companion object {
        private const val SCHEME = "https://"

        /**
         * Null unless [text] is `host` or `host:port`, spaces around it and a pasted `https://`
         * (and one trailing `/`) aside. Never a path, userinfo, query, fragment, IPv6 literal or
         * a port outside 1–65535.
         */
        fun parse(text: String): TypedAddress? {
            var s = text.trim()
            if (s.regionMatches(0, SCHEME, 0, SCHEME.length, ignoreCase = true)) s = s.substring(SCHEME.length)
            if (s.endsWith("/")) s = s.dropLast(1)
            if (s.isEmpty() || !s.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '.' || it == '-' || it == ':' }) {
                return null
            }
            val parts = s.split(':')
            if (parts.size > 2) return null
            val port = if (parts.size == 2) parsePort(parts[1]) ?: return null else FremkitTXT.DEFAULT_PORT
            val name = trimmingTrailingDot(parts[0].lowercase())
            val ipv4 = parseIPv4(name)
            val host = when {
                ipv4 != null -> ipv4.joinToString(".")
                isLocalName(name) -> name
                else -> return null
            }
            return TypedAddress(host, port)
        }
    }
}
