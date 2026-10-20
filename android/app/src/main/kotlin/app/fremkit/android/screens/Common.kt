package app.fremkit.android.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
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

/** A spinner that keeps its place when hidden, so the screen does not jump while retrying. */
@Composable
fun BusySpinner(visible: Boolean) {
    CircularProgressIndicator(Modifier.alpha(if (visible) 1f else 0f))
}

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
