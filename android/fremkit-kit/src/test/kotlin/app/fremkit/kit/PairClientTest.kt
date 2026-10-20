package app.fremkit.kit

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.PrintWriter
import java.io.StringWriter

/**
 * `PairClient` and `FirstContact`. The Swift tests' `URLProtocol` stub keyed by host becomes,
 * here, either the local TLS server (for one host, through the real pinned transport) or a
 * transport answering from a table keyed by host (for several).
 */
class PairClientTest {
    private val viewport = Viewport(1180, 820)
    private val server = LocalTlsServer()
    private val paired = """{"token":"tok-1","deviceId":"d9"}"""

    @After
    fun stop() = server.close()

    /** The real pinned transport to the local server; any other host does not answer. */
    private val routed: Transport = { request, policy ->
        if (request.uri.host == server.host) PinnedTransport.send(request, policy) else Exchange.Failed
    }

    /** Answers each host from a table (nothing for an unknown host) and records what it was sent. */
    private class Table(private val answers: Map<String, Exchange>) {
        val requests = Recorder<Request>()
        val policies = Recorder<PinPolicy>()
        val transport: Transport = { request, policy ->
            requests.add(request)
            policies.add(policy)
            answers[request.uri.host] ?: Exchange.Failed
        }
        fun to(host: String) = requests.items.filter { it.uri.host == host }
    }

    private fun status(code: Int, body: String) = Exchange.Response(code, body.toByteArray())

    private fun pair(client: PairClient, hosts: List<String>, port: Int = 4243, keyHash: String = SpkiFixture.keyHash,
                     secret: String? = null): PairedMac = runBlocking {
        client.pair(hosts, port, keyHash, code = "ABCDEFGH", secret = secret, name = "Tab", viewport = viewport, macName = "studio")
    }

    private fun failure(client: PairClient, hosts: List<String>, port: Int = 4243, keyHash: String = SpkiFixture.keyHash): PairError {
        try {
            pair(client, hosts, port, keyHash)
        } catch (e: PairError) {
            return e
        }
        fail("paired")
        error("unreachable")
    }

    private fun json(body: ByteArray): JsonObject = Json.parseToJsonElement(body.decodeToString()).jsonObject

    @Test
    fun pairsAndBuildsTheRecord() {
        server.answer("/api/pair", LocalTlsServer.Answer.Status(200, paired))
        val mac = pair(PairClient(routed), listOf("studio.local", server.host), server.port, server.keyHash)
        assertEquals(PairedMac("studio.local", server.host, server.port, server.keyHash, "tok-1", "d9", "studio"), mac)

        val seen = server.requests.single()
        assertEquals("/api/pair", seen.path)
        assertEquals("POST", seen.method)
        assertEquals("application/json", seen.header("Content-Type"))
        assertNull("no device cookie before there is a device", seen.header("Cookie"))
        val body = json(seen.body)
        // The code goes as its proof for the pinned key, never as itself.
        assertEquals(CodeProof.proof("ABCDEFGH", server.keyHash), body["proof"]?.jsonPrimitive?.content)
        assertNull(body["code"])
        assertFalse(seen.body.decodeToString().contains("ABCDEFGH"))
        assertNull("no secret, no field", body["secret"])
        assertEquals("Tab", body["name"]?.jsonPrimitive?.content)
        assertEquals(Json.parseToJsonElement("""{"width":1180,"height":820}"""), body["viewport"])
    }

    @Test
    fun saysItIsAnAndroidTablet() {
        val table = Table(mapOf("192.0.2.30" to status(200, paired)))
        pair(PairClient(table.transport) { _, _ -> "proof" }, listOf("192.0.2.30"))
        assertEquals(JsonPrimitive("android"), json(table.requests.items.single().body!!)["platform"])
    }

