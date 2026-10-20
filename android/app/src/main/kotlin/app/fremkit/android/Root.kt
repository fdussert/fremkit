package app.fremkit.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.fremkit.android.screens.ConnectingScreen
import app.fremkit.android.screens.FremkitTheme
import app.fremkit.android.screens.KeyChangedScreen
import app.fremkit.android.screens.LinkPairingScreen
import app.fremkit.android.screens.OutdatedWebViewScreen
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
import app.fremkit.kit.macName

/**
 * One screen per [AppState], or the pairing screen while pairing runs (`RootView.swift`). An
 * outdated System WebView comes before everything: no WebView is made until it is recent enough.
 *
 * Every screen is laid out in the same region, the dashboard's WebView included; that region is
 * what pairing reports as the viewport ([ViewportMeter]), so it is measured here, on the container
 * itself, in dp (a CSS pixel in the WebView at text zoom 100 %).
 */
@Composable
fun Root(
    model: AppModel,
    flow: PairingFlow,
    meter: ViewportMeter,
    hygiene: WebViewHygiene,
    webView: WebViewSupport,
    appVersion: String,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val mac by model.mac.collectAsStateWithLifecycle()
    val isConnecting by model.isConnecting.collectAsStateWithLifecycle()
    val credentialsUnreadable by model.credentialsUnreadable.collectAsStateWithLifecycle()
    val serverVersion by model.serverVersion.collectAsStateWithLifecycle()
    val pairing by flow.state.collectAsStateWithLifecycle()
    val outdated by webView.outdated.collectAsStateWithLifecycle()
    val density = LocalDensity.current.density.toDouble()
    val nudge = VersionNudge.of(serverVersion, appVersion)

    FremkitTheme {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .onSizeChanged { meter.measured(MeasuredSize(it.width / density, it.height / density)) },
        ) {
            val step = pairing.step
            val current = outdated
            when {
                current != null -> OutdatedWebViewScreen(current, checkAgain = webView::check)
                step is PairingStep.Link -> LinkPairingScreen(
                    link = step.link,
                    isWorking = pairing.isWorking,
                    problem = pairing.problem,
                    retry = { flow.retry() },
                    cancel = flow::cancel,
                )
                // The scanner and the manual path have no screens yet: nothing starts them.
                else -> when (val s = state) {
                    AppState.Welcome -> WelcomeScreen(credentialsUnreadable, nudge)
                    AppState.Connecting -> ConnectingScreen(mac?.name)
                    is AppState.Dashboard -> mac?.let { DashboardScreen(s.host, it, model, hygiene) }
                    is AppState.Unreachable -> UnreachableScreen(s.name, isConnecting, nudge) { model.reconnect() }
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

        // A link that would replace a working pairing waits for the user's word.
        pairing.pendingLink?.let { link ->
            AlertDialog(
                onDismissRequest = flow::declineLink,
                title = { Text(stringResource(R.string.pairing_replace_title, mac?.name.orEmpty())) },
                text = { Text(stringResource(R.string.pairing_replace_body, link.macName)) },
                confirmButton = { TextButton(onClick = flow::confirmLink) { Text(stringResource(R.string.pairing_replace)) } },
                dismissButton = { TextButton(onClick = flow::declineLink) { Text(stringResource(R.string.pairing_cancel)) } },
            )
        }
    }
}

/**
 * The dashboard: one [DashboardWebView] per host (a new host, a new view), paused and resumed with
 * the activity, destroyed when the dashboard goes. What the page says goes to the model.
 */
@Composable
private fun DashboardScreen(host: String, mac: PairedMac, model: AppModel, hygiene: WebViewHygiene) {
    val context = LocalContext.current
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
                        // Brightness and the screen id are for the brightness hand, not here yet.
                        is PageMessage.Brightness, is PageMessage.Screen -> Unit
                    }
                },
                onFailure = { model.dashboardFailed() },
            ).also { it.load() }
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
