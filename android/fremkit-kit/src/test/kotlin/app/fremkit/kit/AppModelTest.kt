package app.fremkit.kit

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import kotlin.time.Duration.Companion.seconds

/**
 * Answers each host from a table that a test can change between attempts, and can hold one
 * host's answers until the test lets them go.
 */
class ScriptedProber(outcomes: Map<String, ProbeOutcome>) : Prober {
    private val lock = Any()
    private val outcomes = outcomes.toMutableMap()
    private val asked = mutableListOf<String>()
    private var held: String? = null
    private var gate = CompletableDeferred<Unit>()
    private var waiting = 0

    val hosts: List<String> get() = synchronized(lock) { asked.toList() }

    fun set(host: String, outcome: ProbeOutcome) = synchronized(lock) { outcomes[host] = outcome }

    /** Every probe of [host] waits for [release]. */
    fun hold(host: String) = synchronized(lock) {
        held = host
        gate = CompletableDeferred()
    }

    /** The number of probes waiting now (a cancelled one stops waiting). */
    val holding: Int get() = synchronized(lock) { waiting }

    fun release() {
        val opened = synchronized(lock) {
            held = null
            gate
        }
        opened.complete(Unit)
    }

    override suspend fun probe(host: String, port: Int, mac: PairedMac): ProbeOutcome {
        val wait = synchronized(lock) {
            asked += host
            if (held == host) gate.also { waiting += 1 } else null
        }
        if (wait != null) {
            try {
                wait.await()
            } finally {
                synchronized(lock) { waiting -= 1 }
            }
        }
        return synchronized(lock) { outcomes[host] ?: ProbeOutcome.Unreachable }
    }
}

/** A store that holds [stored] and cannot read or write it until [heal]. */
class UnreadableStore(private val stored: PairedMac? = null) : CredentialStore {
    private val lock = Any()
    private var broken = true
    private var cleared = false

    val wasCleared: Boolean get() = synchronized(lock) { cleared }

    fun heal() = synchronized(lock) { broken = false }

    override fun load(): PairedMac? = synchronized(lock) {
        if (broken) throw UnreadableCredentialsException("the Keystore key is gone")
        stored
    }

    override fun save(mac: PairedMac) = synchronized(lock) {
        if (broken) throw IOException("the store refused the pairing")
    }

    override fun clear() = synchronized(lock) { cleared = true }
}

/** A model on the test's scheduler: its jobs run as the test advances, its delays are virtual. */
fun TestScope.appModel(
    store: CredentialStore,
    prober: Prober,
    discovered: () -> List<String> = { emptyList() },
): AppModel = AppModel(store, Connector(prober), discovered, StandardTestDispatcher(testScheduler))

/**
 * Every state the model goes through from now on, as it is set: the model's follow-up jobs may run
 * before the test resumes, so a state that passes is checked here rather than read afterwards.
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun TestScope.history(model: AppModel): List<AppState> {
    val states = mutableListOf<AppState>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { model.state.collect { states += it } }
    return states
}

/** Runs the model's jobs until none is left. */
@OptIn(ExperimentalCoroutinesApi::class)
fun TestScope.settle() = advanceUntilIdle()

/** `AppModelTests`, on `kotlinx-coroutines-test`. */
@OptIn(ExperimentalCoroutinesApi::class)
class AppModelTest {
    private fun dashboard(host: String, info: DeviceInfo = sampleInfo) = AppState.Dashboard(host, info)

    @Test
    fun welcomeWhenNothingIsStored() = runTest {
        val model = appModel(MemoryCredentialStore(), ScriptedProber(emptyMap()))
        assertNull(model.start())
        assertEquals(AppState.Welcome, model.state.value)
        assertFalse(model.credentialsUnreadable.value)
    }

    @Test
    fun anUnreadableStoreShowsWelcomeAndKeepsThePairing() = runTest {
        val store = UnreadableStore()
        val model = appModel(store, ScriptedProber(emptyMap()))
        model.start()
        assertEquals(AppState.Welcome, model.state.value)
        assertTrue(model.credentialsUnreadable.value)
        assertFalse(store.wasCleared)
    }

    @Test
    fun aPairingThatCannotBeSavedIsRefused() = runTest {
        val model = appModel(UnreadableStore(), ScriptedProber(emptyMap()))
        model.start()
        assertThrows(IOException::class.java) { model.pair(sampleMac) }
        assertNull(model.mac.value)
        assertEquals(AppState.Welcome, model.state.value)
    }

