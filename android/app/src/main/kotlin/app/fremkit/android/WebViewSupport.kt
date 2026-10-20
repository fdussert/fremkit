package app.fremkit.android

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether this tablet's System WebView can run the dashboard: the page talks to the app through a
 * web message listener, which needs WebView 82 or later. An older one gets the "update Android
 * System WebView" screen instead of a dashboard that would lose the revocation message and
 * brightness. No degraded mode.
 *
 * [check] runs before the first WebView is created and again on every `onStart`, so an update made
 * while the app was in the background is picked up without a restart.
 */
class WebViewSupport(private val context: Context) {
    /** The WebView this tablet has, when it is too old (or missing). */
    data class Outdated(val versionName: String?, val packageName: String?)

    private val _outdated = MutableStateFlow<Outdated?>(null)

    /** Null while the WebView is recent enough. */
    val outdated: StateFlow<Outdated?> = _outdated.asStateFlow()

    fun check() {
        val supported = try {
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        } catch (_: RuntimeException) {
            // No WebView provider at all (disabled, being updated).
            false
        }
        if (supported) {
            _outdated.value = null
            return
        }
        val pkg = try {
            WebViewCompat.getCurrentWebViewPackage(context)
        } catch (_: RuntimeException) {
            null
        }
        _outdated.value = Outdated(pkg?.versionName, pkg?.packageName)
    }
}

/**
 * What the WebView remembers across instances, kept in step with the pin.
 *
 * WebView remembers a `proceed()` per host and certificate for the life of the process, whatever
 * instance took it: after a pin change (pair, forget, pair again), a decision taken under the old
 * pin would be reused for a certificate the new one refuses. So every pin change, and the process
 * start, leaves [prepare] a clear to do on the next WebView, before its first load. The device
 * cookie lives in the process-wide [CookieManager], which may write to the app's data folder: it
 * is dropped at the same moments, and before each dashboard load sets it again.
 *
 * Called on the main thread.
 */
class WebViewHygiene {
    private var sslClearPending = true

    /** The paired Mac changed identity. */
    fun pinChanged() {
        sslClearPending = true
        clearCookies()
    }

    /** Called on a new WebView before it loads anything. */
    fun prepare(web: WebView) {
        if (!sslClearPending) return
        web.clearSslPreferences()
        sslClearPending = false
    }

    companion object {
        /** Drops every cookie, in memory and on disk. Does nothing when there is no WebView provider. */
        fun clearCookies(then: () -> Unit = {}) {
            val cookies = try {
                CookieManager.getInstance()
            } catch (_: RuntimeException) {
                then()
                return
            }
            cookies.removeAllCookies {
                cookies.flush()
                then()
            }
        }
    }
}
