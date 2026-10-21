package app.fremkit.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DiscoveryTest {
    @Test
    fun readsTheAddressAndPortOfTheTXTRecord() {
        assertEquals(FremkitTXT.parse(mapOf("a" to "192.0.2.10")), FremkitTXT.parse(mapOf("a" to "192.0.2.10", "p" to "4243")))
        assertEquals(4302, FremkitTXT.parse(mapOf("a" to "192.0.2.10", "p" to "4302"))?.port)
        assertEquals(4243, FremkitTXT.parse(mapOf("a" to "192.0.2.10"))?.port)
    }

    @Test
    fun refusesARecordWithoutAUsableAddress() {
        assertNull(FremkitTXT.parse(emptyMap()))
        assertNull("a name is what could not be resolved in the first place", FremkitTXT.parse(mapOf("a" to "studio.local")))
        assertNull(FremkitTXT.parse(mapOf("a" to "")))
        // The Mac answers on its IPv4 addresses and its `.local` name only: an IPv6 one gets 421.
        assertNull(FremkitTXT.parse(mapOf("a" to "fe80::1%en0")))
        assertNull(FremkitTXT.parse(mapOf("a" to "2001:db8::1")))
        assertNull(FremkitTXT.parse(mapOf("a" to "192.0.2.10", "p" to "0")))
        assertNull(FremkitTXT.parse(mapOf("a" to "192.0.2.10", "p" to "x")))
    }

    @Test
    fun theAdvertisedAddressComesFirstOnceItAnswers() {
        var mac = DiscoveredMac(name = "Studio")
        assertNull("pending: nothing known yet", mac.service)
        mac = mac.copy(advertised = FremkitTXT.parse(mapOf("a" to "192.0.2.10", "p" to "4243")))
        assertNull("advertised but not checked", mac.service)
        mac = mac.copy(resolved = MacService("Studio", "198.51.100.7", 4243))
        assertEquals("198.51.100.7", mac.service?.address)
        mac = mac.copy(advertisedAnswers = true)
        assertEquals(listOf("192.0.2.10", "198.51.100.7"), mac.candidates.map { it.address })
        assertEquals(MacService("Studio", "192.0.2.10", 4243), mac.service)
        mac = mac.copy(resolved = MacService("Studio", "192.0.2.10", 4243))
        assertEquals("the same address once", 1, mac.candidates.size)
    }

    @Test
    fun anIPv6ResolvedEndpointIsNeverACandidate() {
        var mac = DiscoveredMac(name = "Studio", resolved = MacService("Studio", "fe80::1%en0", 4243))
        assertEquals("the Mac would refuse it as a Host", emptyList<MacService>(), mac.candidates)
        assertNull("so manual pairing never sends the code there", mac.service)
        mac = mac.copy(resolved = MacService("Studio", "2001:db8::7", 4243))
        assertEquals(emptyList<MacService>(), mac.candidates)
        mac = mac.copy(resolved = MacService("Studio", "Studio.local", 4243))
        assertEquals(listOf("Studio.local"), mac.candidates.map { it.address })
    }

    @Test
    fun connectableHostsAreLocalNamesAndIPv4Only() {
        for (host in listOf("studio.local", "Studio.local.", "192.0.2.10")) assertTrue(host, isConnectableHost(host))
        for (host in listOf("fe80::1%en0", "2001:db8::1", "[2001:db8::1]", "studio.example.com", "studio", "")) {
            assertFalse(host, isConnectableHost(host))
        }
    }

    @Test
    fun connectorCandidatesFromEveryMacOnce() {
        val a = DiscoveredMac(
            name = "B",
            advertised = FremkitTXT.parse(mapOf("a" to "192.0.2.10")),
            advertisedAnswers = true,
            resolved = MacService("B", "192.0.2.11", 4243),
        )
        val b = DiscoveredMac(name = "A", resolved = MacService("A", "192.0.2.10", 4243))
        val pending = DiscoveredMac(name = "C")
        assertEquals(listOf("192.0.2.10", "192.0.2.11"), listOf(a, b, pending).addresses)
    }

    // Kotlin only.

    @Test
    fun anAnsweringAdvertisementOnAnotherPortIsAnotherCandidate() {
        val mac = DiscoveredMac(
            name = "Studio",
            advertised = FremkitTXT("192.0.2.10", 4302),
            advertisedAnswers = true,
            resolved = MacService("Studio", "192.0.2.10", 4243),
        )
        assertEquals(listOf(4302, 4243), mac.candidates.map { it.port })
    }

    @Test
    fun aRecordIgnoresOtherKeys() {
        assertEquals(FremkitTXT("192.0.2.10", 4243), FremkitTXT.parse(mapOf("a" to "192.0.2.10", "k" to "x", "v" to "1")))
    }
}