    @Test
    fun connectsAtLaunchAndKeepsTheAddressThatWorked() = runTest {
        val store = MemoryCredentialStore(sampleMac)
        val model = appModel(store, ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo))))
        model.start()?.join()
        assertEquals(dashboard("192.0.2.10"), model.state.value)
        assertEquals(sampleMac, store.load())
    }

    @Test
    fun storesTheDiscoveredAddressWhenTheMacMoved() = runTest {
        val store = MemoryCredentialStore(sampleMac)
        val prober = ScriptedProber(mapOf("198.51.100.7" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(store, prober, discovered = { listOf("198.51.100.7") })
        model.start()?.join()
        assertEquals(dashboard("198.51.100.7"), model.state.value)
        assertEquals("198.51.100.7", store.load()?.address)
        assertEquals("198.51.100.7", model.mac.value?.address)
    }

    @Test
    fun unreachableNamesTheMacAndRecoversWithoutLeavingTheScreen() = runTest {
        val prober = ScriptedProber(emptyMap())
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        assertEquals(AppState.Unreachable("studio"), model.state.value)

        prober.set("studio.local", ProbeOutcome.Ok(sampleInfo))
        val retry = model.reconnect()
        assertEquals("the screen stays up while it retries", AppState.Unreachable("studio"), model.state.value)
        assertTrue(model.isConnecting.value)
        retry.join()
        assertFalse(model.isConnecting.value)
        assertEquals(dashboard("studio.local"), model.state.value)
    }

    @Test
    fun keyChangedKeepsThePairingAndRecoversOnALaterOk() = runTest {
        val store = MemoryCredentialStore(sampleMac)
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.PinMismatch))
        val model = appModel(store, prober)
        model.start()?.join()
        assertEquals(AppState.KeyChanged("studio"), model.state.value)
        assertEquals("a wrong key never forgets the pairing", sampleMac, store.load())

        val retry = model.reconnect()
        assertEquals("the screen stays up while it retries", AppState.KeyChanged("studio"), model.state.value)
        retry.join()
        assertEquals(AppState.KeyChanged("studio"), model.state.value)

        prober.set("studio.local", ProbeOutcome.Ok(sampleInfo))
        model.reconnect().join()
        assertEquals(dashboard("studio.local"), model.state.value)
    }

    @Test
    fun aResumeOnTheDashboardLandsInKeyChanged() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        prober.set("studio.local", ProbeOutcome.PinMismatch)
        model.resume()?.join()
        // The check ends in a reconnect, which is its own job.
        model.reconnect().join()
        assertEquals(AppState.KeyChanged("studio"), model.state.value)
    }

    @Test
    fun oneAttemptAtATime() = runTest {
        val prober = ScriptedProber(emptyMap())
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        val asked = prober.hosts.size
        val first = model.reconnect()
        val second = model.reconnect()
        first.join()
        second.join()
        assertEquals("studio.local and 192.0.2.10, once", 2, prober.hosts.size - asked)
    }

    @Test
    fun unauthorizedThenForgetGoesBackToWelcome() = runTest {
        val store = MemoryCredentialStore(sampleMac)
        val model = appModel(store, ScriptedProber(mapOf("studio.local" to ProbeOutcome.Unauthorized)))
        model.start()?.join()
        assertEquals(AppState.Unauthorized, model.state.value)
        model.forget()
        assertEquals(AppState.Welcome, model.state.value)
        assertNull(model.mac.value)
        assertNull(store.load())
    }

    @Test
    fun thePageSayingUnauthorizedLeavesTheDashboard() = runTest {
        val model = appModel(MemoryCredentialStore(sampleMac), ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo))))
        model.start()?.join()
        model.pageSaidUnauthorized()
        assertEquals(AppState.Unauthorized, model.state.value)
    }

    @Test
    fun aWebViewFailureReconnects() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        prober.set("studio.local", ProbeOutcome.Unreachable)
        model.dashboardFailed()
        assertEquals(AppState.Connecting, model.state.value)
        model.reconnect().join()
        assertEquals(AppState.Unreachable("studio"), model.state.value)
    }

    @Test
    fun aWebViewFailureDuringACheckRebuildsTheDashboard() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        prober.hold("192.0.2.10")
        val check = model.resume()
        model.dashboardFailed()
        assertEquals("the dead WebView goes away instead of joining the check", AppState.Connecting, model.state.value)
        val attempt = model.reconnect()
        while (prober.holding < 1) runCurrent()
        prober.release()
        check?.join()
        attempt.join()
        assertEquals(dashboard("192.0.2.10"), model.state.value)
    }

    @Test
    fun resumeOnTheDashboardChecksTheHostInUse() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        val asked = prober.hosts.size
        val moved = DeviceInfo(id = "d1", name = "iPad", screenId = "s2", brightness = null)
        prober.set("192.0.2.10", ProbeOutcome.Ok(moved))
        model.resume()?.join()
        assertEquals(listOf("192.0.2.10"), prober.hosts.drop(asked))
        assertEquals(dashboard("192.0.2.10", moved), model.state.value)

        prober.set("192.0.2.10", ProbeOutcome.Unauthorized)
        model.resume()?.join()
        assertEquals(AppState.Unauthorized, model.state.value)
    }

    @Test
    fun resumeOnTheDashboardReconnectsWhenTheHostIsGone() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober, discovered = { listOf("198.51.100.7") })
        model.start()?.join()
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        prober.set("198.51.100.7", ProbeOutcome.Ok(sampleInfo))
        val states = history(model)
        model.resume()?.join()
        // The check ends in a reconnect, which is its own job.
        settle()
        assertEquals(listOf(dashboard("192.0.2.10"), AppState.Connecting, dashboard("198.51.100.7")), states)
    }

    @Test
    fun resumeReadsAnUnreadableStoreAgain() = runTest {
        val store = UnreadableStore(sampleMac)
        val model = appModel(store, ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo))))
        model.start()
        assertEquals(AppState.Welcome, model.state.value)
        store.heal()
        model.resume()?.join()
        assertFalse(model.credentialsUnreadable.value)
        assertEquals(dashboard("studio.local"), model.state.value)
    }

    @Test
    fun resumeOnWelcomeDoesNothingWhenNothingIsStored() = runTest {
        val store = MemoryCredentialStore()
        val model = appModel(store, ScriptedProber(emptyMap()))
        model.start()
        store.save(sampleMac)
        assertNull("a store that read fine and was empty is not read again", model.resume())
        assertEquals(AppState.Welcome, model.state.value)
    }

    @Test
    fun anAttemptForAForgottenPairingIsDropped() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        prober.hold("studio.local")
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        val attempt = model.start()
        runCurrent()
        model.forget()
        prober.release()
        attempt?.join()
        settle()
        assertEquals(AppState.Welcome, model.state.value)
        assertNull(model.mac.value)
    }

    @Test
    fun theDashboardCheckShowsUnauthorizedOnly() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        assertEquals(dashboard("studio.local"), model.state.value)

        prober.set("studio.local", ProbeOutcome.Unreachable)
        model.checkAuthorization()?.join()
        assertEquals("an unanswered check leaves the page alone", dashboard("studio.local"), model.state.value)
        assertEquals("an unanswered check does not reconnect to other hosts", emptyList<String>(),
            prober.hosts.filter { it != "studio.local" })

        prober.set("studio.local", ProbeOutcome.Unauthorized)
        model.checkAuthorization()?.join()
        assertEquals(AppState.Unauthorized, model.state.value)
        assertNull("only on the dashboard", model.checkAuthorization())
    }

    /**
     * The dashboard on the Mac's last address (its `.local` name does not resolve here), and what
     * NSD resolves, which a test can change.
     */
    private suspend fun TestScope.dashboardOnAnAddress(
        prober: ScriptedProber,
        discovered: () -> List<String>,
    ): Pair<AppModel, MemoryCredentialStore> {
        val store = MemoryCredentialStore(sampleMac)
        val model = appModel(store, prober, discovered)
        model.start()?.join()
        assertEquals(dashboard("192.0.2.10"), model.state.value)
        return model to store
    }

    @Test
    fun twoUnansweredChecksFollowTheMacToItsNewAddressWithoutLeavingTheDashboard() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        var resolved = emptyList<String>()
        val (model, store) = dashboardOnAnAddress(prober) { resolved }
        // The Mac moved: its old address is dead, NSD now resolves the new one.
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        prober.set("198.51.100.7", ProbeOutcome.Ok(sampleInfo))
        resolved = listOf("198.51.100.7")

        model.checkAuthorization()?.join()
        settle()
        assertEquals("one unanswered check moves nothing", dashboard("192.0.2.10"), model.state.value)
        assertFalse(prober.hosts.contains("198.51.100.7"))

        val states = history(model)
        model.checkAuthorization()?.join()
        settle()
        assertEquals("the page stays up while the app looks", listOf(dashboard("192.0.2.10"), dashboard("198.51.100.7")), states)
        assertEquals("198.51.100.7", model.mac.value?.address)
        assertEquals("remembered for the next launch", "198.51.100.7", store.load()?.address)
    }

    @Test
    fun aMacThatAnswersNowhereLeavesTheDashboardAlone() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val (model, _) = dashboardOnAnAddress(prober) { listOf("198.51.100.7") }
        // Asleep: nothing answers anywhere. The page waits; no flicker through Connecting.
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        repeat(3) {
            model.checkAuthorization()?.join()
            assertEquals(dashboard("192.0.2.10"), model.state.value)
            settle()
            assertEquals(dashboard("192.0.2.10"), model.state.value)
        }
        assertTrue("it did look elsewhere", prober.hosts.contains("198.51.100.7"))
    }

    @Test
    fun anAnswerBetweenUnansweredChecksStartsTheCountAgain() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val (model, _) = dashboardOnAnAddress(prober) { listOf("198.51.100.7") }
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        model.checkAuthorization()?.join()
        prober.set("192.0.2.10", ProbeOutcome.Ok(sampleInfo))
        model.checkAuthorization()?.join()
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        model.checkAuthorization()?.join()
        settle()
        assertFalse("two transient failures a minute apart are not a move", prober.hosts.contains("198.51.100.7"))
    }

    @Test
    fun aRelocationThatMeetsARevocationShowsUnauthorized() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val (model, _) = dashboardOnAnAddress(prober) { listOf("198.51.100.7") }
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        prober.set("198.51.100.7", ProbeOutcome.Unauthorized)
        model.checkAuthorization()?.join()
        model.checkAuthorization()?.join()
        settle()
        assertEquals(AppState.Unauthorized, model.state.value)
    }

    @Test
    fun aNewAddressMovesTheDashboardOnlyWhenTheHostInUseIsGone() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo), "198.51.100.7" to ProbeOutcome.Ok(sampleInfo)))
        val (model, _) = dashboardOnAnAddress(prober) { listOf("198.51.100.7") }
        val before = prober.hosts.size

        // The page's host still answers: it stays, and nothing else is asked.
        model.addressesChanged()?.join()
        assertEquals(dashboard("192.0.2.10"), model.state.value)
        assertEquals(listOf("192.0.2.10"), prober.hosts.drop(before))

        // The Mac left that address: the new one takes over at once, no periodic check needed.
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        model.addressesChanged()?.join()
        assertEquals(dashboard("198.51.100.7"), model.state.value)
    }

    @Test
    fun aNewAddressDoesNothingAwayFromTheDashboard() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val (model, _) = dashboardOnAnAddress(prober) { emptyList() }
        model.pageSaidUnauthorized()
        assertNull(model.addressesChanged())
    }

    @Test
    fun anAddressAnnouncedDuringACheckIsActedOnWhenTheCheckEnds() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo), "198.51.100.7" to ProbeOutcome.Ok(sampleInfo)))
        var resolved = emptyList<String>()
        val (model, _) = dashboardOnAnAddress(prober) { resolved }
        prober.hold("192.0.2.10")
        val check = model.checkAuthorization()
        while (prober.holding == 0) runCurrent()
        // The Mac moves while the check waits on its old address.
        resolved = listOf("198.51.100.7")
        assertNull("never two at once: remembered instead", model.addressesChanged())
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        prober.release()
        check?.join()
        settle()
        assertEquals("followed after a single unanswered check, because an address was announced",
            dashboard("198.51.100.7"), model.state.value)
    }

    @Test
    fun aStaleAddressWithAnotherKeyNeverReplacesTheDashboard() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val (model, _) = dashboardOnAnAddress(prober) { listOf("198.51.100.7") }
        // The host in use misses a request; another Fremkit Mac holds an address this one once had.
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        prober.set("198.51.100.7", ProbeOutcome.PinMismatch)
        model.addressesChanged()?.join()
        assertEquals(dashboard("192.0.2.10"), model.state.value)
        model.checkAuthorization()?.join()
        model.checkAuthorization()?.join()
        settle()
        assertEquals("nor does the periodic path", dashboard("192.0.2.10"), model.state.value)

        // The host in use itself presents another key: that is a changed key.
        prober.set("192.0.2.10", ProbeOutcome.PinMismatch)
        model.addressesChanged()?.join()
        assertEquals(AppState.KeyChanged("studio"), model.state.value)
    }

    @Test
    fun aReconnectDoesNotJoinARelocation() = runTest {
        val prober = ScriptedProber(mapOf("192.0.2.10" to ProbeOutcome.Ok(sampleInfo)))
        val (model, _) = dashboardOnAnAddress(prober) { emptyList() }
        prober.hold("192.0.2.10")
        val relocation = model.addressesChanged()
        while (prober.holding == 0) runCurrent()
        prober.set("192.0.2.10", ProbeOutcome.Unreachable)
        val attempt = model.reconnect()
        prober.release()
        relocation?.join()
        attempt.join()
        assertEquals("a joined relocation would have left the dashboard up", AppState.Unreachable("studio"), model.state.value)
    }

    @Test
    fun aPeriodicCheckThatMeetsAWrongKeyReconnectsAndLandsInKeyChanged() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        prober.set("studio.local", ProbeOutcome.PinMismatch)
        val states = history(model)
        model.checkAuthorization()?.join()
        settle()
        // A reset certificate must not leave a dead dashboard up: the check reconnects.
        assertEquals(listOf(dashboard("studio.local"), AppState.Connecting, AppState.KeyChanged("studio")), states)
    }

    @Test
    fun theDashboardCheckNeverOverlaps() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        prober.hold("studio.local")
        val first = model.checkAuthorization()
        assertNotNull(first)
        assertNull(model.checkAuthorization())
        while (prober.holding == 0) runCurrent()
        prober.release()
        first?.join()
        assertNotNull(model.checkAuthorization())
    }

    @Test
    fun aReconnectDoesNotJoinAPeriodicCheck() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        prober.hold("studio.local")
        val periodic = model.checkAuthorization()
        while (prober.holding == 0) runCurrent()
        prober.set("studio.local", ProbeOutcome.Unreachable)
        val attempt = model.reconnect()
        prober.release()
        periodic?.join()
        attempt.join()
        assertEquals("a joined periodic check would have ignored it", AppState.Unreachable("studio"), model.state.value)
    }

    @Test
    fun aResumeDoesNotJoinAPeriodicCheck() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        prober.hold("studio.local")
        val periodic = model.checkAuthorization()
        while (prober.holding == 0) runCurrent()
        prober.set("studio.local", ProbeOutcome.Unreachable)
        val resumed = model.resume()
        prober.release()
        periodic?.join()
        resumed?.join()
        // The resume's own check found nothing at the host in use and reconnected.
        while (model.isConnecting.value) model.reconnect().join()
        assertEquals(AppState.Unreachable("studio"), model.state.value)
    }

    @Test
    fun pairingReplacesThePairingAndConnects() = runTest {
        val other = PairedMac(host = "other.local", address = "198.51.100.20", port = 4243, keyHash = SpkiFixture.keyHash,
            token = "other-token", deviceId = "d2", name = "other")
        val store = MemoryCredentialStore(sampleMac)
        val prober = ScriptedProber(mapOf("other.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(store, prober)
        model.start()?.join()
        model.pair(other).join()
        assertEquals(other, store.load())
        assertEquals(dashboard("other.local"), model.state.value)
    }

    // Android only

    @Test
    fun theMacIdentityChangesOnPairForgetAndPairingAgain() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        val events = mutableListOf<MacIdentityChange>()
        val collecting = backgroundScope.launch { model.macIdentityChanged.toList(events) }
        model.start()?.join()
        runCurrent()
        assertEquals("loading the stored pairing changes nothing", emptyList<MacIdentityChange>(), events)

        // The Mac's certificate was reset: the key-changed screen, then the user pairs again.
        prober.set("studio.local", ProbeOutcome.PinMismatch)
        model.checkAuthorization()?.join()
        model.reconnect().join()
        assertEquals(AppState.KeyChanged("studio"), model.state.value)
        runCurrent()
        assertEquals("a changed key alone is not a new identity: the pin is the same", emptyList<MacIdentityChange>(), events)

        val repaired = PairedMac(host = "studio.local", address = "192.0.2.10", port = 4243, keyHash = "Y4nRTFWKfvKwllWID7DQPMgZIF8SqUUvgWkQZsK_ArQ",
            token = "new-token", deviceId = "d1", name = "studio")
        prober.set("studio.local", ProbeOutcome.Ok(sampleInfo))
        model.pair(repaired).join()
        model.forget()
        model.pair(sampleMac).join()
        runCurrent()
        assertEquals(listOf(MacIdentityChange.PAIRED, MacIdentityChange.FORGOTTEN, MacIdentityChange.PAIRED), events)
        collecting.cancel()
    }

    @Test
    fun aPairingTheStoreRefusesChangesNoIdentity() = runTest {
        val model = appModel(UnreadableStore(), ScriptedProber(emptyMap()))
        val events = mutableListOf<MacIdentityChange>()
        backgroundScope.launch { model.macIdentityChanged.toList(events) }
        model.start()
        assertThrows(IOException::class.java) { model.pair(sampleMac) }
        runCurrent()
        assertEquals(emptyList<MacIdentityChange>(), events)
    }

    @Test
    fun theServerVersionIsKeptWhileTheMacIsAwayAndDroppedWithThePairing() = runTest {
        val newer = DeviceInfo(id = "d1", name = "iPad", screenId = "s1", brightness = null, serverVersion = "0.6.0")
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(newer)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        assertNull(model.serverVersion.value)
        model.start()?.join()
        assertEquals("0.6.0", model.serverVersion.value)

        prober.set("studio.local", ProbeOutcome.Unreachable)
        model.dashboardFailed()
        model.reconnect().join()
        assertEquals(AppState.Unreachable("studio"), model.state.value)
        assertEquals("the unreachable screen still knows", "0.6.0", model.serverVersion.value)

        // A Mac that went back to a version without the field: its last answer says nothing.
        prober.set("studio.local", ProbeOutcome.Ok(sampleInfo))
        model.reconnect().join()
        assertNull(model.serverVersion.value)

        prober.set("studio.local", ProbeOutcome.Ok(newer))
        model.resume()?.join()
        assertEquals("a check updates it too", "0.6.0", model.serverVersion.value)
        model.forget()
        assertNull(model.serverVersion.value)
    }

    @Test
    fun runChecksTheDashboardEveryThirtySecondsAndRetriesEveryFive() = runTest {
        val prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo)))
        val model = appModel(MemoryCredentialStore(sampleMac), prober)
        model.start()?.join()
        val running = backgroundScope.launch { model.run() }
        runCurrent()
        val asked = prober.hosts.size

        advanceTimeBy(29.seconds)
        runCurrent()
        assertEquals("nothing before the interval", asked, prober.hosts.size)
        advanceTimeBy(1.seconds)
        runCurrent()
        assertEquals(listOf("studio.local"), prober.hosts.drop(asked))

        // The Mac goes away and the WebView fails: the retries take over.
        prober.set("studio.local", ProbeOutcome.Unreachable)
        model.dashboardFailed()
        runCurrent()
        assertEquals(AppState.Unreachable("studio"), model.state.value)
        val unreachableAt = prober.hosts.size
        advanceTimeBy(5.seconds)
        runCurrent()
        assertEquals("one retry, both addresses", 2, prober.hosts.size - unreachableAt)

        prober.set("studio.local", ProbeOutcome.Ok(sampleInfo))
        advanceTimeBy(5.seconds)
        runCurrent()
        assertEquals(dashboard("studio.local"), model.state.value)
        running.cancel()
        // Stopped: no more checks.
        val stoppedAt = prober.hosts.size
        advanceTimeBy(300.seconds)
        runCurrent()
        assertEquals(stoppedAt, prober.hosts.size)
    }

    @Test
    fun theVersionNudgeComparesMajorMinorPatch() {
        assertEquals(VersionNudge.UPDATE_MAC, VersionNudge.of("0.5.0", "0.6.0"))
        assertEquals(VersionNudge.UPDATE_MAC, VersionNudge.of("0.9.9", "1.0.0"))
        assertEquals(VersionNudge.UPDATE_APP, VersionNudge.of("0.10.0", "0.9.3"))
        assertEquals(VersionNudge.UPDATE_APP, VersionNudge.of("1.0.1", "1.0.0"))
        assertNull("the same release", VersionNudge.of("0.6.0", "0.6.0"))
        assertNull("a pre-release suffix is ignored", VersionNudge.of("0.6.0-beta.1", "0.6.0"))
        assertNull(VersionNudge.of("0.6.0", "0.6.0+42"))
        assertNull("a Mac older than the field says nothing", VersionNudge.of(null, "0.6.0"))
        assertNull("nor does something that is not a version", VersionNudge.of("latest", "0.6.0"))
        assertNull(VersionNudge.of("0.6", "0.6.0"))
    }
}
