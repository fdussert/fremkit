package app.fremkit.android.screens

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.fremkit.android.R

/**
 * The Mac answered with a key other than the pinned one: its certificate was reset in Fremkit, or
 * another machine holds its address (`KeyChangedView.swift`). The model keeps retrying (a transient
 * mismatch recovers by itself); **Pair again** forgets the pairing, which only the user decides.
 */
@Composable
fun KeyChangedScreen(name: String, isRetrying: Boolean, pairAgain: () -> Unit, retry: () -> Unit) {
    ScreenColumn {
        Title(name)
        Body(stringResource(R.string.key_changed_title))
        Body(stringResource(R.string.key_changed_body))
        PrimaryButton(stringResource(R.string.pair_again), onClick = pairAgain)
        SecondaryButton(stringResource(R.string.try_again), enabled = !isRetrying, onClick = retry)
        BusySpinner(isRetrying)
    }
}
