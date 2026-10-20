package app.fremkit.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Handler
import android.os.Looper

/**
 * The network coming back or changing: a reason to look for the Mac now rather than at the next
 * tick (the iPad's `NWPathMonitor` in `LocalNetwork.swift`). Calls [onChange] on the main thread
 * when the default network or its addresses change, not for every callback the system repeats.
 *
 * Browsing for the Mac over NSD joins this class with the manual pairing path.
 */
class LocalNetwork(context: Context, private val onChange: () -> Unit) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var callback: ConnectivityManager.NetworkCallback? = null

    /** What was seen last: the network and its addresses. Read and written on the main thread. */
    private var seen: String? = null

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
    }

    fun stop() {
        callback?.let { connectivity.unregisterNetworkCallback(it) }
        callback = null
        seen = null
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
}
