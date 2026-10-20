package app.fremkit.kit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * A P-256 public key in DER SubjectPublicKeyInfo form (the shared `spki` vector), made with
 * `openssl ecparam -name prime256v1 -genkey | openssl ec -pubout -outform DER`, and its hash.
 */
object SpkiFixture {
    val keyHash: String get() = Vectors.all.spki.keyHash
    val der: ByteArray get() = hex(Vectors.all.spki.derHex)
}

class PinTest {
    private fun parse(der: ByteArray) =
        CertificateFactory.getInstance("X.509").generateCertificate(der.inputStream()) as X509Certificate

    @Test
    fun hashesAnSpkiLikeOpenSsl() {
        assertEquals(SpkiFixture.keyHash, Pin.keyHash(SpkiFixture.der))
    }

    @Test
    fun rebuildsTheSpkiOfARawP256Key() {
        val raw = SpkiFixture.der.copyOfRange(Vectors.all.spki.rawOffset, SpkiFixture.der.size)
        assertArrayEquals(SpkiFixture.der, Pin.spki(p256Raw = raw))
    }

    @Test
    fun refusesARawKeyThatIsNotAnUncompressedP256Point() {
        for (h in Vectors.all.spki.rejectedRawHex) assertNull(h, Pin.spki(p256Raw = hex(h)))
    }

    @Test
    fun agreesWithTheJdkOnAFreshKey() {
        // The Swift kit checks the same thing against CryptoKit's DER.
        val encoded = TestCertificates.ecKeyPair().public.encoded
        val raw = encoded.copyOfRange(Vectors.all.spki.rawOffset, encoded.size)
        assertArrayEquals(encoded, Pin.spki(p256Raw = raw))
    }

    // Kotlin only: the certificate path the trust manager and the WebView take.

    @Test
    fun hashesTheKeyOfAP256Certificate() {
        val keys = TestCertificates.ecKeyPair()
        val expected = base64UrlEncode(MessageDigest.getInstance("SHA-256").digest(keys.public.encoded))
        assertEquals(expected, Pin.keyHashOfCertificate(TestCertificates.selfSigned(keys)))
    }

    @Test
    fun refusesAnRsaCertificate() {
        val der = TestCertificates.selfSigned(TestCertificates.rsaKeyPair())
        assertEquals("the certificate itself is valid", "RSA", parse(der).publicKey.algorithm)
        assertNull("an RSA key is never the Mac's", Pin.keyHashOfCertificate(der))
    }

    @Test
    fun refusesACertificateOnAnotherCurve() {
        val der = TestCertificates.selfSigned(TestCertificates.ecKeyPair("secp384r1"))
        assertEquals("the certificate itself is valid", "EC", parse(der).publicKey.algorithm)
        assertNull(Pin.keyHashOfCertificate(der))
    }

    @Test
    fun refusesBytesThatAreNotACertificate() {
        assertNull(Pin.keyHashOfCertificate(ByteArray(0)))
        assertNull(Pin.keyHashOfCertificate(SpkiFixture.der))
        assertNull(Pin.keyHashOfCertificate("not a certificate".toByteArray()))
    }

    @Test
    fun acceptsOnlyAP256Spki() {
        assertEquals(SpkiFixture.keyHash, Pin.p256KeyHash(SpkiFixture.der))
        assertNotNull(Pin.p256KeyHash(TestCertificates.ecKeyPair().public.encoded))
        assertNull(Pin.p256KeyHash(TestCertificates.rsaKeyPair().public.encoded))
        assertNull(Pin.p256KeyHash(TestCertificates.ecKeyPair("secp384r1").public.encoded))
        // The right header with a compressed point, or one byte short or long.
        val compressed = SpkiFixture.der.copyOf().also { it[Vectors.all.spki.rawOffset] = 0x02 }
        assertNull(Pin.p256KeyHash(compressed))
        assertNull(Pin.p256KeyHash(SpkiFixture.der.copyOf(SpkiFixture.der.size - 1)))
        assertNull(Pin.p256KeyHash(SpkiFixture.der + byteArrayOf(0)))
    }
}

class PinDecisionTest {
    private val hosts = setOf("studio.local", "192.0.2.10")

    @Test
    fun trustsAnAllowedHostPresentingTheExpectedKey() {
        assertEquals(PinDecision.Trust, Pin.decide("studio.local", presented = "abc", expected = "abc", hosts = hosts))
        assertEquals(PinDecision.Trust, Pin.decide("192.0.2.10", presented = "abc", expected = "abc", hosts = hosts))
    }

    @Test
    fun matchesTheHostWithoutCaseOrTrailingDot() {
        assertEquals(PinDecision.Trust, Pin.decide("Studio.Local.", presented = "abc", expected = "abc", hosts = hosts))
    }

    @Test
    fun rejectsAnAllowedHostPresentingAnotherKey() {
        assertEquals(PinDecision.Reject("xyz"), Pin.decide("studio.local", presented = "xyz", expected = "abc", hosts = hosts))
        assertEquals(PinDecision.Reject(null), Pin.decide("studio.local", presented = null, expected = "abc", hosts = hosts))
    }

    @Test
    fun leavesAnyOtherHostToTheSystem() {
        assertEquals(PinDecision.DefaultHandling, Pin.decide("example.com", presented = "abc", expected = "abc", hosts = hosts))
        assertEquals(PinDecision.DefaultHandling, Pin.decide("example.com", presented = "abc", expected = null, hosts = hosts))
    }

    @Test
    fun firstContactRecordsTheKeyAndTrustsNothing() {
        assertEquals(PinDecision.Reject("abc"), Pin.decide("studio.local", presented = "abc", expected = null, hosts = hosts))
    }

    @Test
    fun iPv6HostsMatchWithOrWithoutBrackets() {
        val v6 = setOf("[2001:db8::1]")
        assertEquals(PinDecision.Trust, Pin.decide("2001:DB8::1", presented = "abc", expected = "abc", hosts = v6))
    }

    @Test
    fun aPercentEncodedZoneMatchesItsDecodedForm() {
        val v6 = setOf("fe80::1%25en0")
        assertEquals(PinDecision.Trust, Pin.decide("[FE80::1%en0]", presented = "abc", expected = "abc", hosts = v6))
        assertEquals("fe80::1%en0", Pin.normaliseHost("[fe80::1%25en0]"))
    }

    @Test
    fun anEmptyHostListCoversNothing() {
        assertEquals(PinDecision.DefaultHandling, Pin.decide("studio.local", presented = "abc", expected = "abc", hosts = emptySet()))
    }
}
