package app.fremkit.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * A QR code read from a camera frame's luminance: the Y plane CameraX hands the analyzer, as
 * ZXing core reads it (pure Java: no native library, nothing from Google Play services). Default
 * hints: no `TRY_HARDER`, no `PURE_BARCODE`; the code on a Mac's screen is large and sharp.
 *
 * No Android type: tested on the JVM with generated codes.
 */
object QrDecoder {
    /**
     * The text of the QR code in a [width] × [height] luminance image whose rows are [rowStride]
     * bytes apart, or null when there is none (or it cannot be read).
     */
    fun decode(luminance: ByteArray, rowStride: Int, width: Int, height: Int): String? {
        if (width <= 0 || height <= 0 || rowStride < width || luminance.size < rowStride * height) return null
        val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
        return try {
            QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source))).text
        } catch (_: ReaderException) {
            null
        }
    }
}

/**
 * The camera, for the scanner screen: a preview, and frames decoded on a worker thread. Each text
 * a frame holds goes to [onText] on the main thread ([app.fremkit.kit.PairingFlow.scanned] keeps
 * only a pairing link, and stops the scan on the first). [onUnavailable] when no camera can be
 * opened.
 */
class QrScanner(
    private val context: Context,
    private val onText: (String) -> Unit,
    private val onUnavailable: () -> Unit,
) {
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var provider: ProcessCameraProvider? = null
    private var closed = false

    /** Starts the camera for [owner]'s lifecycle, showing it in [preview]. */
    fun bind(owner: LifecycleOwner, preview: PreviewView) {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (closed) return@addListener
            try {
                val cameras = future.get()
                provider = cameras
                val selector = when {
                    cameras.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
                    cameras.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) -> CameraSelector.DEFAULT_FRONT_CAMERA
                    else -> return@addListener onUnavailable()
                }
                val shown = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(
                                ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                            )
                            .build(),
                    )
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(worker) { image -> image.use { read(it) }?.let { text -> main.post { if (!closed) onText(text) } } }
                cameras.unbindAll()
                cameras.bindToLifecycle(owner, selector, shown, analysis)
            } catch (_: Exception) {
                // No camera service, a camera in use by another app, a device that refuses the
                // configuration: the manual path is still there.
                onUnavailable()
            }
        }, ContextCompat.getMainExecutor(context))
    }

    /** Stops the camera and the worker. */
    fun close() {
        closed = true
        provider?.unbindAll()
        provider = null
        worker.shutdown()
    }

    /** The Y plane of [image], copied with its row stride, decoded. */
    private fun read(image: ImageProxy): String? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer.duplicate().apply { rewind() }
        val rowStride = plane.rowStride
        // The last row may be shorter than the stride: the array is sized for full rows.
        val bytes = ByteArray(rowStride * image.height)
        buffer.get(bytes, 0, minOf(buffer.remaining(), bytes.size))
        return QrDecoder.decode(bytes, rowStride, image.width, image.height)
    }
}
