package app.fremkit.android.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.fremkit.android.R
import app.fremkit.kit.VersionNudge

/** Dark, like the dashboard it stands in for: black, Fremkit's accent. */
@Composable
fun FremkitTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Color(0xFFD9B36A),
            onPrimary = Color(0xFF0B0D10),
            background = Color.Black,
            surface = Color.Black,
        ),
    ) {
        // Text and spinners take the scheme's light colour on black, not the default black.
        Surface(color = Color.Black, contentColor = MaterialTheme.colorScheme.onBackground, content = content)
    }
}

/** Every screen but the dashboard: a centred column, at most 640 dp wide, scrolling if it must. */
@Composable
fun ScreenColumn(content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier
                .widthIn(max = 640.dp)
                .verticalScroll(rememberScrollState())
                .padding(40.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            content = content,
        )
    }
}

@Composable
fun Title(text: String) {
    Text(text, style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
}

@Composable
fun Body(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )
}

/** Touch targets meant to be hit while glancing: 56 dp. */
@Composable
fun PrimaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, modifier = Modifier.widthIn(min = 200.dp).heightIn(min = 56.dp)) {
        Text(text)
    }
}

@Composable
fun SecondaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = Modifier.widthIn(min = 200.dp).heightIn(min = 56.dp)) {
        Text(text)
    }
}

/**
 * A spinner that keeps its place when hidden, so the screen does not jump while retrying. Hidden,
 * it is an empty box of its size: an invisible indeterminate indicator would still animate, and
 * redraw the window at every frame for nothing.
 */
@Composable
fun BusySpinner(visible: Boolean) {
    if (visible) CircularProgressIndicator() else Spacer(Modifier.size(SPINNER_SIZE))
}

/** Material's indeterminate indicator's size. */
private val SPINNER_SIZE = 40.dp

/**
 * The one discreet line about the Mac's Fremkit version next to the app's: never over the
 * dashboard, nothing when they match or the Mac does not say.
 */
@Composable
fun NudgeLine(nudge: VersionNudge?) {
    val text = when (nudge) {
        VersionNudge.UPDATE_MAC -> stringResource(R.string.nudge_update_mac)
        VersionNudge.UPDATE_APP -> stringResource(R.string.nudge_update_app)
        null -> return
    }
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )
}

/** The activity a composable runs in. */
tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/**
 * Keeps the window out of screenshots, screen recordings and the recent-apps thumbnail while this
 * is on screen: the pairing screens show the code, the camera's view of it and the key's words.
 * Never on the dashboard.
 */
@Composable
fun SecureWindow() {
    val activity = LocalContext.current.findActivity()
    DisposableEffect(activity) {
        val window = activity?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
}
