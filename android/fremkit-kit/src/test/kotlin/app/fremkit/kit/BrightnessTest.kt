package app.fremkit.kit

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.seconds

/** `BrightnessStateTests`. */
class BrightnessStateTest {
    @Test
    fun appliesANewSeqOnce() {
        val state = BrightnessState()
        assertTrue(state.apply(40.0, 3))
        assertFalse(state.apply(40.0, 3))
        assertFalse(state.apply(80.0, 3))
        assertEquals(3, state.lastApplied)
    }

    @Test
    fun acceptsALowerSeqBecauseTheServerRestarted() {
        val state = BrightnessState()
        assertTrue(state.apply(40.0, 9))
        assertTrue(state.apply(60.0, 0))
        assertEquals(0, state.lastApplied)
    }

    @Test
    fun refusesATargetThatIsNotANumber() {
        val state = BrightnessState()
        assertFalse(state.apply(Double.NaN, 1))
        assertNull(state.lastApplied)
    }

    @Test
    fun levelRoundsAndClamps() {
        assertEquals(0.4, BrightnessState.level(40.0), 1e-9)
        assertEquals(1.0, BrightnessState.level(140.0), 0.0)
        assertEquals(0.0, BrightnessState.level(-5.0), 0.0)
        assertEquals(0.0, BrightnessState.level(Double.POSITIVE_INFINITY), 0.0)
    }
}

/** `BrightnessSendTests`: the answer as an outcome, under the Mac's pin. */
class BrightnessSendTest {
    private val reporter = BrightnessReporter(sampleMac, "192.0.2.10")

    private fun outcome(status: Int?): ReportOutcome {
        var result: ReportOutcome? = null
        runTest { result = reporter.send(0.5, null) { status } }
        return result!!
    }

    @Test
    fun mapsTheAnswer() {
        assertEquals(ReportOutcome.SENT, outcome(204))
        assertEquals(ReportOutcome.UNAUTHORIZED, outcome(401))
        assertEquals(ReportOutcome.FAILED, outcome(409))
        // A pin refusal and a network failure both come back without a status.
        assertEquals(ReportOutcome.FAILED, outcome(null))
        assertEquals(ReportOutcome.FAILED, outcome(500))
    }

    @Test
    fun sendsUnderThePinOfTheMac() = runTest {
        var seen: BrightnessRequest? = null
        reporter.send(0.5, 2) { seen = it; 204 }
        assertEquals(sampleMac.keyHash, seen?.keyHash)
        assertEquals(setOf("192.0.2.10", "studio.local"), seen?.pinnedHosts)
        assertEquals("POST", seen?.method)
    }
}

/** `BrightnessReporterTests` (in the Swift kit's RequestTests.swift). */
class BrightnessReporterTest {
    private fun json(body: String): JsonObject = Json.parseToJsonElement(body).jsonObject

    @Test
    fun buildsTheReportRequest() {
        val request = BrightnessReporter(sampleMac, "192.0.2.10").request(0.426, 7)
        assertEquals("https://192.0.2.10:4243/api/devices/me/brightness", request.url)
        assertEquals("POST", request.method)
        assertEquals("fremkit_device=device-token", request.headers["Cookie"])
        assertEquals("application/json", request.headers["Content-Type"])
        val body = json(request.body)
        assertEquals(setOf("value", "applied"), body.keys)
        assertEquals(43, body["value"]!!.jsonPrimitive.int)
        assertEquals(7, body["applied"]!!.jsonPrimitive.int)
    }

    @Test
    fun omitsAppliedWhenNothingWasApplied() {
        val body = json(BrightnessReporter(sampleMac, "studio.local").request(1.0, null).body)
        assertEquals(setOf("value"), body.keys)
        assertEquals(100, body["value"]!!.jsonPrimitive.int)
    }

    @Test
    fun clampsTheValue() {
        assertEquals(0, BrightnessReporter.value(-0.2))
        assertEquals(100, BrightnessReporter.value(1.7))
        assertEquals(1, BrightnessReporter.value(0.005))
        assertEquals(0, BrightnessReporter.value(Double.NaN))
    }

    @Test
    fun anIPv6HostIsBracketed() {
        assertEquals(
            "https://[fe80::1%25en0]:4243/api/devices/me/brightness",
            BrightnessReporter(sampleMac, "fe80::1%en0").request(0.5, null).url,
        )
    }

    @Test
    fun printingNeverShowsTheTokenOrThePin() {
        val request = BrightnessReporter(sampleMac, "192.0.2.10").request(0.5, 1)
        for (text in listOf(request.toString(), BrightnessReporter(sampleMac, "192.0.2.10").toString())) {
            assertFalse(text, text.contains(sampleMac.token))
            assertFalse(text, text.contains(sampleMac.keyHash))
        }
    }
}

