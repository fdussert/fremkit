package app.fremkit.android

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.fremkit.kit.AppState
import app.fremkit.kit.LinkSource
import app.fremkit.kit.PairingStep
import kotlinx.coroutines.launch

/**
 * The app's one activity (`singleTask`; no configuration change recreates it, so a rotation keeps
 * the WebView). It shows [Root] and ties the app's model to its lifecycle: started, the model's
 * checks and retries run ([app.fremkit.kit.AppModel.run]); back in front, the model asks the Mac
 * again ([app.fremkit.kit.AppModel.resume], the iPad's `scenePhase == .active`); stopped, they stop.
 */
class MainActivity : ComponentActivity() {
    private val app: FremkitApplication get() = application as FremkitApplication
    private var started = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Full screen from the first frame: the region pairing measures is the dashboard's.
        Immersive.apply(window)
        // Before the first WebView exists: an outdated one never gets to show a half dashboard.
        app.webView.check()
        // The window the Mac's brightness target is set on (re-applied to a new activity).
        app.brightness.attach(window)
        setContent {
            Root(app.model, app.flow, app.meter, app.hygiene, app.webView, app.restarting, app.network, app.brightness, appVersion = BuildConfig.VERSION_NAME)
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { app.model.run() }
        }
        // A link this activity was started with; not again when the system recreates it from history.
        if (savedInstanceState == null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0) openLink(intent)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    // Out of pairing, back to whatever the model shows.
                    app.flow.step != PairingStep.Idle -> app.flow.cancel()
                    // Finishing would drop the page and its socket: the dashboard goes to the
                    // background instead, as the home button does.
                    app.model.state.value is AppState.Dashboard -> moveTaskToBack(true)
                    else -> finish()
                }
            }
        })
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // A dialog, the keyboard or a swipe from the edge may have brought the bars back.
        if (hasFocus) Immersive.apply(window)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openLink(intent)
    }

    /**
     * A `fremkit://pair` link another app opened (a camera app that read the Mac's QR code, a
     * browser). Any installed app can send one, so it always waits for the user's word, paired or
     * not ([LinkSource.INTENT]); the app's own scanner does not ask. Read once.
     */
    private fun openLink(intent: Intent) {
        if (intent.action != Intent.ACTION_VIEW) return
        val url = intent.dataString ?: return
        intent.data = null
        // The link itself is never logged: it carries the code's secret.
        if (!app.flow.handle(url, LinkSource.INTENT)) Log.w(TAG, "a link that is not a pairing link")
    }

    override fun onStart() {
        super.onStart()
        app.webView.check()
        app.network.start()
        if (started) app.model.resume()
        started = true
        Seed.take(this)?.let { link ->
            // The link itself is never logged: it carries the code's secret.
            if (!app.flow.handle(link, LinkSource.SCANNER)) Log.w(TAG, "the seeded file is not a pairing link")
        }
    }

    override fun onDestroy() {
        app.brightness.detach(window)
        super.onDestroy()
    }

    override fun onStop() {
        app.network.stop()
        super.onStop()
    }

    private companion object {
        const val TAG = "Fremkit"
    }
}
