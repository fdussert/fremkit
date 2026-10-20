package app.fremkit.android.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.fremkit.android.R
import app.fremkit.kit.VersionNudge

/** Not paired yet: scan the Mac's QR code, or pick the Mac and type its code (`WelcomeView.swift`). */
@Composable
fun WelcomeScreen(credentialsUnreadable: Boolean, nudge: VersionNudge?, scan: () -> Unit, enterCode: () -> Unit) {
    ScreenColumn {
        Text("Fremkit", fontSize = 56.sp, fontWeight = FontWeight.Bold)
        Text(
            stringResource(R.string.welcome_tagline),
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            PrimaryButton(stringResource(R.string.welcome_scan), onClick = scan)
            SecondaryButton(stringResource(R.string.welcome_enter_code), onClick = enterCode)
        }
        if (credentialsUnreadable) Body(stringResource(R.string.welcome_credentials_unreadable))
        NudgeLine(nudge)
    }
}
