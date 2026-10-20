package app.fremkit.android

import android.app.Application
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import app.fremkit.kit.AppModel
import app.fremkit.kit.AppState
import app.fremkit.kit.PairingFlow
import app.fremkit.kit.ViewportMeter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The app's objects, built by hand (no DI framework) and kept for the life of the process, so the
 * pairing state survives the activity: the Keystore store, the [AppModel] over the kit's
 * `Connector`, [PairingFlow], the viewport meter, the WebView checks and the network watch.
 */
class FremkitApplication : Application() {
    lateinit var model: AppModel
        private set
    lateinit var flow: PairingFlow
        private set
    lateinit var network: LocalNetwork
        private set
    val meter = ViewportMeter()

    /** A pin change after a WebView loaded restarts the process; before, clearing in place is enough. */
    private val pinChange: PinChangeGuard = PinChangeGuard(
        restartProcess = {
            _restarting.value = true
            ProcessRestart.now(this)
        },
        clearInProcess = { hygiene.pinChanged() },
    )
    val hygiene: WebViewHygiene = WebViewHygiene(onLoad = { pinChange.webViewLoading() })

    private val _restarting = MutableStateFlow(false)

    /** True once this process is restarting after a pin change: the screens show nothing new. */
    val restarting: StateFlow<Boolean> = _restarting.asStateFlow()
    lateinit var webView: WebViewSupport
        private set

    private val scope = MainScope()

    override fun onCreate() {
        super.onCreate()
        // The restart helper's process only kills and relaunches this one: no model, no network.
        if (ProcessRestart.isHelperProcess()) return
        try {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        } catch (_: RuntimeException) {
            // No WebView provider: WebViewSupport says so on screen.
        }
        // Whatever an earlier process left in the WebView's cookie jar goes: the device cookie is
        // set again before each load. (The SSL decisions die with the process; the hygiene clears
        // them anyway before the first WebView.)
        WebViewHygiene.clearCookies()
        webView = WebViewSupport(this)

        val main = Dispatchers.Main.immediate
        // NSD's addresses are candidates too, read at the start of each attempt.
        model = AppModel(store = KeystoreCredentialStore(this), discovered = { network.addresses }, dispatcher = main)
        flow = PairingFlow(
            model = model,
            dispatcher = main,
            deviceName = { deviceName() },
            viewport = { meter.viewport() },
        )
        // A pin change clears the WebView's SSL decisions and cookies before the next WebView, or,
        // once a WebView has loaded, restarts the process so no pooled connection survives it.
        scope.launch { model.macIdentityChanged.collect { pinChange.pinChanged() } }
        // A network that comes back or changes, or a Mac found at a new address, is a reason to try
        // now (the iPad's onChange).
        network = LocalNetwork(this) {
            when (model.state.value) {
                is AppState.Unreachable, is AppState.KeyChanged -> model.reconnect()
                is AppState.Dashboard -> model.addressesChanged()
                else -> Unit
            }
        }
        model.start()
    }

    /** This tablet's name for the Mac: the one set in the system's settings, else its model. */
    private fun deviceName(): String =
        Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)?.trim()?.takeIf { it.isNotEmpty() }
            ?: Build.MODEL
}
