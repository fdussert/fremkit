package app.fremkit.android.screens

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.fremkit.android.R

/**
 * Asks before forgetting the paired Mac, wherever the app offers it (the settings sheet, the
 * unreachable screen): a Mac that is only asleep would have to be paired again.
 */
@Composable
fun ForgetDialog(confirm: () -> Unit, dismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(stringResource(R.string.settings_forget_title)) },
        text = { Text(stringResource(R.string.settings_forget_body)) },
        confirmButton = {
            TextButton(onClick = confirm) { Text(stringResource(R.string.settings_forget_confirm)) }
        },
        dismissButton = {
            TextButton(onClick = dismiss) { Text(stringResource(R.string.pairing_cancel)) }
        },
    )
}
