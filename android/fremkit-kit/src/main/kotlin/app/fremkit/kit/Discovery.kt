package app.fremkit.kit

/** A Mac to pair with or connect to: its name for people, and one place it can be reached. */
data class MacService(val name: String, val address: String, val port: Int)

/**
 * What a Mac's `_fremkit._tcp` TXT record says: the address the QR code would carry, and the
 * port. A device that cannot resolve the Mac's `.local` name (the SRV target) learns from it
 * where to connect.
 */
data class FremkitTXT(val address: String, val port: Int) {
    companion object {
        /** The port when the record has none: the Mac's remote listener's. */
        const val DEFAULT_PORT = 4243

        /**
         * Null unless `a` is an IPv4 literal; a missing `p` is the default port, an invalid one
         * refuses the record.
         */
        fun parse(record: Map<String, String>): FremkitTXT? {
            val address = record["a"]?.takeIf(::isIPv4Literal) ?: return null
            val port = record["p"]?.let { parsePort(it) ?: return null } ?: DEFAULT_PORT
            return FremkitTXT(address, port)
        }
    }
}

/**
 * A Mac discovery found, listed by name as soon as it is browsed, and where it can be reached once
 * that is known. Immutable: discovery replaces it with a [copy] as it learns more.
 */
data class DiscoveredMac(
    /** The service name: the Mac's computer name. */
    val name: String,
    /** Where the TXT record says it is, not yet checked. */
    val advertised: FremkitTXT? = null,
    /** The advertised address answered a TCP connection. */
    val advertisedAnswers: Boolean = false,
    /** Where resolving the service led (needs the `.local` name to resolve). */
    val resolved: MacService? = null,
) {
    /**
     * Where to connect, in order: the advertised address once it answered, then the resolved
     * endpoint when it is one the Mac answers on ([isConnectableHost]: an IPv6 one is not).
     * Empty while the address is pending.
     */
    val candidates: List<MacService>
        get() {
            val list = mutableListOf<MacService>()
            if (advertisedAnswers && advertised != null) list += MacService(name, advertised.address, advertised.port)
            if (resolved != null && isConnectableHost(resolved.address) &&
                list.none { it.address == resolved.address && it.port == resolved.port }
            ) {
                list += resolved
            }
            return list
        }

    /** The one to pair with: the first candidate. Null while the address is pending. */
    val service: MacService? get() = candidates.firstOrNull()
}

/** Every candidate address of every Mac, by Mac name, each once: [Connector]'s discovered list. */
val List<DiscoveredMac>.addresses: List<String>
    get() {
        val seen = mutableSetOf<String>()
        return sortedBy { it.name }.flatMap { mac -> mac.candidates.map { it.address } }.filter(seen::add)
    }
