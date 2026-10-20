package app.fremkit.kit

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections

/** The device record the kit's tests share (generic values). */
val sampleInfo = DeviceInfo(id = "d1", name = "iPad", screenId = "s1", brightness = DeviceBrightness(target = 40.0, seq = 3))

/** Collects what a fake transport or prober was handed, from any thread. */
class Recorder<T> {
    private val stored = Collections.synchronizedList(mutableListOf<T>())
    fun add(item: T) {
        stored += item
    }
    val items: List<T> get() = synchronized(stored) { stored.toList() }
}

/**
 * `HttpProber` against a real TLS server on this machine: the Swift `HTTPProberTests`, where a
 * `URLProtocol` stub stood in for the network. The paired Mac's pin is the server's key.
 */
class ProbeTest {
    private val me = """{"id":"d1","name":"iPad","screenId":"s1","brightness":{"target":40,"seq":3}}"""
    private val server = LocalTlsServer()
    private val mac = PairedMac(
        host = "studio.local", address = "192.0.2.10", port = server.port, keyHash = server.keyHash,
        token = "device-token", deviceId = "d1", name = "studio",
    )

    @After
    fun stop() = server.close()

    private fun probe(prober: Prober = HttpProber()): ProbeOutcome =
        runBlocking { prober.probe(server.host, server.port, mac) }

    private fun answer(status: Int, body: String) =
        server.answer("/api/devices/me", LocalTlsServer.Answer.Status(status, body))

    @Test
    fun okOnA200WithTheDeviceRecord() {
        answer(200, me)
        assertEquals(ProbeOutcome.Ok(sampleInfo), probe())
        val seen = server.requests.single()
        // `addresses=1`: the app asks for the Mac's other addresses, which the page never does.
        assertEquals("/api/devices/me?addresses=1", seen.path)
        assertEquals("GET", seen.method)
        assertEquals("fremkit_device=device-token", seen.header("Cookie"))
    }

    @Test
    fun buildsTheRequestItSends() {
        val requests = Recorder<Request>()
        runBlocking {
            HttpProber { request, _ -> requests.add(request); Exchange.Failed }.probe("192.0.2.21", 4243, sampleMac)
        }
        val request = requests.items.single()
        assertEquals("https://192.0.2.21:4243/api/devices/me?addresses=1", request.uri.toString())
        assertEquals("GET", request.method)
        assertEquals("fremkit_device=device-token", request.header("Cookie"))
        assertEquals(5000, request.timeoutMillis)
    }

    @Test
    fun okWithoutAScreenOrABrightness() {
        answer(200, """{"id":"d1","name":"iPad","screenId":null,"brightness":null}""")
        assertEquals(ProbeOutcome.Ok(DeviceInfo("d1", "iPad", screenId = null, brightness = null)), probe())
    }

    @Test
    fun unauthorizedOnA401() {
        answer(401, """{"error":"no"}""")
        assertEquals(ProbeOutcome.Unauthorized, probe())
    }

    @Test
    fun unreachableOnA404() {
        answer(404, """{"statusCode":404,"error":"Not Found"}""")
        assertEquals(ProbeOutcome.Unreachable, probe())
    }

    @Test
    fun unreachableOnA429() {
        answer(429, """{"error":"Too many tries"}""")
        assertEquals(ProbeOutcome.Unreachable, probe())
    }

    @Test
    fun unreachableOnA500() {
        answer(500, "{}")
        assertEquals(ProbeOutcome.Unreachable, probe())
    }

    @Test
    fun unreachableOnATimeout() {
        server.answer("/api/devices/me", LocalTlsServer.Answer.Slow(2000, me))
        val quick = HttpProber { request, policy -> PinnedTransport.send(request.copy(timeoutMillis = 200), policy) }
        val started = System.nanoTime()
        assertEquals(ProbeOutcome.Unreachable, probe(quick))
        assertTrue("gave up at the timeout", System.nanoTime() - started < 1_500_000_000)
    }

    @Test
    fun unreachableWhenNothingListens() {
        val closed = LocalTlsServer().also { it.close() }
        val outcome = runBlocking { HttpProber().probe(closed.host, closed.port, mac) }
        assertEquals(ProbeOutcome.Unreachable, outcome)
    }

    @Test
    fun unreachableOnA200ThatIsNotADeviceRecord() {
        answer(200, "<html></html>")
        assertEquals(ProbeOutcome.Unreachable, probe())
        answer(200, """{"name":"iPad"}""")
        assertEquals(ProbeOutcome.Unreachable, probe())
    }

    @Test
    fun unreachableOnARedirectItDoesNotFollow() {
        server.answer("/api/devices/me", LocalTlsServer.Answer.Redirect("https://${server.host}:${server.port}/elsewhere"))
        server.answer("/elsewhere", LocalTlsServer.Answer.Status(200, me))
        assertEquals(ProbeOutcome.Unreachable, probe())
        assertEquals(listOf("/api/devices/me?addresses=1"), server.requests.map { it.path })
    }

    @Test
    fun pinMismatchWhenThePinRejectsTheKey() {
        assertEquals(ProbeOutcome.PinMismatch, probe(HttpProber { _, _ -> Exchange.PinRejected }))
    }

    @Test
    fun pinMismatchWhenTheServerPresentsAnotherKey() {
        answer(200, me)
        val other = PairedMac(mac.host, mac.address, mac.port, SpkiFixture.keyHash, mac.token, mac.deviceId, mac.name)
        val outcome = runBlocking { HttpProber().probe(server.host, server.port, other) }
        assertEquals(ProbeOutcome.PinMismatch, outcome)
        assertTrue("no cookie reaches a server the pin refused", server.requests.isEmpty())
    }

    @Test
    fun pinsTheMacsKeyForTheProbedHostAndTheMacsOwnNames() {
        val policies = Recorder<PinPolicy>()
        runBlocking {
            HttpProber { _, policy -> policies.add(policy); Exchange.Failed }.probe("198.51.100.7", 4243, sampleMac)
        }
        assertEquals(listOf(PinPolicy(SpkiFixture.keyHash, setOf("198.51.100.7", "studio.local", "192.0.2.10"))), policies.items)
    }

    @Test
    fun readsTheMacsVersion() {
        answer(200, """{"id":"d1","name":"Tab","screenId":"s1","brightness":null,"addresses":["192.168.1.20"],"serverVersion":"0.5.0"}""")
        val outcome = probe() as ProbeOutcome.Ok
        assertEquals("0.5.0", outcome.info.serverVersion)
        assertEquals(listOf("192.168.1.20"), outcome.info.addresses)
    }
}
