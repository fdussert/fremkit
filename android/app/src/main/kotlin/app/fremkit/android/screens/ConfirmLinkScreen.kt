package app.fremkit.android.screens

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.fremkit.android.R
import app.fremkit.kit.PairingLink
import app.fremkit.kit.macName

/**
 * A pairing link waiting for the user's word ([app.fremkit.kit.PairingFlow.pendingLink]).
 *
 * - Paired: it would replace the pairing, as on the iPad.
 * - Not paired: only a link from another app gets here. Any installed app can open a
 *   `fremkit://pair` link; without this question, one could pair the tablet with a machine of its
 *   choosing and show its pages. The question names the Mac and where it is, so the user can tell
 *   it is theirs.
 */
@Composable
fun ConfirmLinkDialog(link: PairingLink, pairedName: String?, confirm: () -> Unit, decline: () -> Unit) {
    val replacing = pairedName != null
    AlertDialog(
        onDismissRequest = decline,
        title = {
            Text(
                if (replacing) {
                    stringResource(R.string.pairing_replace_title, pairedName.orEmpty())
                } else {
                    stringResource(R.string.pairing_confirm_title, link.macName)
                },
            )
        },
        text = {
            Text(
                if (replacing) {
                    stringResource(R.string.pairing_replace_body, link.macName)
                } else {
                    stringResource(R.string.pairing_confirm_body, link.host, link.address)
                },
            )
        },
        confirmButton = {
            TextButton(onClick = confirm) {
                Text(stringResource(if (replacing) R.string.pairing_replace else R.string.pairing_pair))
            }
        },
        dismissButton = { TextButton(onClick = decline) { Text(stringResource(R.string.pairing_cancel)) } },
    )
}