    @Test
    fun sendsTheSecretInsteadOfTheCode() {
        val secret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
        val proved = Recorder<String>()
        val table = Table(mapOf("192.0.2.35" to status(200, """{"token":"t","deviceId":"d"}""")))
        pair(PairClient(table.transport) { code, _ -> proved.add(code); "proof" }, listOf("192.0.2.35"), secret = secret)
        val body = json(table.requests.items.single().body!!)
        assertEquals(secret, body["secret"]?.jsonPrimitive?.content)
        assertNull("the Mac takes one or the other, never both", body["proof"])
        assertNull(body["code"])
        assertEquals("Tab", body["name"]?.jsonPrimitive?.content)
        assertEquals("no proof is computed for a link", emptyList<String>(), proved.items)
    }

    @Test
    fun keepsTheLinksAddressWhenTheNameAnswers() {
        val table = Table(mapOf("studio.local" to status(200, """{"token":"t","deviceId":"d"}""")))
        val mac = pair(PairClient(table.transport) { _, _ -> "proof" }, listOf("studio.local", "192.0.2.32"))
        assertEquals("studio.local", mac.host)
        assertEquals("192.0.2.32", mac.address)
    }

    @Test
    fun rejectedCarriesTheServersMessage() {
        server.answer("/api/pair", LocalTlsServer.Answer.Status(403, """{"error":"Code expiré"}"""))
        assertEquals(PairError.Rejected("Code expiré"), failure(PairClient(routed), listOf(server.host), server.port, server.keyHash))
    }

    @Test
    fun limitedCarriesTheServersMessage() {
        server.answer("/api/pair", LocalTlsServer.Answer.Status(429, """{"error":"Too many tries"}"""))
        assertEquals(PairError.Limited("Too many tries"), failure(PairClient(routed), listOf(server.host), server.port, server.keyHash))
    }

    @Test
    fun a429OnOneAddressTriesTheNext() {
        val table = Table(mapOf(
            "192.0.2.45" to status(429, """{"error":"Too many tries"}"""),
            "192.0.2.46" to status(200, """{"token":"t","deviceId":"d"}"""),
        ))
        val mac = pair(PairClient(table.transport) { _, _ -> "proof" }, listOf("192.0.2.45", "192.0.2.46"))
        assertEquals("t", mac.token)
        assertEquals(1, table.to("192.0.2.46").size)
    }

    @Test
    fun limitedOnlyWhenNoAddressPairs() {
        val answers = mapOf(
            "192.0.2.47" to status(429, """{"error":"Too many tries"}"""),
            "192.0.2.48" to status(429, """{"error":"Trop d’essais"}"""),
            "192.0.2.49" to Exchange.Failed,
        )
        for (hosts in listOf(listOf("192.0.2.47", "192.0.2.48"), listOf("192.0.2.47", "192.0.2.49"), listOf("192.0.2.49", "192.0.2.47"))) {
            val client = PairClient(Table(answers).transport) { _, _ -> "proof" }
            assertEquals(hosts.toString(), PairError.Limited("Too many tries"), failure(client, hosts))
        }
    }

    @Test
    fun aRefusedCodeStillStopsAtOnce() {
        val table = Table(mapOf(
            "192.0.2.50" to status(429, """{"error":"Too many tries"}"""),
            "192.0.2.51" to status(403, """{"error":"Wrong code"}"""),
            "192.0.2.52" to status(200, """{"token":"t","deviceId":"d"}"""),
        ))
        val error = failure(PairClient(table.transport) { _, _ -> "proof" }, listOf("192.0.2.50", "192.0.2.51", "192.0.2.52"))
        assertEquals(PairError.Rejected("Wrong code"), error)
        assertEquals(0, table.to("192.0.2.52").size)
    }

    @Test
    fun noCodeWhenTheMacAnswers404() {
        // The local server answers 404 to a path it was given nothing for.
        assertEquals(PairError.NoCode, failure(PairClient(routed), listOf(server.host), server.port, server.keyHash))
    }

