package app.fremkit.android.screens

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import app.fremkit.android.R
import app.fremkit.android.WebViewSupport

/**
 * This tablet's System WebView is older than 82 (or missing): the dashboard needs its web message
 * listener, so no WebView is made and this shows instead. The button opens the WebView package's
 * page in the system settings, where it can be updated or enabled; **Check again** looks again
 * (as does coming back to the app).
 */
@Composable
fun OutdatedWebViewScreen(outdated: WebViewSupport.Outdated, checkAgain: () -> Unit) {
    val context = LocalContext.current
    ScreenColumn {
        Title(stringResource(R.string.webview_title))
        Body(
            outdated.versionName?.let { stringResource(R.string.webview_body, it) }
                ?: stringResource(R.string.webview_body_unknown),
        )
        outdated.packageName?.let { pkg ->
            PrimaryButton(stringResource(R.string.webview_open)) {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null))
                try {
                    context.startActivity(intent)
                } catch (_: ActivityNotFoundException) {
                    // A system without that settings page: nothing to open.
                }
            }
        }
        SecondaryButton(stringResource(R.string.webview_check_again), onClick = checkAgain)
    }
}
