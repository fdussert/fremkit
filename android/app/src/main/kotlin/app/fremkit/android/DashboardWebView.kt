package app.fremkit.android

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import app.fremkit.kit.Dashboard
import app.fremkit.kit.PageMessage
import app.fremkit.kit.PairedMac
import app.fremkit.kit.Pin
import app.fremkit.kit.PinDecision
import java.io.ByteArrayInputStream

/**
 * The Mac's dashboard in a WebView: the device cookie set before the first load, the Mac's key
 * pinned on the Mac's hosts, the main frame kept on the Mac's origin, frames kept to its widgets,
 * and the page heard only from its own main frame. One instance per host: a new host means a new
 * view (`Root` keys it by host), as on the iPad.
 *
 * - **Pin** (`onReceivedSslError`): the Mac's certificate is self-signed, so every load from it,
 *   every subresource and every `wss://` handshake comes here. For the hosts the pin covers
 *   ([Dashboard.pinnedHosts]), the leaf's key must be the paired one: `proceed()`, else `cancel()`.
 *   Any other host's certificate already failed the system's check: `cancel()`. A refusal for the
 *   page's own host is a failure of the dashboard ([onFailure]): a refused reload leaves the old
 *   page alive and running, and the WebView never says so.
 * - **Main frame** (`shouldOverrideUrlLoading`, and `shouldInterceptRequest` for the POST
 *   navigations the former never sees): [Dashboard.allowsMainFrame] or nothing.
 * - **Frames** (`shouldInterceptRequest`, a document load told apart by its `Accept` header):
 *   [Dashboard.allowsSubframe] or an empty 403. `about:blank`, `srcdoc`, `data:` and `javascript:`
 *   frames never reach either hook; the host page's CSP (`frame-src <origin>/widgets/`) covers them.
 * - **Messages**: a web message listener named `fremkit`, offered to the page's exact origin only,
 *   and each message dropped unless it comes from the main frame of that origin.
 * - **Nothing else**: no file or content access, no new windows, no zoom, no camera, microphone or
 *   location for any page.
 *
 * Everything is called on the main thread except `shouldInterceptRequest`, which only reads.
 */
