package app.fremkit.android.screens

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.fremkit.android.QrScanner
import app.fremkit.android.R

/**
 * The camera, looking for the Mac's QR code (`ScannerView.swift`). The camera permission is asked
 * the first time; refused, the screen says where to allow it, and the manual path stays one tap
 * away. Kept out of screenshots and the recent-apps thumbnail ([SecureWindow]): the code is on it.
 *
 * @param scanned what a frame held; the flow keeps only a pairing link (and stops the scan).
 */
@Composable
fun ScannerScreen(scanned: (String) -> Unit, enterCode: () -> Unit, cancel: () -> Unit) {
    SecureWindow()
    val context = LocalContext.current
    val hasCamera = remember { context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var refused by remember { mutableStateOf(false) }
    var unavailable by remember { mutableStateOf(!hasCamera) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        refused = !ok
    }
    LaunchedEffect(Unit) {
        if (hasCamera && !granted) ask.launch(Manifest.permission.CAMERA)
    }

    val controls: @Composable () -> Unit = {
        SecondaryButton(stringResource(R.string.welcome_enter_code), onClick = enterCode)
        TextButton(onClick = cancel, modifier = Modifier.heightIn(min = 56.dp)) {
            Text(stringResource(R.string.pairing_cancel))
        }
    }
    // A landscape tablet has no room for a 4:3 picture above the title and the buttons: the
    // picture goes on the left, the rest beside it, all on screen.
    val wide = LocalConfiguration.current.let { it.screenWidthDp > it.screenHeightDp }
    if (granted && !unavailable && wide) {
        Row(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            horizontalArrangement = Arrangement.spacedBy(32.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1.4f).fillMaxHeight(), contentAlignment = Alignment.Center) {
                CameraPreview(scanned = scanned, unavailable = { unavailable = true })
            }
            Column(
                modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Title(stringResource(R.string.scan_title))
                Body(stringResource(R.string.scan_hint))
                controls()
            }
        }
    } else {
        ScreenColumn {
            Title(stringResource(R.string.scan_title))
            when {
                unavailable -> Body(stringResource(R.string.scan_unavailable))
                granted -> {
                    CameraPreview(scanned = scanned, unavailable = { unavailable = true })
                    Body(stringResource(R.string.scan_hint))
                }
                refused -> {
                    Body(stringResource(R.string.scan_allow_camera))
                    SecondaryButton(stringResource(R.string.scan_open_settings)) {
                        context.startActivity(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }
                else -> Box(Modifier.heightIn(min = 56.dp))
            }
            controls()
        }
    }

    // Back from the system's settings with the camera allowed: start it.
    if (refused) {
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        DisposableEffect(lifecycle) {
            val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
                if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                ) {
                    granted = true
                    refused = false
                }
            }
            lifecycle.addObserver(observer)
            onDispose { lifecycle.removeObserver(observer) }
        }
    }
}

/** The camera's picture, its frames decoded while it is on screen. */
@Composable
private fun CameraPreview(scanned: (String) -> Unit, unavailable: () -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val preview = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    DisposableEffect(owner) {
        val scanner = QrScanner(context, onText = scanned, onUnavailable = unavailable)
        scanner.bind(owner, preview)
        onDispose { scanner.close() }
    }
    AndroidView(
        factory = { preview },
        modifier = Modifier
            .widthIn(max = 560.dp)
            .fillMaxWidth()
            .aspectRatio(4f / 3f)
            .clip(RoundedCornerShape(16.dp))
            .background(Color.DarkGray),
    )
}
