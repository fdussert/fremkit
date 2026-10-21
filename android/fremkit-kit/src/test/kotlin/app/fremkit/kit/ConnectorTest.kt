package app.fremkit.kit

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Answers each host from a table and remembers the order it was asked in. */
class FakeProber(private val outcomes: Map<String, ProbeOutcome>) : Prober {
    private val asked = Recorder<String>()
    val hosts: List<String> get() = asked.items

    override suspend fun probe(host: String, port: Int, mac: PairedMac): ProbeOutcome {
        asked.add(host)
        return outcomes[host] ?: ProbeOutcome.Unreachable
    }
}

class ConnectorTest {
    private fun connect(prober: Prober, discovered: List<String>, preferring: String? = null, mac: PairedMac = sampleMac) =
        runBlocking { Connector(prober).connect(mac, discovered, preferring) }

    private fun relocate(prober: Prober, discovered: List<String>, current: String, mac: PairedMac = sampleMac) =
        runBlocking { Connector(prober).relocate(mac, discovered, current) }

    @Test
    fun fallsBackToTheStoredAddressWhenTheNameFails() {
        val prober = FakeProber(mapOf("studio.local" to ProbeOutcome.Unreachable, "192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        assertEquals(ConnectResult.Connected("192.0.2.10", sampleInfo), connect(prober, listOf("198.51.100.7")))
        assertEquals(listOf("studio.local", "192.0.2.10"), prober.hosts)
    }

    @Test
    fun triesDiscoveredAddressesAfterAWrongMacAndAStaleAddress() {
        val prober = FakeProber(mapOf(
            "studio.local" to ProbeOutcome.PinMismatch,
            "192.0.2.10" to ProbeOutcome.Unreachable,
            "198.51.100.7" to ProbeOutcome.Ok(sampleInfo),
        ))
        val result = connect(prober, listOf("192.0.2.10", "198.51.100.7", "198.51.100.7"))
        assertEquals(ConnectResult.Connected("198.51.100.7", sampleInfo), result)
        assertEquals(listOf("studio.local", "192.0.2.10", "198.51.100.7"), prober.hosts)
        assertEquals("198.51.100.7", sampleMac.updating(address = "198.51.100.7").address)
    }

    @Test
    fun stopsAtTheFirstUnauthorized() {
        val prober = FakeProber(mapOf(
            "studio.local" to ProbeOutcome.Unreachable,
            "192.0.2.10" to ProbeOutcome.Unauthorized,
            "198.51.100.7" to ProbeOutcome.Ok(sampleInfo),
        ))
        assertEquals(ConnectResult.Unauthorized, connect(prober, listOf("198.51.100.7")))
        assertEquals(listOf("studio.local", "192.0.2.10"), prober.hosts)
    }

    @Test
    fun isUnreachableWhenNothingAnswers() {
        val prober = FakeProber(emptyMap())
        assertEquals(ConnectResult.Unreachable, connect(prober, listOf("198.51.100.7", "198.51.100.8")))
        assertEquals(listOf("studio.local", "192.0.2.10", "198.51.100.7", "198.51.100.8"), prober.hosts)
    }

    @Test
    fun isKeyChangedWhenOnlyAWrongKeyAnswered() {
        // The Mac's own name or its last address presenting another key: the key changed.
        for (host in listOf("studio.local", "192.0.2.10")) {
            val prober = FakeProber(mapOf(host to ProbeOutcome.PinMismatch))
            assertEquals(host, ConnectResult.KeyChanged, connect(prober, listOf("198.51.100.7", "198.51.100.8")))
            assertEquals(listOf("studio.local", "192.0.2.10", "198.51.100.7", "198.51.100.8"), prober.hosts)
        }
        // So does the host a caller prefers.
        val preferred = FakeProber(mapOf("198.51.100.9" to ProbeOutcome.PinMismatch))
        assertEquals(ConnectResult.KeyChanged, connect(preferred, emptyList(), preferring = "198.51.100.9"))
    }

    @Test
    fun aWrongKeyOnlyFromDiscoveryIsNotThisMac() {
        val prober = FakeProber(mapOf("198.51.100.7" to ProbeOutcome.PinMismatch))
        assertEquals(ConnectResult.Unreachable, connect(prober, listOf("198.51.100.7", "198.51.100.8")))
        assertEquals(listOf("studio.local", "192.0.2.10", "198.51.100.7", "198.51.100.8"), prober.hosts)
    }

    @Test
    fun candidatesAreDeduplicatedIgnoringCase() {
        assertEquals(
            listOf("studio.local", "192.0.2.10", "198.51.100.7"),
            Connector.candidates(sampleMac, listOf("STUDIO.local", "198.51.100.7", "192.0.2.10")),
        )
    }

    @Test
    fun candidatesAreLocalNamesAndIPv4Only() {
        assertEquals(
            listOf("studio.local", "192.0.2.10", "198.51.100.7"),
            Connector.candidates(sampleMac, listOf("fe80::1%en0", "2001:db8::1", "198.51.100.7"), preferring = "fe80::2%en0"),
        )
    }

    @Test
    fun aRelocationIsKeyChangedOnlyWhenTheHostInUsePresentsAnotherKey() {
        // A stale address another Mac now holds answers with its key: not this one, and not proof
        // that this Mac's key changed while the host in use simply missed a request.
        val stale = FakeProber(mapOf("198.51.100.7" to ProbeOutcome.PinMismatch))
        assertEquals(ConnectResult.Unreachable, relocate(stale, listOf("198.51.100.7"), current = "192.0.2.10"))
        assertEquals(listOf("192.0.2.10", "studio.local", "198.51.100.7"), stale.hosts)

        val reset = FakeProber(mapOf("192.0.2.10" to ProbeOutcome.PinMismatch, "198.51.100.7" to ProbeOutcome.PinMismatch))
        assertEquals(ConnectResult.KeyChanged, relocate(reset, listOf("198.51.100.7"), current = "192.0.2.10"))

        val moved = FakeProber(mapOf("192.0.2.10" to ProbeOutcome.PinMismatch, "198.51.100.7" to ProbeOutcome.Ok(sampleInfo)))
        assertEquals(ConnectResult.Connected("198.51.100.7", sampleInfo), relocate(moved, listOf("198.51.100.7"), current = "192.0.2.10"))
    }

    @Test
    fun aPreferredHostIsTriedFirst() {
        assertEquals(
            listOf("198.51.100.7", "studio.local", "192.0.2.10"),
            Connector.candidates(sampleMac, listOf("198.51.100.7"), preferring = "198.51.100.7"),
        )
        assertEquals(listOf("192.0.2.10", "studio.local"), Connector.candidates(sampleMac, emptyList(), preferring = "192.0.2.10"))
    }

    @Test
    fun updatingKeepsTheRecordWhenTheHostIsAName() {
        assertEquals(sampleMac, sampleMac.updating(address = "studio.local"))
        assertEquals("2001:db8::2", sampleMac.updating(address = "2001:db8::2").address)
        assertEquals("device-token", sampleMac.updating(address = "198.51.100.7").token)
    }

    @Test
    fun printingNeverShowsTheTokenOrKey() {
        val text = "$sampleMac ${ConnectResult.Connected("192.0.2.10", sampleInfo)}"
        assertFalse(text.contains("device-token"))
        assertFalse(text.contains(SpkiFixture.keyHash))
        assertTrue(text.contains("studio.local"))
    }

    // Kotlin only.

    @Test
    fun aRelocationMatchesTheHostInUseWithoutCase() {
        val asked = Recorder<String>()
        val reset = Prober { host, _, _ -> asked.add(host); if (host == "Studio.local.") ProbeOutcome.PinMismatch else ProbeOutcome.Unreachable }
        assertEquals(ConnectResult.KeyChanged, relocate(reset, emptyList(), current = "Studio.local."))
        assertEquals("the Mac's own name is the same host", listOf("Studio.local.", "192.0.2.10"), asked.items)
    }

    @Test
    fun probesEachCandidateOnTheMacsPort() {
        val ports = Recorder<Int>()
        runBlocking {
            Connector { _, port, _ -> ports.add(port); ProbeOutcome.Unreachable }.connect(sampleMac, listOf("198.51.100.7"))
        }
        assertEquals(listOf(4243, 4243, 4243), ports.items)
    }
}
