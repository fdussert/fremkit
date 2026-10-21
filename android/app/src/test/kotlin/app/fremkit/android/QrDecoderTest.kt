package app.fremkit.android

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The scanner's decoder on QR codes generated here, laid out as a camera's Y plane: dark modules
 * on a light background, rows padded to a stride, the code somewhere in the frame.
 */
class QrDecoderTest {
    /** The shared vectors' link (test-vectors/devices.json, "a link with the secret"): public test data. */
    private val link = "fremkit://pair?h=studio.local&a=192.0.2.10&p=4243&c=ABCDEFGH" +
        "&s=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE&k=Y4nRTFWKfvKwllWID7DQPMgZIF8SqUUvgWkQZsK_ArQ"

    private class Frame(val bytes: ByteArray, val rowStride: Int, val width: Int, val height: Int)

    /** A [width] × [height] frame with [text]'s QR code drawn [size] px wide at ([left], [top]). */
    private fun frame(
        text: String,
        width: Int = 1280,
        height: Int = 720,
        rowStride: Int = 1344,
        size: Int = 400,
        left: Int = 300,
        top: Int = 150,
        dark: Int = 30,
        light: Int = 220,
    ): Frame {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 2))
        val bytes = ByteArray(rowStride * height) { light.toByte() }
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                if (matrix[x, y]) bytes[(top + y) * rowStride + left + x] = dark.toByte()
            }
        }
        return Frame(bytes, rowStride, width, height)
    }

    private fun decode(f: Frame) = QrDecoder.decode(f.bytes, f.rowStride, f.width, f.height)

    @Test
    fun readsAPairingLink() {
        assertEquals(link, decode(frame(link)))
    }

    @Test
    fun readsItAnywhereInTheFrameWithOrWithoutRowPadding() {
        assertEquals(link, decode(frame(link, rowStride = 1280, left = 0, top = 0)))
        assertEquals(link, decode(frame(link, left = 860, top = 300)))
    }

    @Test
    fun readsADimScreen() {
        // A screen filmed in a bright room: dark grey on light grey.
        assertEquals(link, decode(frame(link, dark = 70, light = 180)))
    }

    @Test
    fun readsAnyText() {
        // Not every code is a pairing link; the flow decides (PairingFlow.scanned).
        assertEquals("https://example.com/", decode(frame("https://example.com/")))
    }

    @Test
    fun nothingInABlankFrame() {
        val blank = ByteArray(1280 * 720) { 128.toByte() }
        assertNull(QrDecoder.decode(blank, 1280, 1280, 720))
    }

    @Test
    fun nothingFromABufferTooSmallForItsSize() {
        val f = frame(link)
        assertNull(QrDecoder.decode(f.bytes.copyOf(f.bytes.size - 1), f.rowStride, f.width, f.height))
        assertNull(QrDecoder.decode(f.bytes, f.width - 1, f.width, f.height))
        assertNull(QrDecoder.decode(ByteArray(0), 0, 0, 0))
    }
}