    @Test
    fun invalidRequestOnA400() {
        server.answer("/api/pair", LocalTlsServer.Answer.Status(400, """{"error":"Bad Request"}"""))
        assertEquals(PairError.InvalidRequest, failure(PairClient(routed), listOf(server.host), server.port, server.keyHash))
    }

    @Test
    fun unreachableWhenNoHostAnswers() {
        val table = Table(emptyMap())
        assertEquals(PairError.Unreachable, failure(PairClient(table.transport) { _, _ -> "proof" }, listOf("192.0.2.35", "192.0.2.36")))
        assertEquals(1, table.to("192.0.2.36").size)
    }

    @Test
    fun unreachableOnATimeout() {
        server.answer("/api/pair", LocalTlsServer.Answer.Slow(2000, paired))
        val quick: Transport = { request, policy -> PinnedTransport.send(request.copy(timeoutMillis = 200), policy) }
        assertEquals(PairError.Unreachable, failure(PairClient(quick), listOf(server.host), server.port, server.keyHash))
    }

    @Test
    fun unreachableOnA200ThatIsNotAPairing() {
        server.answer("/api/pair", LocalTlsServer.Answer.Status(200, "<html></html>"))
        assertEquals(PairError.Unreachable, failure(PairClient(routed), listOf(server.host), server.port, server.keyHash))
    }

    @Test
    fun wrongMacWhenAHostFailsThePinAndNoneAnswers() {
        val table = Table(mapOf("studio.local" to Exchange.PinRejected))
        assertEquals(PairError.WrongMac, failure(PairClient(table.transport) { _, _ -> "proof" }, listOf("studio.local", "192.0.2.37")))
    }

    @Test
    fun wrongMacWhenTheServerPresentsAnotherKey() {
        server.answer("/api/pair", LocalTlsServer.Answer.Status(200, paired))
        assertEquals(PairError.WrongMac, failure(PairClient(routed), listOf(server.host), server.port, SpkiFixture.keyHash))
        assertTrue("the proof never reaches another Mac", server.requests.isEmpty())
    }

    @Test
    fun movesPastAWrongMacToTheRightOne() {
        val table = Table(mapOf(
            "192.0.2.38" to Exchange.PinRejected,
            "198.51.100.38" to status(200, """{"token":"t","deviceId":"d"}"""),
        ))
        val mac = pair(PairClient(table.transport) { _, _ -> "proof" }, listOf("studio.local", "192.0.2.38", "198.51.100.38"))
        assertEquals("198.51.100.38", mac.address)
        assertEquals("studio.local", mac.host)
    }

    @Test
    fun pinsEveryHostItTries() {
        val table = Table(emptyMap())
        failure(PairClient(table.transport) { _, _ -> "proof" }, listOf("studio.local", "192.0.2.39"))
        assertEquals(listOf(SpkiFixture.keyHash, SpkiFixture.keyHash), table.policies.items.map { it.keyHash })
        assertEquals(setOf("studio.local", "192.0.2.39"), table.policies.items.first().hosts)
    }

    @Test
    fun errorsCarryOnlyTheServersMessage() {
        val secret = "tok-secret-0451"
        val table = Table(mapOf(
            "192.0.2.40" to status(403, """{"error":"Wrong code","token":"$secret","deviceId":"d"}"""),
            "192.0.2.41" to status(429, """{"token":"$secret","error":"Too many tries"}"""),
        ))
        for ((host, expected) in listOf("192.0.2.40" to PairError.Rejected("Wrong code"), "192.0.2.41" to PairError.Limited("Too many tries"))) {
            val error = failure(PairClient(table.transport) { _, _ -> "proof" }, listOf(host))
            assertEquals(expected, error)
            assertFalse(error.toString().contains(secret))
            assertFalse(error.message.orEmpty().contains(secret))
            assertNull(error.cause)
        }
    }

