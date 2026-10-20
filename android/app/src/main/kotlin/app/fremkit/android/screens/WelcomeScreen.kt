package app.fremkit.android.screens

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import app.fremkit.android.R
import app.fremkit.kit.VersionNudge

/**
 * Not paired yet (`WelcomeView.swift`). The ways to pair (scan the code, enter it) come with the
 * pairing screens; until then a debug build is paired with a seeded link.
 */
@Composable
fun WelcomeScreen(credentialsUnreadable: Boolean, nudge: VersionNudge?) {
    ScreenColumn {
        Text("Fremkit", fontSize = 56.sp, fontWeight = FontWeight.Bold)
        Text(
            stringResource(R.string.welcome_tagline),
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (credentialsUnreadable) Body(stringResource(R.string.welcome_credentials_unreadable))
        NudgeLine(nudge)
    }
}
