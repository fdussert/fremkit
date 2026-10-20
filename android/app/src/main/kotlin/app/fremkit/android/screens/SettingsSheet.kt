package app.fremkit.android.screens

import android.app.ActivityManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.fremkit.android.R
import app.fremkit.kit.VersionNudge

/** What the settings sheet shows. */
data class SettingsInfo(
    /** The paired Mac's name, or null when there is no pairing to forget. */
    val macName: String?,
    /** True when a stored pairing could not be read: it can be forgotten too. */
    val canForget: Boolean,
    val appVersion: String,
    val appBuild: Int,
    /** The Fremkit version the Mac said it runs, null when it did not. */
    val serverVersion: String?,
    val nudge: VersionNudge?,
)

/**
 * The app's small settings sheet (decision 3): screen pinning, forgetting the Mac, the versions.
 * Opened from the welcome screen's corner button or a long press on the unreachable screen's Mac
 * name; never over the dashboard, which stays the page's.
 *
 * **Pin this app** is Android's screen pinning (`startLockTask()` without device-owner
 * provisioning): the system asks the user, and they leave with the system's own gesture. It does
 * nothing visible while screen pinning is off in the system settings, which the hint says.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(info: SettingsInfo, forget: () -> Unit, close: () -> Unit) {
    val activity = LocalContext.current.findActivity()
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var confirmForget by remember { mutableStateOf(false) }
    val pinned = remember {
        activity?.getSystemService(ActivityManager::class.java)?.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    ModalBottomSheet(onDismissRequest = close, sheetState = state, containerColor = SHEET) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 32.dp, vertical = 8.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Title(stringResource(R.string.settings_title))
            if (pinned) {
                SheetButton(stringResource(R.string.settings_unpin)) {
                    activity?.stopLockTask()
                    close()
                }
            } else {
                SheetButton(stringResource(R.string.settings_pin)) {
                    activity?.startLockTask()
                    close()
                }
                Body(stringResource(R.string.settings_pin_hint))
            }
            if (info.canForget) {
                SheetButton(
                    if (info.macName != null) {
                        stringResource(R.string.settings_forget_mac, info.macName)
                    } else {
                        stringResource(R.string.settings_forget)
                    },
                ) { confirmForget = true }
            }
            Body(stringResource(R.string.settings_app_version, info.appVersion, info.appBuild))
            info.serverVersion?.let { Body(stringResource(R.string.settings_mac_version, it)) }
            NudgeLine(info.nudge)
            TextButton(onClick = close, modifier = Modifier.heightIn(min = 56.dp)) {
                Text(stringResource(R.string.settings_close))
            }
        }
    }

    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            title = { Text(stringResource(R.string.settings_forget_title)) },
            text = { Text(stringResource(R.string.settings_forget_body)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmForget = false
                    close()
                    forget()
                }) { Text(stringResource(R.string.settings_forget_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmForget = false }) { Text(stringResource(R.string.pairing_cancel)) }
            },
        )
    }
}

@Composable
private fun SheetButton(text: String, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary),
        modifier = Modifier.widthIn(min = 280.dp).heightIn(min = 56.dp),
    ) {
        Text(text)
    }
}

/** A dark grey just off the black screens behind it. */
private val SHEET = Color(0xFF17191D)

/** The corner button that opens the settings sheet: 56 dp, a vertical ellipsis. */
@Composable
fun SettingsButton(modifier: Modifier = Modifier, open: () -> Unit) {
    val label = stringResource(R.string.settings_open)
    IconButton(onClick = open, modifier = modifier.heightIn(min = 56.dp).widthIn(min = 56.dp).semantics { contentDescription = label }) {
        Text("⋮", fontSize = 28.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
