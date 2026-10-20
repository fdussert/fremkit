package app.fremkit.kit

sealed interface ConnectResult {
    /** [host] is the candidate that answered: store it with `PairedMac.updating(address)`. */
    data class Connected(val host: String, val info: DeviceInfo) : ConnectResult

    data object Unauthorized : ConnectResult

    /**
     * Nobody answered with the right key and at least one answered with another: the Mac's
     * certificate was reset, or another machine holds its address.
     */
    data object KeyChanged : ConnectResult

    data object Unreachable : ConnectResult
}

/**
 * Finds the paired Mac when it may have moved: its `.local` name, then the last address that
 * worked, then the other addresses it last listed, then whatever discovery resolved. A wrong key
 * is "not this one, next" (remembered: if nothing else answers and the Mac's own name or last
 * address presented it, the key changed); a 401 from the right key ends the search, since another
 * address would only say the same.
 */
class Connector(val prober: Prober = HttpProber()) {
    /**
     * [preferring] is a host to try before all others (the one a dashboard is using, so a page
     * that still works stays where it is). A wrong key ends in [ConnectResult.KeyChanged] only
     * when [preferring], `mac.host` or `mac.address` presented it: one from the Mac's other
     * addresses or from discovery is only "not this one" (a stale address another machine now
     * holds), and alone it leaves the result [ConnectResult.Unreachable].
     */
    suspend fun connect(mac: PairedMac, discovered: List<String>, preferring: String? = null): ConnectResult {
        val (result, wrongKey) = search(candidates(mac, discovered, preferring), mac)
        val own = listOfNotNull(preferring, mac.host, mac.address).map(Pin::normaliseHost).toSet()
        if (result == ConnectResult.KeyChanged && wrongKey.none { it in own }) return ConnectResult.Unreachable
        return result
    }

    /**
     * Looks for the Mac behind a dashboard that is using [current]: [current] first, then as
     * [connect]. A wrong key from another candidate is only "not this one": it ends in
     * [ConnectResult.KeyChanged] only when the host in use itself presented another key and
     * nobody answered with the right one. Otherwise the result is [ConnectResult.Unreachable],
     * which leaves the dashboard alone.
     */
    suspend fun relocate(mac: PairedMac, discovered: List<String>, current: String): ConnectResult {
        val (result, wrongKey) = search(candidates(mac, discovered, current), mac)
        if (result == ConnectResult.KeyChanged && Pin.normaliseHost(current) !in wrongKey) return ConnectResult.Unreachable
        return result
    }

    /** Tries each host in turn; also says which answered with another key (normalised). */
    private suspend fun search(hosts: List<String>, mac: PairedMac): Pair<ConnectResult, Set<String>> {
        val wrongKey = mutableSetOf<String>()
        for (host in hosts) {
            when (val outcome = prober.probe(host, mac.port, mac)) {
                is ProbeOutcome.Ok -> return ConnectResult.Connected(host, outcome.info) to wrongKey
                ProbeOutcome.Unauthorized -> return ConnectResult.Unauthorized to wrongKey
                ProbeOutcome.PinMismatch -> wrongKey += Pin.normaliseHost(host)
                ProbeOutcome.Unreachable -> continue
            }
        }
        return (if (wrongKey.isEmpty()) ConnectResult.Unreachable else ConnectResult.KeyChanged) to wrongKey
    }

    companion object {
        /**
         * [preferring], `mac.host`, `mac.address`, the Mac's other addresses (`mac.addresses`), then
         * [discovered], each once (compared without case), keeping only the `.local` names and IPv4
         * literals the Mac answers on ([isConnectableHost]). Each is probed under the pin like any other.
         */
        fun candidates(mac: PairedMac, discovered: List<String>, preferring: String? = null): List<String> {
            val seen = mutableSetOf<String>()
            return (listOf(preferring ?: "", mac.host, mac.address) + mac.addresses + discovered)
                .filter { isConnectableHost(it) && seen.add(Pin.normaliseHost(it)) }
        }
    }
}
