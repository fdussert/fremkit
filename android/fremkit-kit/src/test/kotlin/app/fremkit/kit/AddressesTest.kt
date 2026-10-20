package app.fremkit.kit

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Mac's other LAN addresses: what `/api/devices/me` lists, what the app keeps of it, and how
 * it looks for the Mac there when the address in use goes away. The Swift file's `PairedMac` and
 * `ipv4` cases are in CredentialsTest and HostsTest; its `AppModel` cases go with AppModelTest.
 */
class AddressesTest {
    /** The paired Mac with two other addresses it listed earlier (RFC 1918, generic values). */
    private val macWithAddresses = sampleMac.updating(addresses = listOf("192.168.1.20", "172.16.4.2"))

    private fun decode(json: String): DeviceInfo = DeviceInfo.fromJson(json) ?: error("not a device record")

    // DeviceInfo

    @Test
    fun decodesTheAddresses() {
        val info = decode("""{"id":"d1","name":"iPad","screenId":"s1","brightness":null,"addresses":["10.20.30.40","192.168.1.20"]}""")
        assertEquals(listOf("10.20.30.40", "192.168.1.20"), info.addresses)
    }

    /** Where the iPad ignores `serverVersion`, the Android app keeps it; any other new key is ignored. */
    @Test
    fun readsTheServerVersionAndIgnoresAnyOtherNewKey() {
        val info = decode("""{"id":"d1","name":"iPad","screenId":"s1","brightness":null,"addresses":["192.168.1.20"],"serverVersion":"9.9.9","somethingNew":{"a":1}}""")
        assertEquals(DeviceInfo("d1", "iPad", "s1", null, listOf("192.168.1.20"), serverVersion = "9.9.9"), info)
    }

    @Test
    fun aMacThatSendsNoVersionGivesNone() {
        assertNull(decode("""{"id":"d1","name":"iPad","screenId":null,"brightness":null}""").serverVersion)
        assertNull(decode("""{"id":"d1","name":"iPad","screenId":null,"brightness":null,"serverVersion":5}""").serverVersion)
        assertNull(decode("""{"id":"d1","name":"iPad","screenId":null,"brightness":null,"serverVersion":null}""").serverVersion)
    }

    @Test
    fun aMacThatSendsNoAddressesGivesNone() {
        assertEquals(emptyList<String>(), decode("""{"id":"d1","name":"iPad","screenId":"s1","brightness":null}""").addresses)
        assertEquals(emptyList<String>(), decode("""{"id":"d1","name":"iPad","screenId":null,"brightness":null,"addresses":"10.20.30.40"}""").addresses)
        assertEquals(emptyList<String>(), decode("""{"id":"d1","name":"iPad","screenId":null,"brightness":null,"addresses":null}""").addresses)
    }

    @Test
    fun dropsEveryEntryThatIsNotAPrivateIPv4Literal() {
        val info = decode("""
            {"id":"d1","name":"iPad","screenId":null,"brightness":null,"addresses":[
              "192.168.1.20", 42, null, "198.51.100.7", "203.0.113.5", "100.100.1.1", "169.254.1.1",
              "127.0.0.1", "fd00::1", "2001:db8::1", "fe80::1%en0", "studio.local", "evil.example.com",
              "172.15.0.1", "172.32.0.1", "10.1.2.3 ", "", "172.31.255.254", "192.168.1.20", [], {}
            ]}
        """.trimIndent())
        assertEquals(listOf("192.168.1.20", "172.31.255.254"), info.addresses)
    }

    @Test
    fun keepsAtMostEightAddresses() {
        val many = (1..20).joinToString(",") { "\"10.9.1.$it\"" }
        val info = decode("""{"id":"d1","name":"iPad","screenId":null,"brightness":null,"addresses":[$many]}""")
        assertEquals((1..8).map { "10.9.1.$it" }, info.addresses)
    }

    @Test
    fun aBodyThatIsNotADeviceRecordIsNone() {
        // Null, not an exception that would quote the body.
        for (body in listOf("", "<html></html>", "{}", """{"id":"d1"}""", """{"id":1,"name":"iPad"}""", "[]")) {
            assertNull(body, DeviceInfo.fromJson(body))
        }
    }

    // Connector

    @Test
    fun candidatesTryTheStoredAddressesAfterTheNameAndTheLastAddress() {
        assertEquals(
            listOf("192.0.2.99", "studio.local", "192.0.2.10", "192.168.1.20", "172.16.4.2", "198.51.100.7"),
            Connector.candidates(macWithAddresses, listOf("198.51.100.7", "172.16.4.2"), preferring = "192.0.2.99"),
        )
    }

    @Test
    fun aStoredAddressPresentingAnotherKeyIsNotTheMac() = runBlocking {
        // Another machine holds a stored address now: it is "not this one", the next one is tried.
        val prober = FakeProber(mapOf("192.168.1.20" to ProbeOutcome.PinMismatch, "172.16.4.2" to ProbeOutcome.Ok(sampleInfo)))
        assertEquals(ConnectResult.Connected("172.16.4.2", sampleInfo), Connector(prober).connect(macWithAddresses, emptyList()))

        // Alone, it never connects, and is no proof the key changed: not at launch, nor behind a
        // dashboard. The Mac is simply not found (asleep, say).
        val only = FakeProber(mapOf("192.168.1.20" to ProbeOutcome.PinMismatch))
        assertEquals(ConnectResult.Unreachable, Connector(only).connect(macWithAddresses, emptyList()))
        assertEquals(ConnectResult.Unreachable, Connector(only).relocate(macWithAddresses, emptyList(), current = "192.0.2.10"))
    }

    // Pinning

    @Test
    fun aProbeToAStoredAddressIsPinnedToThePairedKey() = runBlocking {
        val policies = Recorder<PinPolicy>()
        val cookies = Recorder<String>()
        val prober = HttpProber { request, policy ->
            policies.add(policy)
            cookies.add(request.header("Cookie") ?: "")
            Exchange.PinRejected
        }
        assertEquals(ProbeOutcome.PinMismatch, prober.probe("192.168.1.20", 4243, macWithAddresses))
        val policy = policies.items[0]
        // The pin covers the stored address, and expects the paired key there and nowhere else.
        assertTrue(policy.hosts.contains("192.168.1.20"))
        assertEquals(SpkiFixture.keyHash, policy.keyHash)
        assertEquals(PinDecision.Trust, Pin.decide("192.168.1.20", SpkiFixture.keyHash, policy.keyHash, policy.hosts))
        assertEquals(PinDecision.Reject("another-key"), Pin.decide("192.168.1.20", "another-key", policy.keyHash, policy.hosts))
        // The token only ever travels in a request handed to the pinned transport.
        assertEquals(listOf("fremkit_device=device-token"), cookies.items)
    }
}