/**
 * `BrightnessSyncTests`, on `kotlinx-coroutines-test`'s virtual time instead of the Swift tests'
 * hand-driven sleeper: the real 500 ms debounce and 10 s heartbeat, run instantly.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BrightnessSyncTest {
    private class Fake {
        var screen = 0.5
        val reports = mutableListOf<Pair<Double, Int?>>()
        var answer = ReportOutcome.SENT
        fun record(level: Double, applied: Int?): ReportOutcome {
            reports += level to applied
            return answer
        }
    }

    /** Every `delay` the sync asked for, in order. */
    private val delays = mutableListOf<kotlin.time.Duration>()

    private fun TestScope.make(fake: Fake, unauthorized: () -> Unit = {}) = BrightnessSync(
        scope = backgroundScope,
        read = { fake.screen },
        write = { fake.screen = it },
        send = { level, applied -> fake.record(level, applied) },
        unauthorized = unauthorized,
        delay = { delays += it; delay(it) },
    )

    @Test
    fun appliesANewTargetAndReportsTheScreenLevelWithTheSeq() = runTest {
        val fake = Fake()
        val sync = make(fake)
        sync.receive(30.0, 4)?.join()
        assertEquals(0.3, fake.screen, 1e-9)
        assertEquals(1, fake.reports.size)
        assertEquals(fake.screen, fake.reports[0].first, 1e-9)
        assertEquals(30, BrightnessReporter.value(fake.reports[0].first))
        assertEquals(4, fake.reports[0].second)
    }

    @Test
    fun theSameSeqLeavesTheScreenAloneSoTheSystemSliderWins() = runTest {
        val fake = Fake()
        val sync = make(fake)
        sync.receive(30.0, 4)?.join()
        fake.screen = 0.9
        assertNull(sync.receive(30.0, 4))
        assertEquals(0.9, fake.screen, 0.0)
        assertEquals(1, fake.reports.size)
    }

    @Test
    fun aSyncThatOutlivesTheDashboardStillRefusesTheSeqItApplied() = runTest {
        // The dashboard is rebuilt around the same sync: the new page pushes seq 4 again.
        val fake = Fake()
        val sync = make(fake)
        sync.receive(30.0, 4)?.join()
        sync.stop() // the old dashboard went away
        fake.screen = 0.8
        assertNull(sync.receive(30.0, 4))
        assertEquals(0.8, fake.screen, 0.0)
        assertEquals(4, sync.lastApplied)
    }

    @Test
    fun resetForgetsWhatWasApplied() = runTest {
        val fake = Fake()
        val sync = make(fake)
        sync.receive(30.0, 4)?.join()
        sync.reset()
        assertNotNull(sync.receive(30.0, 4))
    }

    @Test
    fun appliedIsSentAgainUntilAReportLands() = runTest {
        val fake = Fake()
        fake.answer = ReportOutcome.FAILED
        val sync = make(fake)
        sync.receive(30.0, 4)?.join()
        fake.answer = ReportOutcome.SENT
        sync.levelChanged()
        advanceTimeBy(BrightnessSync.DEBOUNCE)
        runCurrent()
        assertEquals(2, fake.reports.size)
        sync.levelChanged()
        advanceTimeBy(BrightnessSync.DEBOUNCE)
        runCurrent()
        assertEquals(listOf(4, 4, null), fake.reports.map { it.second })
    }

    @Test
    fun levelChangesAreDebounced() = runTest {
        val fake = Fake()
        val sync = make(fake)
        sync.levelChanged()
        sync.levelChanged()
        sync.levelChanged()
        advanceTimeBy(BrightnessSync.DEBOUNCE - 1.seconds / 1000)
        runCurrent()
        assertEquals(0, fake.reports.size)
        advanceTimeBy(1.seconds / 1000)
        runCurrent()
        assertEquals(1, fake.reports.size)
        advanceTimeBy(BrightnessSync.HEARTBEAT)
        runCurrent()
        assertEquals(1, fake.reports.size)
        assertEquals(BrightnessSync.DEBOUNCE, delays.first())
    }

    @Test
    fun stopPreventsAPendingDebouncedReport() = runTest {
        val fake = Fake()
        val sync = make(fake)
        sync.levelChanged()
        runCurrent()
        sync.stop()
        advanceTimeBy(BrightnessSync.HEARTBEAT)
        runCurrent()
        assertEquals(0, fake.reports.size)
    }

    @Test
    fun heartbeatReportsEveryIntervalUntilCancelled() = runTest {
        val fake = Fake()
        val sync = make(fake)
        val job = launch { sync.run() }
        runCurrent()
        assertEquals(1, fake.reports.size)
        advanceTimeBy(BrightnessSync.HEARTBEAT)
        runCurrent()
        assertEquals(2, fake.reports.size)
        assertEquals(BrightnessSync.HEARTBEAT, delays.last())
        job.cancel()
        job.join()
        advanceTimeBy(BrightnessSync.HEARTBEAT * 3)
        runCurrent()
        assertEquals(2, fake.reports.size)
    }

    @Test
    fun a401FeedsTheUnauthorizedPath() = runTest {
        val fake = Fake()
        fake.answer = ReportOutcome.UNAUTHORIZED
        var called = 0
        val sync = make(fake, unauthorized = { called += 1 })
        sync.receive(30.0, 1)?.join()
        assertEquals(1, called)
    }

    @Test
    fun a401OnAHeartbeatFeedsTheUnauthorizedPath() = runTest {
        val fake = Fake()
        fake.answer = ReportOutcome.UNAUTHORIZED
        var called = 0
        val sync = make(fake, unauthorized = { called += 1 })
        val job = launch { sync.run() }
        runCurrent()
        assertEquals(1, called)
        job.cancel()
    }

    @Test
    fun otherFailuresAreSilent() = runTest {
        val fake = Fake()
        fake.answer = ReportOutcome.FAILED
        var called = 0
        val sync = make(fake, unauthorized = { called += 1 })
        sync.receive(30.0, 1)?.join()
        assertEquals(0, called)
    }

    @Test
    fun stopCancelsAReportInFlight() = runTest {
        val started = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val sync = BrightnessSync(
            scope = backgroundScope, read = { 0.5 }, write = {}, unauthorized = {},
            send = { _, _ ->
                started.complete(Unit)
                try {
                    awaitCancellation()
                } catch (e: CancellationException) {
                    cancelled.complete(Unit)
                    throw e
                }
            },
        )
        sync.receive(30.0, 1)
        started.await()
        sync.stop()
        cancelled.await()
    }
}

