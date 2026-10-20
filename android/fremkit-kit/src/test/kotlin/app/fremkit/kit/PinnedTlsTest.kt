package app.fremkit.kit

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.net.URI
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection

/** The three `PinnedSession` cases of the Swift `PinDecisionTests`, on `PinnedTls.apply`. */
class PinnedTlsSessionTest {
    private val hosts = setOf("studio.local", "192.0.2.10")

    @Test
    fun firstContactSessionRemembersTheObservedKey() {
        val session = PinnedTls(keyHash = null, hosts = hosts)
        assertNull(session.observedKeyHash)
        assertFalse(session.rejectedPin)
        session.apply("studio.local", presented = "abc")
        assertEquals("abc", session.observedKeyHash)
        assertTrue(session.rejectedPin)
    }

    @Test
    fun anUnreadableKeyDoesNotEraseARecordedOne() {
        val session = PinnedTls(keyHash = null, hosts = hosts)
        session.apply("studio.local", presented = "abc")
        session.apply("studio.local", presented = null)
        assertEquals("abc", session.observedKeyHash)
    }

    @Test
    fun pinnedSessionDoesNotFlagATrustedHost() {
        val session = PinnedTls(keyHash = "abc", hosts = hosts)
        assertEquals(PinDecision.Trust, session.apply("studio.local", presented = "abc"))
        assertFalse(session.rejectedPin)
        assertEquals("abc", session.observedKeyHash)
    }

    // Kotlin only.

    @Test
    fun anotherHostIsNeitherRecordedNorFlagged() {
        val session = PinnedTls(keyHash = "abc", hosts = hosts)
        assertEquals(PinDecision.DefaultHandling, session.apply("example.com", presented = "xyz"))
        assertNull(session.observedKeyHash)
        assertFalse(session.rejectedPin)
    }

    @Test
    fun printingNeverShowsThePin() {
        val text = PinnedTls(keyHash = SpkiFixture.keyHash, hosts = hosts).toString()
        assertFalse(text.contains(SpkiFixture.keyHash))
        assertTrue(text.contains("studio.local"))
    }

    @Test
    fun theHostnameVerifierAcceptsOnlyThePolicysHosts() {
        val verifier = PinnedTls(keyHash = "abc", hosts = setOf("Studio.local.", "192.0.2.10")).hostnameVerifier
        assertTrue(verifier.verify("studio.local", null))
        assertTrue(verifier.verify("192.0.2.10", null))
        assertFalse(verifier.verify("192.0.2.11", null))
        assertFalse(verifier.verify("example.com", null))
    }

    @Test
    fun aCheckWithoutAHostIsRefused() {
        // The two-argument check cannot tell which host it is for: it never trusts.
        val manager = PinnedTls(keyHash = "abc", hosts = hosts).trustManager
        val certificate = TestCertificates.selfSigned(TestCertificates.ecKeyPair()).let {
            java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(it.inputStream()) as X509Certificate
        }
        try {
            manager.checkServerTrusted(arrayOf(certificate), "ECDHE_ECDSA")
            fail("trusted without a host")
        } catch (_: CertificateException) {
        }
        try {
            manager.checkClientTrusted(arrayOf(certificate), "ECDHE_ECDSA")
            fail("trusted a client")
        } catch (_: CertificateException) {
        }
        assertEquals(0, manager.acceptedIssuers.size)
    }
}

/** The pinning trust manager and hostname verifier against a real TLS server on this machine. */
class PinnedTlsTest {
    private val servers = mutableListOf<LocalTlsServer>()

    private fun server(keys: java.security.KeyPair = TestCertificates.ecKeyPair()) =
        LocalTlsServer(keys).also { servers += it }

    @After
    fun stop() = servers.forEach(LocalTlsServer::close)

    private fun get(pinned: PinnedTls, server: LocalTlsServer, path: String = "/api/devices/me"): HttpsURLConnection {
        val connection = pinned.open(URI("https://${server.host}:${server.port}$path").toURL())
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        connection.setRequestProperty("Cookie", "fremkit_device=device-token")
        return connection
    }

