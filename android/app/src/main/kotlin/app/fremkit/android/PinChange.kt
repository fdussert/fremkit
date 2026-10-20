package app.fremkit.android

/**
 * What a change of the paired Mac's identity (a pairing, a forget, pairing again after a key
 * change) does to this process.
 *
 * Clearing the WebView's SSL preferences forgets the certificate decisions taken under the old
 * pin, but not the connections opened under them: Chromium keeps idle keep-alive TLS sockets in a
 * process-wide pool and sends the next request for the same host and port down one of them without
 * consulting any certificate decision (seen on the tablet in stage E). A socket opened under the
 * old pin could then carry the next page load, and its device cookie, to a listener the new pin
 * refuses. No WebView API empties that pool; ending the process does. So once a WebView has
 * started loading in this process, a pin change restarts the app in a fresh one
 * ([restartProcess]), and no WebView of this process loads anything after that; before the first
 * load the pool is empty, and clearing the decisions and cookies in place ([clearInProcess]) is
 * enough, which keeps a first pairing from the welcome screen free of a restart.
 *
 * The kit's own requests (probe, pairing, brightness) need none of this: each builds its TLS
 * socket factory from its own pin, and connections are pooled per socket factory.
 *
 * No Android type: tested on the JVM. Called on the main thread.
 */
class PinChangeGuard(
    private val restartProcess: () -> Unit,
    private val clearInProcess: () -> Unit,
) {
    /** True once a WebView of this process has been allowed to load. */
    var webViewLoaded: Boolean = false
        private set

    /** True once this process is on its way out: nothing may load any more. */
    var restarting: Boolean = false
        private set

    /**
     * A WebView is about to load. Returns whether it may: not once a restart is under way, since
     * the process still holds the old pin's connections until it ends.
     */
    fun webViewLoading(): Boolean {
        if (restarting) return false
        webViewLoaded = true
        return true
    }

    /** The paired Mac changed identity. */
    fun pinChanged() {
        when {
            restarting -> Unit
            webViewLoaded -> {
                restarting = true
                restartProcess()
            }
            else -> clearInProcess()
        }
    }
}