/**
 * `AndroidBrightness` driving a [BrightnessSync], as the app wires them: the window override over
 * a system level it only reads. No Swift counterpart: the iPad's screen has one level.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AndroidBrightnessTest {
    private class Screen {
        var system = 128
        val window = mutableListOf<Float>()
    }

    private fun TestScope.wire(screen: Screen, reports: MutableList<Pair<Int, Int?>>): Pair<AndroidBrightness, BrightnessSync> {
        val brightness = AndroidBrightness(applyWindow = { screen.window += it }, systemLevel = { screen.system })
        val sync = BrightnessSync(
            scope = backgroundScope, read = brightness::read, write = brightness::write, unauthorized = {},
            send = { level, applied -> reports += BrightnessReporter.value(level) to applied; ReportOutcome.SENT },
        )
        return brightness to sync
    }

    @Test
    fun aNewSeqSetsTheOverrideAndReportsItApplied() = runTest {
        val screen = Screen()
        val reports = mutableListOf<Pair<Int, Int?>>()
        val (brightness, sync) = wire(screen, reports)
        sync.receive(30.0, 4)?.join()
        assertEquals(listOf(0.3f), screen.window)
        assertEquals(0.3, brightness.override!!, 1e-9)
        assertEquals(listOf(30 to 4), reports)
    }

    @Test
    fun aSystemChangeDropsTheOverrideAndReportsTheSystemLevel() = runTest {
        val screen = Screen()
        val reports = mutableListOf<Pair<Int, Int?>>()
        val (brightness, sync) = wire(screen, reports)
        sync.receive(30.0, 4)?.join()
        screen.system = 204 // the user's slider: 204 / 255 = 80 %
        brightness.systemChanged()
        sync.levelChanged()
        advanceTimeBy(BrightnessSync.DEBOUNCE)
        runCurrent()
        assertEquals(AndroidBrightness.OVERRIDE_NONE, screen.window.last())
        assertNull(brightness.override)
        assertEquals(listOf(30 to 4, 80 to null), reports)
    }

    @Test
    fun withoutAnOverrideTheSystemLevelIsReported() = runTest {
        val screen = Screen()
        val reports = mutableListOf<Pair<Int, Int?>>()
        val (_, sync) = wire(screen, reports)
        val job = launch { sync.run() }
        runCurrent()
        job.cancel()
        assertEquals(listOf(50 to null), reports) // 128 / 255
    }

    @Test
    fun theSystemLevelMapsFrom0To255() {
        assertEquals(0.0, AndroidBrightness.systemToLevel(0), 0.0)
        assertEquals(1.0, AndroidBrightness.systemToLevel(255), 0.0)
        assertEquals(1.0, AndroidBrightness.systemToLevel(4095), 0.0)
        assertEquals(0.0, AndroidBrightness.systemToLevel(-3), 0.0)
        assertEquals(100, BrightnessReporter.value(AndroidBrightness.systemToLevel(255)))
    }

    @Test
    fun theSameSeqAfterASystemChangeLeavesTheUsersLevel() = runTest {
        val screen = Screen()
        val reports = mutableListOf<Pair<Int, Int?>>()
        val (brightness, sync) = wire(screen, reports)
        sync.receive(30.0, 4)?.join()
        brightness.systemChanged()
        assertNull(sync.receive(30.0, 4))
        assertEquals(AndroidBrightness.OVERRIDE_NONE, screen.window.last())
        assertNull(brightness.override)
    }

    @Test
    fun reapplyRestoresTheOverrideOnANewWindowOnly() {
        val screen = Screen()
        val brightness = AndroidBrightness(applyWindow = { screen.window += it }, systemLevel = { screen.system })
        brightness.reapply()
        assertTrue(screen.window.isEmpty())
        brightness.write(0.6)
        brightness.reapply()
        assertEquals(listOf(0.6f, 0.6f), screen.window)
    }
}
