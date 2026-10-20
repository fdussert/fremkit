package app.fremkit.kit

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The request the kit builds, how it prints, and the pinned transport's own rules. */
class RequestTest {
    private val servers = mutableListOf<LocalTlsServer>()

    @After
    fun stop() = servers.forEach(LocalTlsServer::close)

    @Test
    fun bracketsAnIPv6Host() {
        assertEquals("https://[2001:db8::1]:4243/api/devices/me", Endpoint.url("2001:db8::1", 4243, "/api/devices/me").toString())
        assertEquals("https://[fe80::1%25en0]:4243/x", Endpoint.url("fe80::1%en0", 4243, "/x").toString())
        assertEquals("https://studio.local:4243/x", Endpoint.url("studio.local", 4243, "/x").toString())
    }

    @Test
    fun refusesAHostThatIsNotOne() {
        assertNull(Endpoint.url("studio local", 4243, "/x"))
        assertNull(Endpoint.url("", 4243, "/x"))
    }

    @Test
    fun setsTheCookieOnlyWithAToken() {
        assertEquals("fremkit_device=t", Endpoint.request("studio.local", 4243, "/x", "t")?.header("cookie"))
        assertNull(Endpoint.request("studio.local", 4243, "/x", null)?.header("Cookie"))
    }

    @Test
    fun printingARequestNeverShowsTheCookieOrTheBody() {
        val request = Endpoint.request("192.0.2.10", 4243, "/api/pair", "device-token")!!
            .copy(method = "POST", body = """{"secret":"a-secret"}""".toByteArray())
        val text = request.toString()
        assertFalse(text.contains("device-token"))
        assertFalse(text.contains("a-secret"))
        assertTrue(text.contains("POST https://192.0.2.10:4243/api/pair"))
    }

    @Test
    fun policyPrintingNeverShowsThePin() {
        val text = PinPolicy(SpkiFixture.keyHash, setOf("studio.local")).toString()
        assertFalse(text.contains(SpkiFixture.keyHash))
        assertTrue(text.contains("studio.local"))
    }

    @Test
    fun responsesCompareByContent() {
        assertEquals(Exchange.Response(200, "a".toByteArray()), Exchange.Response(200, "a".toByteArray()))
        assertNotEquals(Exchange.Response(200, "a".toByteArray()), Exchange.Response(200, "b".toByteArray()))
        assertFalse(Exchange.Response(200, "secret".toByteArray()).toString().contains("secret"))
    }

    @Test
    fun theTransportSendsTheBodyAndHeaders() {
        val server = LocalTlsServer().also { servers += it }
        server.answer("/api/pair", LocalTlsServer.Answer.Status(200, """{"ok":1}"""))
        val request = Endpoint.request(server.host, server.port, "/api/pair", null)!!
            .copy(method = "POST", headers = mapOf("Content-Type" to "application/json"), body = """{"a":1}""".toByteArray())
        val exchange = PinnedTransport.send(request, PinPolicy(server.keyHash, setOf(server.host)))
        assertEquals(Exchange.Response(200, """{"ok":1}""".toByteArray()), exchange)
        val seen = server.requests.single()
        assertEquals("POST", seen.method)
        assertEquals("application/json", seen.header("Content-Type"))
        assertEquals("""{"a":1}""", seen.body.decodeToString())
        assertNull("no cookie without a token", seen.header("Cookie"))
    }

    @Test
    fun theTransportReadsAnErrorsBody() {
        val server = LocalTlsServer().also { servers += it }
        server.answer("/x", LocalTlsServer.Answer.Status(403, """{"error":"Wrong code"}"""))
        val exchange = PinnedTransport.send(Endpoint.request(server.host, server.port, "/x", null)!!,
            PinPolicy(server.keyHash, setOf(server.host)))
        assertEquals(Exchange.Response(403, """{"error":"Wrong code"}""".toByteArray()), exchange)
    }

    @Test
    fun theTransportTellsAPinRefusalFromAFailure() {
        val server = LocalTlsServer().also { servers += it }
        server.answer("/x", LocalTlsServer.Answer.Status(200, "{}"))
        val request = Endpoint.request(server.host, server.port, "/x", "device-token")!!
        assertEquals(Exchange.PinRejected, PinnedTransport.send(request, PinPolicy(SpkiFixture.keyHash, setOf(server.host))))
        // The right key on a host the policy does not name is a failure, never a pin refusal.
        assertEquals(Exchange.Failed, PinnedTransport.send(request, PinPolicy(server.keyHash, setOf("studio.local"))))
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun theTransportRefusesAnOversizedBody() {
        val server = LocalTlsServer().also { servers += it }
        server.answer("/x", LocalTlsServer.Answer.Status(200, "x".repeat(PinnedTransport.MAX_BODY + 1)))
        val exchange = PinnedTransport.send(Endpoint.request(server.host, server.port, "/x", null)!!,
            PinPolicy(server.keyHash, setOf(server.host)))
        assertEquals(Exchange.Failed, exchange)
    }
}