    private fun refused(connection: HttpsURLConnection) {
        try {
            connection.responseCode
            fail("the request went through")
        } catch (_: IOException) {
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun trustsTheRightKey() {
        val server = server()
        server.answer("/api/devices/me", LocalTlsServer.Answer.Status(200, """{"ok":true}"""))
        val pinned = PinnedTls(keyHash = server.keyHash, hosts = setOf(server.host))
        val connection = get(pinned, server)
        assertEquals(200, connection.responseCode)
        assertEquals("""{"ok":true}""", connection.inputStream.readBytes().decodeToString())
        connection.disconnect()
        assertFalse(pinned.rejectedPin)
        assertEquals(server.keyHash, pinned.observedKeyHash)
        assertEquals("fremkit_device=device-token", server.requests.single().header("Cookie"))
    }

    @Test
    fun refusesAnotherKeyAndNoCookieReachesTheServer() {
        val server = server()
        server.answer("/api/devices/me", LocalTlsServer.Answer.Status(200, "{}"))
        val pinned = PinnedTls(keyHash = SpkiFixture.keyHash, hosts = setOf(server.host))
        refused(get(pinned, server))
        assertTrue(pinned.rejectedPin)
        assertEquals("what the wrong server presented", server.keyHash, pinned.observedKeyHash)
        assertTrue("the handshake ended before any request", server.requests.isEmpty())
    }

    @Test
    fun refusesAnRsaKeyEvenWhenItsHashIsThePin() {
        val server = server(TestCertificates.rsaKeyPair())
        server.answer("/api/devices/me", LocalTlsServer.Answer.Status(200, "{}"))
        // The pin is the RSA key's own SPKI hash: still not a key the Mac ever uses.
        val pinned = PinnedTls(keyHash = server.keyHash, hosts = setOf(server.host))
        refused(get(pinned, server))
        assertTrue(pinned.rejectedPin)
        assertNull("an RSA key has no pin", pinned.observedKeyHash)
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun refusesAKeyOnAnotherCurve() {
        val server = server(TestCertificates.ecKeyPair("secp384r1"))
        server.answer("/api/devices/me", LocalTlsServer.Answer.Status(200, "{}"))
        val pinned = PinnedTls(keyHash = server.keyHash, hosts = setOf(server.host))
        refused(get(pinned, server))
        assertTrue(pinned.rejectedPin)
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun firstContactRecordsTheKeyAndRefuses() {
        val server = server()
        server.answer("/api/devices/me", LocalTlsServer.Answer.Status(200, "{}"))
        val pinned = PinnedTls(keyHash = null, hosts = setOf(server.host))
        refused(get(pinned, server))
        assertEquals(server.keyHash, pinned.observedKeyHash)
        assertTrue(pinned.rejectedPin)
        assertTrue("nothing is sent to a Mac not yet trusted", server.requests.isEmpty())
    }

    @Test
    fun doesNotFollowARedirect() {
        val server = server()
        server.answer("/api/devices/me", LocalTlsServer.Answer.Redirect("https://${server.host}:${server.port}/elsewhere"))
        server.answer("/elsewhere", LocalTlsServer.Answer.Status(200, "{}"))
        val pinned = PinnedTls(keyHash = server.keyHash, hosts = setOf(server.host))
        val connection = get(pinned, server)
        assertEquals("the 3xx itself is the response", 302, connection.responseCode)
        connection.disconnect()
        assertEquals(listOf("/api/devices/me"), server.requests.map { it.path })
    }

    @Test
    fun aHostOutsideThePolicyGetsNoTrustFromThePin() {
        val server = server()
        server.answer("/api/devices/me", LocalTlsServer.Answer.Status(200, "{}"))
        // The right key, on a host the pin does not cover: left to the system, which knows no
        // self-signed certificate, and not counted as a pin refusal.
        val pinned = PinnedTls(keyHash = server.keyHash, hosts = setOf("studio.local"))
        refused(get(pinned, server))
        assertFalse(pinned.rejectedPin)
        assertNull(pinned.observedKeyHash)
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun eachConnectionChecksTheKeyAgain() {
        val server = server()
        server.answer("/api/devices/me", LocalTlsServer.Answer.Status(200, "{}"))
        val trusted = PinnedTls(keyHash = server.keyHash, hosts = setOf(server.host))
        assertEquals(200, get(trusted, server).also { it.inputStream.readBytes() }.responseCode)
        // A later request under another pin must not ride on the first one's connection.
        val other = PinnedTls(keyHash = SpkiFixture.keyHash, hosts = setOf(server.host))
        refused(get(other, server))
        assertTrue(other.rejectedPin)
        assertEquals(1, server.requests.size)
    }
}
