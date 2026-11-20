package app.fremkit.android.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.fremkit.android.R
import app.fremkit.kit.VersionNudge

/**
 * The paired Mac answers at none of its addresses (`UnreachableView.swift`). The model retries
 * every 5 s and when the network changes; the button retries now. **Forget this Mac** is the way
 * out when the Mac is not coming back (sold, erased, Fremkit removed): the settings sheet had it
 * already, behind a long press on the Mac's name that nothing on the screen gives away. It asks
 * first, as the sheet does. The long press still opens the sheet (screen pinning, versions).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun UnreachableScreen(
    name: String,
    isRetrying: Boolean,
    nudge: VersionNudge?,
    openSettings: () -> Unit,
    forget: () -> Unit,
    retry: () -> Unit,
) {
    var confirmForget by remember { mutableStateOf(false) }

    ScreenColumn {
        Title(name, Modifier.combinedClickable(onLongClick = openSettings, onClick = {}))
        Body(stringResource(R.string.unreachable_title))
        Body(stringResource(R.string.unreachable_hint))
        PrimaryButton(stringResource(R.string.try_again), enabled = !isRetrying, onClick = retry)
        SecondaryButton(stringResource(R.string.unreachable_forget)) { confirmForget = true }
        BusySpinner(isRetrying)
        NudgeLine(nudge)
    }

    if (confirmForget) {
        ForgetDialog(
            confirm = {
                confirmForget = false
                forget()
            },
            dismiss = { confirmForget = false },
        )
    }
}
