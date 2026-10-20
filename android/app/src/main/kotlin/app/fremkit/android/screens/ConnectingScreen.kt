package app.fremkit.android.screens

import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.fremkit.android.R

/** Looking for the paired Mac, nothing to show yet (`ConnectingView` in `RootView.swift`). */
@Composable
fun ConnectingScreen(name: String?) {
    ScreenColumn {
        CircularProgressIndicator()
        Body(if (name != null) stringResource(R.string.connecting_to, name) else stringResource(R.string.connecting))
    }
}
