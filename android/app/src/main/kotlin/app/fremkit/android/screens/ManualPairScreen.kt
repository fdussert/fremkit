package app.fremkit.android.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.fremkit.android.R
import app.fremkit.kit.DiscoveredMac
import app.fremkit.kit.MacService
import app.fremkit.kit.PairingProblem
import app.fremkit.kit.PairingStep
import app.fremkit.kit.normaliseCode
import kotlinx.coroutines.delay

/**
 * Pairing without the camera (`ManualPairView.swift`): pick the Mac NSD found, check that it shows
 * the same four words as this screen, type the code it shows.
 */
@Composable
fun ManualPairScreen(
    step: PairingStep,
    isWorking: Boolean,
    problem: PairingProblem?,
    words: List<String>,
    macs: Map<String, DiscoveredMac>,
    refresh: () -> Unit,
    choose: (MacService) -> Unit,
    submit: (String) -> Unit,
    otherMac: () -> Unit,
    cancel: () -> Unit,
) {
    when (step) {
        is PairingStep.ManualKey -> ScreenColumn {
            CircularProgressIndicator()
            Body(stringResource(R.string.connecting_to, step.service.name))
            CancelButton(cancel)
        }
        is PairingStep.ManualCode -> CodeEntry(step.service, words, isWorking, problem, submit, otherMac, cancel)
        else -> MacList(macs, problem, refresh, choose, cancel)
    }
}

/**
 * The Macs advertising Fremkit, by name, listed as soon as NSD sees them; one whose address is
 * not known yet says so and cannot be picked. A hint shows when none has turned up after 5 s.
 */
@Composable
private fun MacList(
    macs: Map<String, DiscoveredMac>,
    problem: PairingProblem?,
    refresh: () -> Unit,
    choose: (MacService) -> Unit,
    cancel: () -> Unit,
) {
    var waitedLong by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(5_000)
        waitedLong = true
    }
    LaunchedEffect(Unit) {
        // A Mac whose address is still pending is resolved again every few seconds.
        while (true) {
            delay(3_000)
            refresh()
        }
    }
    val sorted = macs.values.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    ScreenColumn {
        Title(stringResource(R.string.manual_choose))
        if (sorted.isEmpty()) {
            CircularProgressIndicator()
            if (waitedLong) Body(stringResource(R.string.manual_none_yet))
        } else {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                sorted.forEach { mac -> MacRow(mac) { mac.service?.let(choose) } }
            }
        }
        ProblemLine(problem)
        CancelButton(cancel)
    }
}

@Composable
private fun MacRow(mac: DiscoveredMac, pick: () -> Unit) {
    OutlinedButton(
        onClick = pick,
        enabled = mac.service != null,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(mac.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            if (mac.service == null) {
                Text(stringResource(R.string.manual_looking), style = MaterialTheme.typography.bodySmall)
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                Spacer(Modifier.size(20.dp))
            }
        }
    }
}

/**
 * The Mac's four words, big, and the code field. **Pair** sends a proof of the code under the key
 * those words came from, which is the pin from then on. The code is held in this screen's memory
 * only: not in saved state, not after it closes. The keyboard is a password one, so it neither
 * suggests nor learns what is typed.
 */
@Composable
private fun CodeEntry(
    service: MacService,
    words: List<String>,
    isWorking: Boolean,
    problem: PairingProblem?,
    submit: (String) -> Unit,
    otherMac: () -> Unit,
    cancel: () -> Unit,
) {
    SecureWindow()
    var code by remember { mutableStateOf("") }
    val canPair = !isWorking && normaliseCode(code) != null
    ScreenColumn {
        Title(service.name)
        Text(
            words.joinToString("  "),
            fontSize = 40.sp,
            // Its own line height: the inherited one is for body text, and two lines would overlap.
            lineHeight = 48.sp,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary,
            textAlign = TextAlign.Center,
        )
        Body(stringResource(R.string.manual_check_words))
        OutlinedTextField(
            value = code,
            onValueChange = { typed -> code = typed.uppercase().take(12) },
            label = { Text(stringResource(R.string.manual_code)) },
            singleLine = true,
            textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 32.sp, textAlign = TextAlign.Center),
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Go,
            ),
            keyboardActions = KeyboardActions(onGo = { if (canPair) submit(code) }),
            modifier = Modifier.widthIn(max = 360.dp),
        )
        PrimaryButton(stringResource(R.string.pairing_pair), enabled = canPair) { submit(code) }
        BusySpinner(isWorking)
        ProblemLine(problem)
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            TextButton(onClick = otherMac, modifier = Modifier.heightIn(min = 56.dp)) {
                Text(stringResource(R.string.manual_other_mac))
            }
            CancelButton(cancel)
        }
    }
}

@Composable
private fun CancelButton(cancel: () -> Unit) {
    TextButton(onClick = cancel, modifier = Modifier.heightIn(min = 56.dp)) {
        Text(stringResource(R.string.pairing_cancel))
    }
}
