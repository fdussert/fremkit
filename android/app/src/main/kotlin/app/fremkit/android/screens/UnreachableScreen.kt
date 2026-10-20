package app.fremkit.android.screens

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.fremkit.android.R
import app.fremkit.kit.VersionNudge

/**
 * The paired Mac answers at none of its addresses (`UnreachableView.swift`). The model retries
 * every 5 s and when the network changes; the button retries now.
 */
@Composable
fun UnreachableScreen(name: String, isRetrying: Boolean, nudge: VersionNudge?, retry: () -> Unit) {
    ScreenColumn {
        Title(name)
        Body(stringResource(R.string.unreachable_title))
        Body(stringResource(R.string.unreachable_hint))
        PrimaryButton(stringResource(R.string.try_again), enabled = !isRetrying, onClick = retry)
        BusySpinner(isRetrying)
        NudgeLine(nudge)
    }
}
