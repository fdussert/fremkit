package app.fremkit.kit

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Mac's other LAN addresses: what `/api/devices/me` lists, what the app keeps of it, and how
 * it looks for the Mac there when the address in use goes away. The Swift file's `PairedMac` and
 * `ipv4` cases are in CredentialsTest and HostsTest.
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

    // AppModel

    private val infoWithAddresses = DeviceInfo(id = "d1", name = "iPad", screenId = "s1",
        brightness = DeviceBrightness(target = 40.0, seq = 3), addresses = listOf("192.168.1.20", "172.16.4.2"))

    @Test
    fun aConnectionStoresTheAddressesTheMacListed() = runTest {
        val store = MemoryCredentialStore(sampleMac)
        val model = appModel(store, ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(infoWithAddresses))))
        model.start()?.join()
        assertEquals(AppState.Dashboard("192.0.2.10", infoWithAddresses), model.state.value)
        assertEquals(listOf("192.168.1.20", "172.16.4.2"), model.mac.value?.addresses)
        assertEquals(listOf("192.168.1.20", "172.16.4.2"), store.load()?.addresses)
    }

    @Test
    fun aCheckStoresTheAddressesTheMacNowLists() = runTest {
        val store = MemoryCredentialStore(sampleMac)
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(store, prober)
        model.start()?.join()
        assertEquals(emptyList<String>(), store.load()?.addresses)

        prober.set("192.0.2.10", ProbeOutcome.Ok(infoWithAddresses))
        model.checkAuthorization()?.join()
        assertEquals(AppState.Dashboard("192.0.2.10", infoWithAddresses), model.state.value)
        assertEquals(listOf("192.168.1.20", "172.16.4.2"), store.load()?.addresses)

        // Gone from the Mac's list, gone from the app's.
        val fewer = DeviceInfo(id = "d1", name = "iPad", screenId = "s1", brightness = DeviceBrightness(target = 40.0, seq = 3),
            addresses = listOf("172.16.4.2"))
        prober.set("192.0.2.10", ProbeOutcome.Ok(fewer))
        model.resume()?.join()
        assertEquals(listOf("172.16.4.2"), model.mac.value?.addresses)
        assertEquals(listOf("172.16.4.2"), store.load()?.addresses)
    }

    @Test
    fun anUnchangedListWritesNothingToTheStore() = runTest {
        val store = CountingStore(sampleMac)
        val model = appModel(store, ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(infoWithAddresses))))
        model.start()?.join()
        assertEquals("the first answer stores the addresses", 1, store.saves)
        repeat(2) {
            model.checkAuthorization()?.join()
            settle()
        }
        model.resume()?.join()
        assertEquals("the same list again writes nothing", 1, store.saves)
        assertEquals(listOf("192.168.1.20", "172.16.4.2"), store.load()?.addresses)
    }

    @Test
    fun theDashboardMovesToAStoredAddressWhenNothingElseAnswers() = runTest {
        // Connected over the Mac's Ethernet address, which also told the app the Mac's Wi-Fi one.
        val store = MemoryCredentialStore(sampleMac)
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(infoWithAddresses)))
        val model = appModel(store, prober)
        model.start()?.join()
        assertEquals(AppState.Dashboard("192.0.2.10", infoWithAddresses), model.state.value)

        // Ethernet unplugged: the host in use is gone, the `.local` name does not resolve, NSD
        // finds nothing, and only the Wi-Fi address answers, with the paired key.
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        prober.set("studio.local", ProbeOutcome.Unreachable)
        prober.set("172.16.4.2", ProbeOutcome.Ok(infoWithAddresses))

        model.checkAuthorization()?.join()
        settle()
        model.checkAuthorization()?.join()
        settle()
        assertEquals(AppState.Dashboard("172.16.4.2", infoWithAddresses), model.state.value)
        assertEquals(listOf("192.0.2.10", "studio.local", "192.168.1.20", "172.16.4.2"), prober.hosts.takeLast(4))
        assertEquals("172.16.4.2", model.mac.value?.address)
        assertEquals("172.16.4.2", store.load()?.address)
        assertEquals("the pin is the one it always was", SpkiFixture.keyHash, store.load()?.keyHash)
    }

    @Test
    fun aStoredAddressPresentingAnotherKeyNeverMovesTheDashboardNorForgetsThePin() = runTest {
        val store = MemoryCredentialStore(sampleMac)
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(infoWithAddresses)))
        val model = appModel(store, prober)
        model.start()?.join()

        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        prober.set("192.168.1.20", ProbeOutcome.PinMismatch)
        prober.set("172.16.4.2", ProbeOutcome.PinMismatch)
        repeat(2) {
            model.checkAuthorization()?.join()
            settle()
        }
        assertEquals(AppState.Dashboard("192.0.2.10", infoWithAddresses), model.state.value)
        assertTrue(prober.hosts.contains("192.168.1.20"))
        assertEquals(SpkiFixture.keyHash, store.load()?.keyHash)
        assertEquals("device-token", store.load()?.token)
    }

    @Test
    fun theAddressesAreTriedAtTheNextLaunch() = runTest {
        val store = MemoryCredentialStore(sampleMac)
        appModel(store, ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(infoWithAddresses)))).start()?.join()

        // The next launch, on the Mac's Wi-Fi only: found at an address the last session learned.
        val prober = ScriptedProber(mapOf("172.16.4.2" to ProbeOutcome.Ok(infoWithAddresses)))
        val model = appModel(store, prober)
        model.start()?.join()
        assertEquals(AppState.Dashboard("172.16.4.2", infoWithAddresses), model.state.value)
        assertEquals(listOf("studio.local", "192.0.2.10", "192.168.1.20", "172.16.4.2"), prober.hosts)
    }

    @Test
    fun aStoreThatRefusesTheAddressesLeavesThemToThisSession() = runTest {
        val store = RefusingStore(sampleMac)
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(infoWithAddresses)))
        val model = appModel(store, prober)
        model.start()?.join()
        assertEquals(listOf("192.168.1.20", "172.16.4.2"), model.mac.value?.addresses)
        assertEquals("nothing reached the store", sampleMac, store.load())

        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        prober.set("172.16.4.2", ProbeOutcome.Ok(infoWithAddresses))
        repeat(2) {
            model.checkAuthorization()?.join()
            settle()
        }
        assertEquals("this session still looks there", AppState.Dashboard("172.16.4.2", infoWithAddresses), model.state.value)
    }
}

/** A store in memory that counts its saves. */
class CountingStore(mac: PairedMac?) : CredentialStore {
    private val lock = Any()
    private var stored: PairedMac? = mac
    private var count = 0

    val saves: Int get() = synchronized(lock) { count }

    override fun load(): PairedMac? = synchronized(lock) { stored }

    override fun save(mac: PairedMac) = synchronized(lock) {
        stored = mac
        count += 1
    }

    override fun clear() = synchronized(lock) { stored = null }
}

/** A store that reads its pairing and refuses every write. */
class RefusingStore(private val mac: PairedMac) : CredentialStore {
    override fun load(): PairedMac = mac

    override fun save(mac: PairedMac): Unit = throw java.io.IOException("the store refused the write")

    override fun clear() = Unit
}
