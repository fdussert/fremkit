package app.fremkit.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import app.fremkit.kit.DiscoveredMac
import app.fremkit.kit.FremkitTXT
import app.fremkit.kit.MacService
import app.fremkit.kit.addresses
import app.fremkit.kit.isIPv4Literal
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket

/**
 * The local network, as the app needs it (the iPad's `LocalNetwork.swift`):
 *
 * - **The network coming back or changing**: a reason to look for the Mac now rather than at the
 *   next tick. [onChange] runs on the main thread when the default network or its addresses
 *   change, not for every callback the system repeats.
 * - **The Macs advertising Fremkit** (`_fremkit._tcp`, browsed with `NsdManager`), listed by name
 *   as soon as they are seen ([macs]), each resolved for its TXT record (the address the QR code
 *   would carry, and the port) and its endpoint. The advertised address counts once it answers a
 *   TCP connection within [CHECK_TIMEOUT_MILLIS]. Resolutions run one at a time ([ResolveQueue]:
 *   API 28 refuses a second one in flight). A new address calls [onChange] too, and every known
 *   address is a candidate for the `Connector` ([addresses]).
 *
 * A multicast lock is held while browsing: some vendors' Wi-Fi drivers drop multicast without one.
 * [start] and [stop] follow the activity. Called on the main thread.
 */