    @Test
    fun noErrorQuotesTheTokenTheKeyTheCodeOrTheSecret() {
        // Malformed 200s whose bodies hold a token: an exception would quote them if any kept them.
        val token = "tok-secret-0452"
        val secret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
        for (body in listOf("""{"token":"$token"}""", """{"token":"$token","deviceId":5}""", """{"token":"$token",""")) {
            val table = Table(mapOf("192.0.2.53" to status(200, body)))
            val error = try {
                runBlocking {
                    PairClient(table.transport).pair(listOf("192.0.2.53"), 4243, SpkiFixture.keyHash, "ABCDEFGH", secret, "Tab", viewport, "studio")
                }
                fail("paired")
                error("unreachable")
            } catch (e: PairError) {
                e
            }
            assertEquals(PairError.Unreachable, error)
            val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
            for (s in listOf(token, secret, SpkiFixture.keyHash, "ABCDEFGH")) assertFalse(s, trace.contains(s))
        }
    }

    @Test
    fun aProofThatCannotBeMadeIsAnInvalidRequest() {
        val table = Table(emptyMap())
        val client = PairClient(table.transport) { _, _ -> throw IllegalStateException("no PBKDF2 here") }
        assertEquals(PairError.InvalidRequest, failure(client, listOf("192.0.2.54")))
        assertTrue("nothing is sent", table.requests.items.isEmpty())
    }

    @Test
    fun dropsATrailingDotFromTheMacsName() {
        server.answer("/api/pair", LocalTlsServer.Answer.Status(200, """{"token":"t","deviceId":"d"}"""))
        val policies = Recorder<PinPolicy>()
        val client = PairClient({ request, policy -> policies.add(policy); routed(request, policy) })
        val mac = pair(client, listOf("Studio.local.", server.host), server.port, server.keyHash)
        assertEquals("Studio.local", mac.host)
        assertEquals(setOf("Studio.local", server.host), policies.items.first().hosts)
    }

    @Test
    fun refusesARedirect() {
        server.answer("/api/pair", LocalTlsServer.Answer.Redirect("https://${server.host}:${server.port}/elsewhere"))
        server.answer("/elsewhere", LocalTlsServer.Answer.Status(200, """{"token":"t","deviceId":"d"}"""))
        assertEquals(PairError.Unreachable, failure(PairClient(routed), listOf(server.host), server.port, server.keyHash))
        assertEquals(listOf("/api/pair"), server.requests.map { it.path })
    }

    @Test
    fun policyPrintingNeverShowsThePin() {
        val text = PinPolicy(SpkiFixture.keyHash, setOf("studio.local")).toString()
        assertFalse(text.contains(SpkiFixture.keyHash))
        assertTrue(text.contains("studio.local"))
    }

    @Test
    fun viewportClampsToTheServersBounds() {
        assertEquals(Viewport(1, 10000), Viewport(0, 20000))
    }
}

/** Reading a Mac's key before trusting it, against the local TLS server. */
class FirstContactTest {
    private val servers = mutableListOf<LocalTlsServer>()

    @After
    fun stop() = servers.forEach(LocalTlsServer::close)

    @Test
    fun readsTheKeyAndSendsNothing() {
        val server = LocalTlsServer().also { servers += it }
        server.answer("/api/devices/me", LocalTlsServer.Answer.Status(200, "{}"))
        assertEquals(server.keyHash, runBlocking { FirstContact.keyHash(server.host, server.port) })
        assertTrue("the handshake is refused before any request", server.requests.isEmpty())
    }

    @Test
    fun anRsaKeyIsNoKey() {
        val server = LocalTlsServer(TestCertificates.rsaKeyPair()).also { servers += it }
        assertNull(runBlocking { FirstContact.keyHash(server.host, server.port) })
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun nothingListeningIsNoKey() {
        val closed = LocalTlsServer().also { it.close() }
        assertNull(runBlocking { FirstContact.keyHash(closed.host, closed.port, timeoutMillis = 500) })
    }

    @Test
    fun aHostThatIsNotOneIsNoKey() {
        assertNull(runBlocking { FirstContact.keyHash("studio local", 4243) })
    }
}
