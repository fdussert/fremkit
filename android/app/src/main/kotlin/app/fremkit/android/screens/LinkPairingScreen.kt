package app.fremkit.android.screens

import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.unit.dp
import app.fremkit.android.R
import app.fremkit.kit.PairingLink
import app.fremkit.kit.PairingProblem
import app.fremkit.kit.macName

/**
 * A pairing link being paired (`LinkPairingView` in the iPad's `PairingFlow.swift`): it starts on
 * its own; after a failure the reason shows under **Try again**.
 */
@Composable
fun LinkPairingScreen(link: PairingLink, isWorking: Boolean, problem: PairingProblem?, retry: () -> Unit, cancel: () -> Unit) {
    ScreenColumn {
        Title(stringResource(R.string.pairing_with, link.macName))
        if (problem == null) {
            CircularProgressIndicator()
        } else {
            PrimaryButton(stringResource(R.string.try_again), enabled = !isWorking, onClick = retry)
        }
        ProblemLine(problem)
        TextButton(onClick = cancel, modifier = Modifier.heightIn(min = 56.dp)) {
            Text(stringResource(R.string.pairing_cancel))
        }
    }
}

/** Why the last request failed, or nothing. */
@Composable
fun ProblemLine(problem: PairingProblem?) {
    val text = when (problem) {
        null -> return
        // The Mac's own words, already in the Mac's language.
        is PairingProblem.Refused -> problem.message.ifEmpty { stringResource(R.string.pairing_refused) }
        PairingProblem.Unreachable -> stringResource(R.string.unreachable_title)
        PairingProblem.WrongMac -> stringResource(R.string.pairing_wrong_mac)
        PairingProblem.InvalidRequest -> stringResource(R.string.pairing_invalid_request)
        PairingProblem.NoCode -> stringResource(R.string.pairing_no_code)
        PairingProblem.NotSaved -> stringResource(R.string.pairing_not_saved)
    }
    Text(text, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
}
