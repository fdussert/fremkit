package app.fremkit.kit

import java.net.URI
import java.net.URISyntaxException

/**
 * Where the WebView loads the dashboard, what its frames and main frame may load, whom it hears,
 * and the cookie that carries the device token. URLs are strings (what the app's `WebResourceRequest`
 * hands over, printed), parsed with `java.net.URI`: a URL it refuses is refused here too.
 */
object Dashboard {
    const val COOKIE_NAME = "fremkit_device"

    /** `https://<host>:<port>/`, with an IPv6 literal in brackets and its zone escaped. */
    fun url(host: String, port: Int): String = resource(host, port, "/")

    /** `https://<host>:<port><path>`: the Swift kit's `Endpoint.url`, which [Endpoint.url] parses. */
    internal fun resource(host: String, port: Int, path: String): String {
        val h = if (host.contains(":") && !host.startsWith("[")) "[" + host.replace("%", "%25") + "]" else host
        return "https://$h:$port$path"
    }

    /**
     * The hosts the pin covers while [host] is in use: that host, the Mac's `.local` name and its
     * last address, normalised as the pin compares them ([Pin.normaliseHost]). Every other host is
     * left to the system's trust.
     */
    fun pinnedHosts(mac: PairedMac, host: String): Set<String> =
        listOf(host, mac.host, mac.address).filter { it.isNotEmpty() }.map(Pin::normaliseHost).toSet()

    /**
     * Whether a frame inside the dashboard, never the page itself, may load [url].
     *
     * The dashboard's only frames are its widgets, each loaded from `/widgets/<id>/…` on the Mac
     * that serves the page (and a widget's own CSP forbids frames of its own). So a frame may go
     * to that host and port, over HTTPS, under `/widgets/` and nowhere else: not to another site,
     * not to the dashboard's own page or API, not to `about:` or `data:`.
     *
     * The same rule as the Mac's `WidgetFrames.allows(_:on:)` (FremkitCore), case for case: the
     * host is the page's own, compared without case but otherwise exactly (a trailing dot is
     * another origin to the browser); the path must start with `/widgets/` both as sent and
     * decoded, with something after it; any `%2e` refuses the URL, and so does a `.` or `..`
     * segment once decoded. Stricter than the Mac on two counts it cannot meet anyway: credentials
     * in the URL and a backslash in the decoded path.
     */
    fun allowsSubframe(url: String?, host: String, port: Int): Boolean {
        val uri = sameOrigin(url, host, port) ?: return false
        // Dot segments are refused rather than resolved, encoded or not: `/widgets/%2e%2e/admin`
        // is not a widget, and neither page ever writes an encoded dot.
        if (url!!.contains("%2e", ignoreCase = true)) return false
        val prefix = "/widgets/"
        val raw = uri.rawPath ?: return false
        val path = uri.path ?: return false
        if (!raw.startsWith(prefix) || raw.length <= prefix.length) return false
        if (!path.startsWith(prefix) || path.length <= prefix.length || path.contains('\\')) return false
        return path.split("/").none { it == "." || it == ".." }
    }

    /**
     * Whether the main frame may go to [url]: the Mac's own origin, `https://<host>:<port>`, and
     * any path on it. The page reloads itself and is served at `/`; nothing it is meant to show
     * lives on another origin, so a link or a script that would take the whole view elsewhere is
     * cancelled, as the Mac's kiosk and admin window pin their main frame (`KioskOrigin`).
     */
    fun allowsMainFrame(url: String?, host: String, port: Int): Boolean = sameOrigin(url, host, port) != null

    /**
     * Whether a page message's sender is the Mac's page, by its origin (the web message
     * listener's `sourceOrigin`, whose port is 0 or -1 for the scheme's default): what the page
     * says to the app is heard from that origin only, even should the main frame end up
     * somewhere else.
     */
    fun isPageOrigin(scheme: String, originHost: String, originPort: Int, host: String, port: Int): Boolean {
        if (!scheme.equals("https", ignoreCase = true) || originHost.isEmpty()) return false
        return sameHost(originHost, host) && (if (originPort <= 0) 443 else originPort) == port
    }

    /**
     * Whether a request seen by `shouldInterceptRequest` is a navigation (a frame's document)
     * rather than a subresource, by its `Accept` header. The WebView adds `Sec-Fetch-Dest` below
     * the hook, so the navigation `Accept` Chromium sends a document load is what tells them apart
     * (spike result 8): `text/html,application/xhtml+xml,…`. A subresource's (any type, `text/css`,
     * `image/…`) is not. A script can send that `Accept` with `fetch`; it is then held to the
     * frame rule, which only ever refuses more.
     */
    fun isNavigationRequest(accept: String?): Boolean {
        if (accept == null) return false
        val types = accept.split(",").map { it.substringBefore(";").trim().lowercase() }
        return types.size >= 2 && types[0] == "text/html" && types[1] == "application/xhtml+xml"
    }

    /** [url] parsed, when it is `https` on [host]:[port] with no credentials; null otherwise. */
    private fun sameOrigin(url: String?, host: String, port: Int): URI? {
        if (url == null) return null
        val uri = try {
            URI(url)
        } catch (_: URISyntaxException) {
            return null
        }
        if (!uri.scheme.equals("https", ignoreCase = true) || uri.rawUserInfo != null) return null
        val urlHost = uri.host
        if (urlHost.isNullOrEmpty() || !sameHost(urlHost, host)) return null
        return uri.takeIf { (if (it.port == -1) 443 else it.port) == port }
    }

    /**
     * Hosts compared as the page's origin is: without case, an IPv6 literal without its brackets
     * and with its zone unescaped. Unlike [Pin.normaliseHost], a trailing dot is kept.
     */
    private fun sameHost(a: String, b: String): Boolean {
        fun origin(host: String): String {
            var h = host.lowercase()
            if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length - 1)
            return h.replace("%25", "%")
        }
        return origin(a) == origin(b)
    }
}

/** The Mac's name for people: its `.local` name without the suffix. */
val PairingLink.macName: String
    get() = if (host.lowercase().endsWith(".local")) host.dropLast(".local".length) else host
