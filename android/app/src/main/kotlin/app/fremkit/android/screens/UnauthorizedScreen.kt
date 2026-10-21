package app.fremkit.android.screens

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.fremkit.android.R

/** The Mac answered and no longer knows this tablet: it was removed there (`UnauthorizedView.swift`). */
@Composable
fun UnauthorizedScreen(pairAgain: () -> Unit) {
    ScreenColumn {
        Title(stringResource(R.string.unauthorized_title))
        Body(stringResource(R.string.unauthorized_body))
        PrimaryButton(stringResource(R.string.pair_again), onClick = pairAgain)
    }
}
