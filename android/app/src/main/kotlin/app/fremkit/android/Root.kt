package app.fremkit.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.fremkit.android.screens.ConfirmLinkDialog
import app.fremkit.android.screens.ConnectingScreen
import app.fremkit.android.screens.FremkitTheme
import app.fremkit.android.screens.KeyChangedScreen
import app.fremkit.android.screens.ManualPairScreen
import app.fremkit.android.screens.LinkPairingScreen
import app.fremkit.android.screens.OutdatedWebViewScreen
import app.fremkit.android.screens.ScannerScreen
import app.fremkit.android.screens.SettingsInfo
import app.fremkit.android.screens.SettingsSheet
import app.fremkit.android.screens.UnauthorizedScreen
import app.fremkit.android.screens.UnreachableScreen
import app.fremkit.android.screens.WelcomeScreen
import app.fremkit.kit.AppModel
import app.fremkit.kit.AppState
import app.fremkit.kit.MeasuredSize
import app.fremkit.kit.PageMessage
import app.fremkit.kit.PairedMac
import app.fremkit.kit.PairingFlow
import app.fremkit.kit.PairingStep
import app.fremkit.kit.ViewportMeter
import app.fremkit.kit.VersionNudge
import kotlinx.coroutines.flow.StateFlow

/**
 * One screen per [AppState], or the pairing screen while pairing runs (`RootView.swift`). An
 * outdated System WebView comes before everything: no WebView is made until it is recent enough.
 *
 * Every screen is laid out in the same region, the dashboard's WebView included; that region is
 * what pairing reports as the viewport ([ViewportMeter]), so it is measured here, on the container
 * itself, in dp (a CSS pixel in the WebView at text zoom 100 %), after immersive mode has hidden
 * the system bars ([Immersive]): the whole display but a notch. Bars that come back for a moment
 * (a swipe, a dialog) overlay it rather than shrink it, and the keyboard is left out of it too
 * (the window pans for the code field), so neither changes the page's size or the viewport
 * reported while pairing.
 */
@Composable
fun Root(
    model: AppModel,
    flow: PairingFlow,
    meter: ViewportMeter,
    hygiene: WebViewHygiene,
    webView: WebViewSupport,
    restarting: StateFlow<Boolean>,
    network: LocalNetwork,
    brightness: ScreenBrightness,
    appVersion: String,
    appBuild: Int,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val mac by model.mac.collectAsStateWithLifecycle()
    val isConnecting by model.isConnecting.collectAsStateWithLifecycle()
    val credentialsUnreadable by model.credentialsUnreadable.collectAsStateWithLifecycle()
    val serverVersion by model.serverVersion.collectAsStateWithLifecycle()
    val pairing by flow.state.collectAsStateWithLifecycle()
    val outdated by webView.outdated.collectAsStateWithLifecycle()
    val isRestarting by restarting.collectAsStateWithLifecycle()
    val macs by network.macs.collectAsStateWithLifecycle()
    val density = LocalDensity.current.density.toDouble()
    val nudge = VersionNudge.of(serverVersion, appVersion)
    var settingsOpen by remember { mutableStateOf(false) }

    FremkitTheme {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .windowInsetsPadding(WindowInsets.displayCutout)
                .onSizeChanged { meter.measured(MeasuredSize(it.width / density, it.height / density)) },
        ) {
            val step = pairing.step
            val current = outdated
            when {
                // The process ends in a moment (a pin change): nothing of the new pairing starts here.
                isRestarting -> ConnectingScreen(mac?.name)
                current != null -> OutdatedWebViewScreen(current, checkAgain = webView::check)
                step == PairingStep.Scanning -> ScannerScreen(
                    scanned = { flow.scanned(it) },
                    enterCode = flow::enterCode,
                    cancel = flow::cancel,
                )
                step == PairingStep.ManualList || step is PairingStep.ManualAddress || step is PairingStep.ManualKey ||
                    step is PairingStep.ManualCode ->
                    ManualPairScreen(
                        step = step,
                        isWorking = pairing.isWorking,
                        problem = pairing.problem,
                        words = flow.words,
                        macs = macs,
                        refresh = network::refresh,
                        choose = { flow.choose(it) },
                        typeAddress = flow::typeAddress,
                        connect = { flow.connect(it) },
                        submit = { flow.submit(it) },
                        otherMac = flow::enterCode,
                        cancel = flow::cancel,
                    )
                step is PairingStep.Link -> LinkPairingScreen(
                    link = step.link,
                    isWorking = pairing.isWorking,
                    problem = pairing.problem,
                    retry = { flow.retry() },
                    cancel = flow::cancel,
                )
                else -> when (val s = state) {
                    AppState.Welcome -> WelcomeScreen(
                        credentialsUnreadable,
                        nudge,
                        scan = flow::scan,
                        enterCode = flow::enterCode,
                        openSettings = { settingsOpen = true },
                    )
                    AppState.Connecting -> ConnectingScreen(mac?.name)
                    is AppState.Dashboard -> mac?.let {
                        DashboardScreen(s.host, it, model, hygiene, brightness, openSettings = { settingsOpen = true })
                    }
                    is AppState.Unreachable -> UnreachableScreen(s.name, isConnecting, nudge, openSettings = { settingsOpen = true }) {
                        model.reconnect()
                    }
                    is AppState.KeyChanged -> KeyChangedScreen(
                        s.name,
                        isConnecting,
                        pairAgain = model::forget,
                        retry = { model.reconnect() },
                    )
                    AppState.Unauthorized -> UnauthorizedScreen(pairAgain = model::forget)
                }
            }
        }

        // Over the dashboard too, when the page's menu asked for it (`PageMessage.Settings`): the
        // sheet is a window of its own, so the bars it may bring back overlay the page without
        // resizing it, and the activity's window, focused again once it closes, goes back to
        // immersive (`MainActivity.onWindowFocusChanged`). Forgetting from there is the same
        // `model.forget`, which restarts the process once a WebView has loaded (`PinChangeGuard`).
        if (settingsOpen && !isRestarting) {
            SettingsSheet(
                SettingsInfo(
                    macName = mac?.name,
                    canForget = mac != null || credentialsUnreadable,
                    appVersion = appVersion,
                    appBuild = appBuild,
                    serverVersion = serverVersion,
                    nudge = nudge,
                ),
                forget = model::forget,
                close = { settingsOpen = false },
            )
        }

        // A link from another app, or one that would replace a working pairing, waits for the user's word.
        pairing.pendingLink?.let { link ->
            if (!isRestarting) ConfirmLinkDialog(link, pairedName = mac?.name, confirm = flow::confirmLink, decline = flow::declineLink)
        }
    }
}

