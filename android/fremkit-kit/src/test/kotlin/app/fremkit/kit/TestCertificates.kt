package app.fremkit.kit

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Self-signed X.509 certificates made at test time with the JDK alone (a few lines of DER), so
 * no key is ever committed and the kit's test classpath needs no BouncyCastle for this.
 */
object TestCertificates {
    fun ecKeyPair(curve: String = "secp256r1"): KeyPair =
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec(curve)) }.generateKeyPair()

    fun rsaKeyPair(bits: Int = 2048): KeyPair =
        KeyPairGenerator.getInstance("RSA").apply { initialize(bits) }.generateKeyPair()

    /** A v3 certificate for `CN=fremkit test`, signed by its own key, as DER. */
    fun selfSigned(keys: KeyPair): ByteArray {
        val rsa = keys.private.algorithm == "RSA"
        val algorithm = if (rsa) {
            // sha256WithRSAEncryption, NULL parameters
            seq(oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), byteArrayOf(0x05, 0x00))
        } else {
            // ecdsa-with-SHA256, no parameters
            seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02))
        }
        val name = seq(set(seq(oid(0x55, 0x04, 0x03), tlv(0x0c, "fremkit test".toByteArray()))))
        val validity = seq(tlv(0x17, "260101000000Z".toByteArray()), tlv(0x17, "360101000000Z".toByteArray()))
        val tbs = seq(
            tlv(0xa0, tlv(0x02, byteArrayOf(2))), // version: v3
            tlv(0x02, BigInteger.valueOf(System.nanoTime()).abs().toByteArray()),
            algorithm,
            name,
            validity,
            name,
            keys.public.encoded, // the SubjectPublicKeyInfo, as the JDK encodes it
        )
        val signature = Signature.getInstance(if (rsa) "SHA256withRSA" else "SHA256withECDSA").run {
            initSign(keys.private)
            update(tbs)
            sign()
        }
        return seq(tbs, algorithm, tlv(0x03, byteArrayOf(0) + signature))
    }

    private fun oid(vararg bytes: Int) = tlv(0x06, ByteArray(bytes.size) { bytes[it].toByte() })
    private fun seq(vararg parts: ByteArray) = tlv(0x30, *parts)
    private fun set(vararg parts: ByteArray) = tlv(0x31, *parts)

    private fun tlv(tag: Int, vararg parts: ByteArray): ByteArray {
        val body = ByteArrayOutputStream().apply { parts.forEach { write(it) } }.toByteArray()
        val out = ByteArrayOutputStream()
        out.write(tag)
        when {
            body.size < 0x80 -> out.write(body.size)
            body.size < 0x100 -> { out.write(0x81); out.write(body.size) }
            else -> { out.write(0x82); out.write(body.size shr 8); out.write(body.size and 0xff) }
        }
        out.write(body)
        return out.toByteArray()
    }
}
