package app.fremkit.android.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.fremkit.android.R
import app.fremkit.kit.VersionNudge

/**
 * The paired Mac answers at none of its addresses (`UnreachableView.swift`). The model retries
 * every 5 s and when the network changes; the button retries now. A long press on the Mac's name
 * opens the settings sheet (forget this Mac, screen pinning).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun UnreachableScreen(name: String, isRetrying: Boolean, nudge: VersionNudge?, openSettings: () -> Unit, retry: () -> Unit) {
    ScreenColumn {
        Title(name, Modifier.combinedClickable(onLongClick = openSettings, onClick = {}))
        Body(stringResource(R.string.unreachable_title))
        Body(stringResource(R.string.unreachable_hint))
        PrimaryButton(stringResource(R.string.try_again), enabled = !isRetrying, onClick = retry)
        BusySpinner(isRetrying)
        NudgeLine(nudge)
    }
}