/**
 * The dashboard: one [DashboardWebView] per host (a new host, a new view), paused and resumed with
 * the activity, destroyed when the dashboard goes. What the page says goes to the model, its menu's
 * settings request to [openSettings], and its brightness targets to [brightness], which reports the
 * screen's level to [host] while the dashboard is shown and the app started.
 */
@Composable
private fun DashboardScreen(
    host: String,
    mac: PairedMac,
    model: AppModel,
    hygiene: WebViewHygiene,
    brightness: ScreenBrightness,
    openSettings: () -> Unit,
) {
    val context = LocalContext.current
    // The WebView is remembered across recompositions; its listener reads the latest callback.
    val currentOpenSettings by rememberUpdatedState(openSettings)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    key(host) {
        val dashboard = remember {
            DashboardWebView(
                context = context,
                host = host,
                port = mac.port,
                mac = mac,
                hygiene = hygiene,
                onMessage = { message ->
                    when (message) {
                        PageMessage.Unauthorized -> model.pageSaidUnauthorized()
                        is PageMessage.Brightness -> brightness.receive(message.target, message.seq)
                        // The screen the Mac shows here: the page's business.
                        is PageMessage.Screen -> Unit
                        // The page's menu: the app's settings sheet, over the dashboard.
                        PageMessage.Settings -> currentOpenSettings()
                    }
                },
                onFailure = { model.dashboardFailed() },
            ).also { it.load() }
        }
        LaunchedEffect(mac, host) {
            brightness.show(mac, host)
            // Reports every 10 s while started; stopped, the Mac marks the screen gone after 30 s.
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { brightness.run() }
        }
        // Awake while the dashboard is shown, and only then (the iPad's isIdleTimerDisabled).
        val view = LocalView.current
        DisposableEffect(view) {
            view.keepScreenOn = true
            onDispose { view.keepScreenOn = false }
        }
        DisposableEffect(lifecycle, dashboard) {
            val observer = LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_START -> dashboard.onResume()
                    Lifecycle.Event.ON_STOP -> dashboard.onPause()
                    else -> Unit
                }
            }
            lifecycle.addObserver(observer)
            onDispose {
                lifecycle.removeObserver(observer)
                dashboard.destroy()
            }
        }
        // The view brings its own MATCH_PARENT layout params (DashboardWebView), which AndroidView keeps.
        AndroidView(factory = { dashboard.view }, modifier = Modifier.fillMaxSize())
    }
}