class LocalNetwork(context: Context, private val onChange: () -> Unit) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val nsd: NsdManager? = context.getSystemService(NsdManager::class.java)
    private val wifi: WifiManager? = context.applicationContext.getSystemService(WifiManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val checks = MainScope()
    private var callback: ConnectivityManager.NetworkCallback? = null

    /** What was seen last: the network and its addresses. Read and written on the main thread. */
    private var seen: String? = null

    private var discovery: NsdManager.DiscoveryListener? = null
    private var multicast: WifiManager.MulticastLock? = null
    private val found = mutableMapOf<String, NsdServiceInfo>()
    private val queue = ResolveQueue(::resolve)

    /** Bumped by [stop], so an answer for an earlier browse is dropped. */
    private var generation = 0

    private val _macs = MutableStateFlow<Map<String, DiscoveredMac>>(emptyMap())

    /** Every Mac browsed, by service name (the Mac's computer name), its address possibly pending. */
    val macs: StateFlow<Map<String, DiscoveredMac>> = _macs.asStateFlow()

    /** Every known address, in a stable order: the `Connector`'s discovered candidates. */
    val addresses: List<String> get() = _macs.value.values.toList().addresses

    fun start() {
        if (callback != null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val properties = connectivity.getLinkProperties(network)
                main.post { changed(network, properties) }
            }

            override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) {
                main.post { changed(network, properties) }
            }

            override fun onLost(network: Network) {
                main.post { seen = null }
            }
        }
        callback = cb
        connectivity.registerDefaultNetworkCallback(cb)
        browse()
    }

    fun stop() {
        callback?.let { connectivity.unregisterNetworkCallback(it) }
        callback = null
        seen = null
        stopBrowsing()
    }

    /** Resolves again every Mac whose address is still pending (the manual list asks every few seconds). */
    fun refresh() {
        if (discovery == null) return
        _macs.value.values.filter { it.service == null }.forEach { queue.add(it.name) }
    }

    private fun changed(network: Network, properties: LinkProperties?) {
        if (callback == null) return
        val key = network.toString() + "|" + properties?.linkAddresses?.mapNotNull { it.address.hostAddress }?.sorted()
        if (key == seen) return
        val first = seen == null
        seen = key
        // The callback's first answer after start() is the network the app already had.
        if (!first) onChange()
    }

    private fun browse() {
        val nsd = nsd ?: return
        if (discovery != null) return
        multicast = wifi?.createMulticastLock("fremkit-discovery")?.apply {
            setReferenceCounted(false)
            acquire()
        }
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                main.post { if (discovery === this) discovery = null }
            }

            override fun onServiceFound(info: NsdServiceInfo) {
                main.post { if (discovery === this) serviceFound(info) }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                main.post { if (discovery === this) serviceLost(info.serviceName) }
            }
        }
        discovery = listener
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (_: RuntimeException) {
            discovery = null
        }
    }

    private fun stopBrowsing() {
        generation += 1
        discovery?.let { listener ->
            try {
                nsd?.stopServiceDiscovery(listener)
            } catch (_: RuntimeException) {
                // Never started, or already stopped.
            }
        }
        discovery = null
        multicast?.let { if (it.isHeld) it.release() }
        multicast = null
        checks.coroutineContext.cancelChildren()
        queue.clear()
        found.clear()
        _macs.value = emptyMap()
    }

    private fun serviceFound(info: NsdServiceInfo) {
        val name = info.serviceName ?: return
        found[name] = info
        if (name !in _macs.value) _macs.value = _macs.value + (name to DiscoveredMac(name))
        queue.add(name)
    }

    private fun serviceLost(name: String) {
        found.remove(name)
        queue.remove(name)
        _macs.value = _macs.value - name
    }

    private fun resolve(name: String) {
        val info = found[name]
        val nsd = nsd
        if (info == null || nsd == null) return queue.done(name)
        val generation = generation
        // A new listener each time: API 28 refuses one already used.
        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                // FAILURE_ALREADY_ACTIVE included: the next refresh() asks again.
                main.post { if (generation == this@LocalNetwork.generation) queue.done(name) }
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                main.post {
                    if (generation != this@LocalNetwork.generation) return@post
                    resolved(name, serviceInfo)
                    queue.done(name)
                }
            }
        }
        try {
            nsd.resolveService(info, listener)
        } catch (_: RuntimeException) {
            queue.done(name)
        }
    }

    private fun resolved(name: String, info: NsdServiceInfo) {
        val mac = _macs.value[name] ?: return
        val txt = info.attributes?.let { record ->
            FremkitTXT.parse(record.mapValues { (_, value) -> value?.toString(Charsets.UTF_8).orEmpty() })
        }
        val host = info.host?.hostAddress
        val endpoint = if (host != null && info.port in 1..65535) MacService(name, host, info.port) else null
        val updated = mac.copy(
            advertised = txt,
            advertisedAnswers = mac.advertisedAnswers && txt == mac.advertised,
            resolved = endpoint,
        )
        _macs.value = _macs.value + (name to updated)
        if (updated.candidates != mac.candidates) onChange()
        if (txt != null && !updated.advertisedAnswers) check(name, txt)
    }

    /** Whether the advertised address answers; a yes makes it the Mac's first candidate. */
    private fun check(name: String, txt: FremkitTXT) {
        val generation = generation
        checks.launch {
            val answers = runInterruptible(Dispatchers.IO) { answers(txt.address, txt.port) }
            if (generation != this@LocalNetwork.generation || !answers) return@launch
            val mac = _macs.value[name] ?: return@launch
            if (mac.advertised != txt || mac.advertisedAnswers) return@launch
            val updated = mac.copy(advertisedAnswers = true)
            _macs.value = _macs.value + (name to updated)
            if (updated.candidates != mac.candidates) onChange()
        }
    }

    companion object {
        const val SERVICE_TYPE = "_fremkit._tcp"

        /** How long a TCP check may wait for the Mac (the iPad's `checkTimeout`). */
        const val CHECK_TIMEOUT_MILLIS = 3_000

        /**
         * Opens a TCP connection to an IPv4 literal and closes it. The address is built from its
         * four parts, never looked up: a string that is not a literal never reaches a resolver.
         */
        fun answers(address: String, port: Int): Boolean {
            if (!isIPv4Literal(address) || port !in 1..65535) return false
            val bytes = address.split('.').map { it.toInt().toByte() }.toByteArray()
            return try {
                Socket().use { it.connect(InetSocketAddress(InetAddress.getByAddress(bytes), port), CHECK_TIMEOUT_MILLIS) }
                true
            } catch (_: IOException) {
                false
            }
        }
    }
}
