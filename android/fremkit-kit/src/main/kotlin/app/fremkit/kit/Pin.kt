package app.fremkit.kit

import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * The Mac's key pin: base64url (no padding) SHA-256 of the leaf certificate's
 * SubjectPublicKeyInfo, the same string as the QR's `k`.
 */
object Pin {
    /**
     * The DER prefix of a P-256 SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { id-ecPublicKey,
     * prime256v1 }, BIT STRING (66 bytes, 0 unused bits) }. What follows is the 65-byte point.
     */
    private val P256_HEADER = byteArrayOf(
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    )

    /** The length of an uncompressed P-256 point, `04 || X || Y`. */
    private const val P256_POINT = 65

    fun keyHash(spki: ByteArray): String = base64UrlEncode(MessageDigest.getInstance("SHA-256").digest(spki))

    /**
     * The pin of a SubjectPublicKeyInfo, or null when it is not an uncompressed P-256 key: the
     * Mac's listener only ever uses one, so anything else (RSA, another curve) is not the paired
     * Mac, whatever it hashes to.
     */
    fun p256KeyHash(spki: ByteArray): String? {
        if (spki.size != P256_HEADER.size + P256_POINT) return null
        if (!spki.copyOfRange(0, P256_HEADER.size).contentEquals(P256_HEADER)) return null
        if (spki[P256_HEADER.size] != 0x04.toByte()) return null
        return keyHash(spki)
    }

    /** The pin of a certificate's key, or null when it is not a P-256 key. */
    fun keyHashOf(certificate: X509Certificate): String? = p256KeyHash(certificate.publicKey.encoded)

    /**
     * The pin of a DER certificate (what a WebView's `SslCertificate` hands back, rebuilt), or
     * null when it does not parse or its key is not P-256.
     */
    fun keyHashOfCertificate(der: ByteArray): String? {
        val certificate = try {
            CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as? X509Certificate
        } catch (_: CertificateException) {
            null
        } catch (_: RuntimeException) {
            // Some providers throw unchecked exceptions on truncated input.
            null
        }
        return certificate?.let(::keyHashOf)
    }

    /** Wraps the X9.63 form (`04 || X || Y`) into the SPKI the server hashes. */
    internal fun spki(p256Raw: ByteArray): ByteArray? {
        if (p256Raw.size != P256_POINT || p256Raw[0] != 0x04.toByte()) return null
        return P256_HEADER + p256Raw
    }

    /**
     * The whole policy, with no TLS types so it can be tested: an allowed host presenting the
     * expected key is trusted, an allowed host presenting anything else is refused, in
     * first-contact mode (`expected` null) every allowed host is refused, and any other host is
     * left to the system.
     */
    fun decide(host: String, presented: String?, expected: String?, hosts: Set<String>): PinDecision {
        val wanted = normaliseHost(host)
        if (hosts.none { normaliseHost(it) == wanted }) return PinDecision.DefaultHandling
        if (expected == null || presented == null || presented != expected) return PinDecision.Reject(presented)
        return PinDecision.Trust
    }

    /** Hosts compare without case, brackets, a trailing dot or a percent-encoded zone separator. */
    fun normaliseHost(host: String): String {
        var h = host.lowercase()
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length - 1)
        if (h.endsWith(".")) h = h.dropLast(1)
        return h.replace("%25", "%")
    }
}

/** What the TLS check does with a server's certificate. */
sealed interface PinDecision {
    /** The paired Mac's host presenting the paired key. */
    data object Trust : PinDecision

    /** The paired Mac's host presenting another key, or any key in first-contact mode. */
    data class Reject(val observed: String?) : PinDecision

    /** Not the paired Mac's host: the pin does not apply, the system decides. */
    data object DefaultHandling : PinDecision
}