@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
class DashboardWebView(
    context: Context,
    val host: String,
    val port: Int,
    private val mac: PairedMac,
    private val hygiene: WebViewHygiene,
    /** What the page posts, on the main thread. */
    private val onMessage: (PageMessage) -> Unit,
    /** The page could not be shown (load error, refused key, renderer gone): once per view. */
    private val onFailure: () -> Unit,
) {
    val pageUrl: String = Dashboard.url(host, port)
    private val pinned: Set<String> = Dashboard.pinnedHosts(mac, host)
    private val main = Handler(Looper.getMainLooper())
    private var failed = false
    private var destroyed = false

    val view: WebView = WebView(context)

    init {
        configure(view)
        WebViewCompat.addWebMessageListener(view, LISTENER, setOf(origin())) { _, message, sourceOrigin, isMainFrame, _ ->
            if (destroyed || !isMainFrame) return@addWebMessageListener
            if (!Dashboard.isPageOrigin(sourceOrigin.scheme.orEmpty(), sourceOrigin.host.orEmpty(), sourceOrigin.port, host, port)) {
                return@addWebMessageListener
            }
            val parsed = message.data?.let(PageMessage::parse) ?: return@addWebMessageListener
            onMessage(parsed)
        }
    }

    /**
     * Sets the device cookie for the host in use (every other cookie dropped first), then loads
     * the page in the cookie's callback, so the first request already carries it.
     */
    fun load() {
        if (destroyed) return
        hygiene.prepare(view)
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(view, false)
        WebViewHygiene.clearCookies {
            if (destroyed) return@clearCookies
            // A session cookie (no Expires): the Keystore file is the token's one durable home.
            val cookie = "${Dashboard.COOKIE_NAME}=${mac.token}; Path=/; Secure; HttpOnly; SameSite=Lax"
            cookies.setCookie(pageUrl, cookie) { set ->
                if (destroyed) return@setCookie
                if (set) view.loadUrl(pageUrl) else fail()
            }
        }
    }

    fun onPause() {
        if (!destroyed) view.onPause()
    }

    fun onResume() {
        if (!destroyed) view.onResume()
    }

    fun destroy() {
        if (destroyed) return
        destroyed = true
        try {
            WebViewCompat.removeWebMessageListener(view, LISTENER)
        } catch (_: RuntimeException) {
            // The renderer is gone already.
        }
        view.stopLoading()
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    /** `https://host:port`, as the message listener's origin rule wants it (no default port). */
    private fun origin(): String = pageUrl.removeSuffix("/").let { if (port == 443) it.removeSuffix(":443") else it }

    private fun fail() {
        if (failed || destroyed) return
        failed = true
        onFailure()
    }

    private fun isOwnHost(url: String?): Boolean {
        val h = url?.let { Uri.parse(it).host } ?: return false
        return Pin.normaliseHost(h) == Pin.normaliseHost(host)
    }

    private fun configure(web: WebView) {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // The system's font scale would enlarge the dashboard and break the measured layout.
            textZoom = 100
            setGeolocationEnabled(false)
            safeBrowsingEnabled = false
        }
        // MATCH_PARENT, never WRAP_CONTENT (what Compose's AndroidView gives a view that has none):
        // a WebView whose height wraps lays the page out at a zero height, and `100vh` is 0.
        web.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        web.setBackgroundColor(Color.BLACK)
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
    }

    private inner class Client : WebViewClient() {
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val errorHost = Uri.parse(error.url).host.orEmpty()
            val presented = keyHashOf(error.certificate)
            if (Pin.decide(errorHost, presented, mac.keyHash, pinned) == PinDecision.Trust) {
                handler.proceed()
                return
            }
            handler.cancel()
            if (isOwnHost(error.url)) main.post { fail() }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            return if (request.isForMainFrame) {
                !Dashboard.allowsMainFrame(url, host, port)
            } else {
                !Dashboard.allowsSubframe(url, host, port)
            }
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url.toString()
            if (request.isForMainFrame) {
                return if (Dashboard.allowsMainFrame(url, host, port)) null else forbidden()
            }
            val accept = request.requestHeaders.entries.firstOrNull { it.key.equals("Accept", ignoreCase = true) }?.value
            if (Dashboard.isNavigationRequest(accept) && !Dashboard.allowsSubframe(url, host, port)) return forbidden()
            return null
        }

        override fun onPageFinished(view: WebView, url: String?) {
            // The page is laid out at the tablet's width and cannot be pinch-zoomed.
            if (!destroyed && Dashboard.allowsMainFrame(url, host, port)) view.evaluateJavascript(VIEWPORT_SCRIPT, null)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) fail()
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 400) fail()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The view is unusable: the next dashboard comes in a new one.
            fail()
            destroy()
            return true
        }
    }

    private class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?,
        ): Boolean = false
    }

    companion object {
        /** The name the page finds the app under: `window.fremkit` (`ui/src/dashboard/native.ts`). */
        const val LISTENER = "fremkit"

        /** What the iPad's `DashboardView` injects at document end. */
        private const val VIEWPORT_SCRIPT = """
            (function () {
              var m = document.querySelector('meta[name=viewport]');
              if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
              m.content = 'width=device-width, initial-scale=1, user-scalable=no';
            })();
        """

        private fun forbidden() =
            WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

        /**
         * The pin of the certificate WebView refused: base64url SHA-256 of a P-256 leaf's SPKI, null
         * for anything else. API 28 has no `SslCertificate.getX509Certificate()` (29), so the
         * certificate is rebuilt from the DER `saveState` keeps.
         */
        fun keyHashOf(certificate: SslCertificate?): String? {
            certificate ?: return null
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                certificate.x509Certificate?.let { return Pin.keyHashOf(it) }
            }
            val der = SslCertificate.saveState(certificate)?.getByteArray("x509-certificate") ?: return null
            return Pin.keyHashOfCertificate(der)
        }
    }
}
