package app.fremkit.kit

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/** Records each pairing request and answers from a script. */
class ScriptedPairer(private var answer: Result<PairedMac>) {
    private val sent = Recorder<PairAttempt>()

    val attempts: List<PairAttempt> get() = sent.items

    fun set(answer: Result<PairedMac>) = synchronized(this) { this.answer = answer }

    fun pair(attempt: PairAttempt): PairedMac {
        sent.add(attempt)
        return synchronized(this) { answer }.getOrThrow()
    }
}

private val linkURL = "fremkit://pair?h=studio.local&a=192.0.2.10&p=4243&c=abcd-efgh&k=${SpkiFixture.keyHash}"
private const val otherKey = "Y4nRTFWKfvKwllWID7DQPMgZIF8SqUUvgWkQZsK_ArQ"
private const val linkSecret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
private val secretLinkURL = "fremkit://pair?h=studio.local&a=192.0.2.10&p=4243&c=abcd-efgh&s=$linkSecret&k=${SpkiFixture.keyHash}"
private val paired = PairedMac(
    host = "studio.local", address = "192.0.2.10", port = 4243, keyHash = SpkiFixture.keyHash,
    token = "t", deviceId = "d1", name = "studio",
)

/**
 * `PairingFlowTests`, on `kotlinx-coroutines-test`. Where the iPad pairs at once with any link
 * while unpaired, Android does so only with a scanned one: a link from an intent always asks.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PairingFlowTest {
    private val service = MacService(name = "Studio", address = "192.0.2.10", port = 4243)
    private val link = PairingLink.parse(linkURL)!!

    private fun TestScope.makeFlow(
        store: CredentialStore = MemoryCredentialStore(),
        prober: ScriptedProber = ScriptedProber(emptyMap()),
        pairer: ScriptedPairer = ScriptedPairer(Result.success(paired)),
        key: String? = otherKey,
        viewport: suspend () -> Viewport = { Viewport(1408, 950) },
        readKey: (suspend (String, Int) -> String?)? = null,
    ): Pair<PairingFlow, AppModel> {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val model = AppModel(store, Connector(prober), dispatcher = dispatcher)
        model.start()
        val flow = PairingFlow(
            model, dispatcher, deviceName = { "Studio tablet" }, viewport = viewport,
            pair = { pairer.pair(it) }, readKey = readKey ?: { _, _ -> key },
        )
        return flow to model
    }

    /** The camera reads [url]. */
    private fun PairingFlow.scanLink(url: String = linkURL): Boolean {
        scan()
        return scanned(url)
    }

    // Viewport

    @Test
    fun theViewportIsTheMeasuredRegionRounded() {
        assertEquals(Viewport(1408, 950), MeasuredSize(1408.0, 950.0).toViewport())
        assertEquals(Viewport(1408, 949), MeasuredSize(1407.5, 949.4).toViewport())
        assertEquals("portrait stays portrait", Viewport(950, 1408), MeasuredSize(950.0, 1408.0).toViewport())
        assertEquals(Viewport(1, 1), MeasuredSize.ZERO.toViewport())
        assertEquals(Viewport(1, 1), MeasuredSize(Double.POSITIVE_INFINITY, Double.NaN).toViewport())
        assertEquals(Viewport(10000, 720), MeasuredSize(20000.0, 720.0).toViewport())
    }

    // Links

    @Test
    fun aScannedLinkWhileNotPairedPairsRightAway() = runTest {
        val pairer = ScriptedPairer(Result.success(paired))
        val (flow, model) = makeFlow(pairer = pairer)
        assertTrue(flow.scanLink())
        assertNull(flow.pendingLink)
        assertTrue(flow.isWorking)
        flow.inFlight?.join()
        val attempt = pairer.attempts.first()
        assertEquals("the name first, then the address", listOf("studio.local", "192.0.2.10"), attempt.hosts)
        assertEquals(SpkiFixture.keyHash, attempt.keyHash)
        assertEquals("ABCDEFGH", attempt.code)
        assertNull("a link without a secret pairs with the code", attempt.secret)
        assertEquals("Studio tablet", attempt.name)
        assertEquals(Viewport(1408, 950), attempt.viewport)
        assertEquals("studio", attempt.macName)
        assertEquals(PairingStep.Idle, flow.step)
        assertEquals(paired, model.mac.value)
    }

    @Test
    fun anIntentLinkWhileUnpairedAsks() = runTest {
        val pairer = ScriptedPairer(Result.success(paired))
        val (flow, model) = makeFlow(pairer = pairer)
        assertTrue(flow.handle(linkURL))
        assertEquals(link, flow.pendingLink)
        assertEquals("nothing happens before the user agrees", PairingStep.Idle, flow.step)
        runCurrent()
        assertTrue(pairer.attempts.isEmpty())

        // Another app picked the Mac: the user says no, and nothing is paired.
        flow.declineLink()
        assertNull(flow.pendingLink)
        runCurrent()
        assertTrue(pairer.attempts.isEmpty())
        assertNull(model.mac.value)

        flow.handle(linkURL, LinkSource.INTENT)
        flow.confirmLink()
        assertNull(flow.pendingLink)
        flow.inFlight?.join()
        assertEquals(1, pairer.attempts.size)
        assertEquals(paired, model.mac.value)
    }

    @Test
    fun anIntentLinkWhileScanningStopsTheCamera() = runTest {
        val (flow, _) = makeFlow()
        flow.scan()
        assertTrue(flow.handle(linkURL))
        assertEquals(PairingStep.Idle, flow.step)
        assertNotNull(flow.pendingLink)
    }

    @Test
    fun aLinkWithASecretSendsIt() = runTest {
        val pairer = ScriptedPairer(Result.success(paired))
        val (flow, _) = makeFlow(pairer = pairer)
        assertTrue(flow.scanLink(secretLinkURL))
        flow.inFlight?.join()
        val attempt = pairer.attempts.first()
        assertEquals(linkSecret, attempt.secret)
        assertEquals("the pin is checked as before", SpkiFixture.keyHash, attempt.keyHash)
    }

    @Test
    fun aLinkWhilePairedAsksFirst() = runTest {
        val pairer = ScriptedPairer(Result.success(paired))
        val (flow, model) = makeFlow(store = MemoryCredentialStore(sampleMac),
            prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo))), pairer = pairer)
        model.reconnect().join()
        assertTrue(flow.scanLink())
        assertNotNull(flow.pendingLink)
        assertEquals("nothing happens before the user agrees", PairingStep.Idle, flow.step)
        assertTrue(pairer.attempts.isEmpty())

        flow.declineLink()
        assertNull(flow.pendingLink)
        assertEquals(sampleMac, model.mac.value)

        flow.handle(linkURL)
        flow.confirmLink()
        assertNull(flow.pendingLink)
        flow.inFlight?.join()
        assertEquals(1, pairer.attempts.size)
        assertEquals(paired, model.mac.value)
    }

    @Test
    fun aScannedLinkAfterTheMacRemovedThisTabletDoesNotAsk() = runTest {
        val (flow, model) = makeFlow(store = MemoryCredentialStore(sampleMac),
            prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Unauthorized)))
        model.reconnect().join()
        assertEquals(AppState.Unauthorized, model.state.value)
        flow.scanLink()
        assertNull(flow.pendingLink)
        assertEquals(PairingStep.Link(link), flow.step)
    }

    @Test
    fun anInvalidLinkIsIgnored() = runTest {
        val (flow, _) = makeFlow()
        assertFalse(flow.handle("fremkit://pair?h=studio.local&a=192.0.2.10&p=4243&c=ABCDEFGH"))
        assertEquals(PairingStep.Idle, flow.step)
        assertNull(flow.pendingLink)
    }

    @Test
    fun theFirstValidScanStopsTheScan() = runTest {
        val pairer = ScriptedPairer(Result.success(paired))
        val (flow, _) = makeFlow(pairer = pairer)
        assertFalse("not scanning", flow.scanned(linkURL))
        flow.scan()
        assertFalse(flow.scanned("https://example.com/"))
        assertFalse(flow.scanned("fremkit://pair?h=studio.local"))
        assertEquals(PairingStep.Scanning, flow.step)
        assertTrue(flow.scanned(linkURL))
        assertEquals(PairingStep.Link(link), flow.step)
        assertFalse("a second read of the same code does nothing", flow.scanned(linkURL))
        flow.inFlight?.join()
        assertEquals(1, pairer.attempts.size)
    }

    @Test
    fun errorsStayOnTheLinkScreen() = runTest {
        val cases = listOf(
            PairError.Rejected("Code expiré") to PairingProblem.Refused("Code expiré"),
            PairError.Limited("Trop d’essais") to PairingProblem.Refused("Trop d’essais"),
            PairError.Unreachable to PairingProblem.Unreachable,
            PairError.WrongMac to PairingProblem.WrongMac,
            PairError.InvalidRequest to PairingProblem.InvalidRequest,
            PairError.NoCode to PairingProblem.NoCode,
        )
        for ((error, problem) in cases) {
            val (flow, model) = makeFlow(pairer = ScriptedPairer(Result.failure(error)))
            flow.scanLink()
            flow.inFlight?.join()
            assertEquals(problem, flow.problem)
            assertEquals(PairingStep.Link(link), flow.step)
            assertFalse(flow.isWorking)
            assertNull(model.mac.value)
        }
    }

    @Test
    fun anUnexpectedFailureIsUnreachable() = runTest {
        val (flow, _) = makeFlow(pairer = ScriptedPairer(Result.failure(IllegalStateException("boom"))))
        flow.scanLink()
        flow.inFlight?.join()
        assertEquals(PairingProblem.Unreachable, flow.problem)
    }

    @Test
    fun retryClearsTheProblemAndPairs() = runTest {
        val pairer = ScriptedPairer(Result.failure(PairError.Unreachable))
        val (flow, model) = makeFlow(pairer = pairer)
        flow.scanLink()
        flow.inFlight?.join()
        assertEquals(PairingProblem.Unreachable, flow.problem)
        pairer.set(Result.success(paired))
        val job = flow.retry()
        assertNull(flow.problem)
        job?.join()
        assertEquals(paired, model.mac.value)
        assertEquals(PairingStep.Idle, flow.step)
    }

    @Test
    fun aPairingTheStoreRefusesIsAProblem() = runTest {
        val (flow, model) = makeFlow(store = UnreadableStore())
        flow.scanLink()
        flow.inFlight?.join()
        assertEquals(PairingProblem.NotSaved, flow.problem)
        assertNull(model.mac.value)
    }

    @Test
    fun cancelDropsALateAnswer() = runTest {
        val (flow, model) = makeFlow()
        flow.scanLink()
        val job = flow.inFlight
        flow.cancel()
        job?.join()
        assertEquals(PairingStep.Idle, flow.step)
        assertNull("the answer came for a step the user left", model.mac.value)
    }

    // Manual path

    @Test
    fun manualPathShowsTheWordsThenPairsWithTheObservedKey() = runTest {
        val pairer = ScriptedPairer(Result.success(paired))
        val (flow, model) = makeFlow(pairer = pairer)
        flow.enterCode()
        assertEquals(PairingStep.ManualList, flow.step)
        flow.choose(service).join()
        assertEquals(PairingStep.ManualCode(service, otherKey), flow.step)
        assertEquals(Fingerprint.words(otherKey), flow.words)
        assertEquals(4, flow.words.size)

        assertNull("not 8 characters", flow.submit("ABC"))
        assertNull("0 is not in the alphabet", flow.submit("ABCDEFG0"))
        flow.submit("abcd efgh")?.join()
        val attempt = pairer.attempts.first()
        assertEquals("the resolved address: the .local name may not resolve", listOf("192.0.2.10"), attempt.hosts)
        assertEquals("the key the user compared is the pin", otherKey, attempt.keyHash)
        assertEquals("ABCDEFGH", attempt.code)
        assertNull("the manual path has only the code", attempt.secret)
        assertEquals("the service name is the Mac's name", "Studio", attempt.macName)
        assertEquals(paired, model.mac.value)
        assertEquals(PairingStep.Idle, flow.step)
    }

    @Test
    fun manualPathBackToTheListWhenTheMacDoesNotAnswer() = runTest {
        val (flow, _) = makeFlow(key = null)
        flow.enterCode()
        flow.choose(service).join()
        assertEquals(PairingStep.ManualList, flow.step)
        assertEquals(PairingProblem.Unreachable, flow.problem)
    }

    @Test
    fun manualPathRefusedCodeStaysOnTheWords() = runTest {
        val (flow, _) = makeFlow(pairer = ScriptedPairer(Result.failure(PairError.Rejected("Code incorrect"))))
        flow.enterCode()
        flow.choose(service).join()
        flow.submit("ABCDEFGH")?.join()
        assertEquals(PairingStep.ManualCode(service, otherKey), flow.step)
        assertEquals(PairingProblem.Refused("Code incorrect"), flow.problem)
    }

    @Test
    fun aTypedAddressTakesThePathOfAPickedMac() = runTest {
        val pairer = ScriptedPairer(Result.success(paired))
        val read = mutableListOf<Pair<String, Int>>()
        val (flow, model) = makeFlow(pairer = pairer, readKey = { host, port ->
            read += host to port
            otherKey
        })
        flow.enterCode()
        flow.typeAddress()
        assertEquals(PairingStep.ManualAddress(), flow.step)

        flow.connect(" https://Studio.local:4300/ ")!!.join()
        assertEquals("the key of whatever answers there is read", listOf("studio.local" to 4300), read)
        val typed = MacService(name = "studio.local", address = "studio.local", port = 4300)
        assertEquals(PairingStep.ManualCode(typed, otherKey), flow.step)
        assertEquals("its words are compared, as for a Mac from the list", Fingerprint.words(otherKey), flow.words)

        flow.submit("abcd efgh")?.join()
        val attempt = pairer.attempts.single()
        assertEquals(listOf("studio.local"), attempt.hosts)
        assertEquals(4300, attempt.port)
        assertEquals("the key the user compared is the pin", otherKey, attempt.keyHash)
        assertNull("the code alone, sent as a proof under that key", attempt.secret)
        assertEquals(paired, model.mac.value)
        assertEquals(PairingStep.Idle, flow.step)
    }

    @Test
    fun aTypedAddressThatIsNotOneIsRefusedWithoutAnyRequest() = runTest {
        var reads = 0
        val (flow, _) = makeFlow(readKey = { _, _ ->
            reads += 1
            otherKey
        })
        flow.enterCode()
        assertNull("only from the address step", flow.connect("192.0.2.10"))
        flow.typeAddress()
        for (text in listOf("", "studio", "studio.local/admin", "user@192.0.2.10", "[2001:db8::1]:4243", "192.0.2.10:0")) {
            assertNull(text, flow.connect(text))
        }
        runCurrent()
        assertEquals(0, reads)
        assertEquals(PairingStep.ManualAddress(), flow.step)
    }

    @Test
    fun aTypedAddressThatDoesNotAnswerComesBackToBeCorrected() = runTest {
        val (flow, _) = makeFlow(key = null)
        flow.typeAddress()
        flow.connect(" 192.0.2.10 ")!!.join()
        assertEquals(PairingStep.ManualAddress("192.0.2.10"), flow.step)
        assertEquals(PairingProblem.Unreachable, flow.problem)
        assertFalse(flow.isWorking)
    }

    @Test
    fun anAttemptNeverPrintsTheCodeOrThePin() = runTest {
        val attempt = PairAttempt(listOf("192.0.2.10"), 4243, otherKey, "ABCDEFGH", linkSecret, "tablet", Viewport(1, 1), "Studio")
        val (flow, _) = makeFlow()
        flow.enterCode()
        flow.choose(service).join()
        val manual = flow.state.value
        flow.handle(secretLinkURL)
        val pending = flow.state.value
        for (text in listOf(attempt.toString(), "$attempt", manual.toString(), pending.toString(), PairingStep.Link(link).toString())) {
            assertFalse(text, text.contains("ABCDEFGH"))
            assertFalse(text, text.contains(otherKey))
            assertFalse(text, text.contains(SpkiFixture.keyHash))
            assertFalse(text, text.contains(linkSecret))
        }
    }

    @Test
    fun aScanThatMustBeConfirmedStopsTheCamera() = runTest {
        val pairer = ScriptedPairer(Result.success(paired))
        val (flow, model) = makeFlow(store = MemoryCredentialStore(sampleMac),
            prober = ScriptedProber(mapOf("studio.local" to ProbeOutcome.Ok(sampleInfo))), pairer = pairer)
        model.reconnect().join()
        flow.scan()
        assertTrue(flow.scanned(linkURL))
        assertNotNull(flow.pendingLink)
        assertEquals("the camera is off while the question is up", PairingStep.Idle, flow.step)
        flow.declineLink()
        assertFalse("the same code in view does not ask again", flow.scanned(linkURL))
        assertNull(flow.pendingLink)
        runCurrent()
        assertTrue(pairer.attempts.isEmpty())
    }

    @Test
    fun cancellingWhileTheKeyIsReadDropsTheLateAnswer() = runTest {
        val (flow, _) = makeFlow(readKey = { _, _ ->
            delay(50.milliseconds)
            otherKey
        })
        flow.enterCode()
        val reading = flow.choose(service)
        flow.cancel()
        reading.join()
        assertEquals(PairingStep.Idle, flow.step)
        assertFalse(flow.isWorking)

        flow.enterCode()
        val again = flow.choose(service)
        flow.enterCode()
        again.join()
        advanceTimeBy(100.milliseconds)
        runCurrent()
        assertEquals("back to the list: the key read for the left step is dropped", PairingStep.ManualList, flow.step)
    }

    @Test
    fun pairingWaitsForTheViewport() = runTest {
        val pairer = ScriptedPairer(Result.success(paired))
        val meter = ViewportMeter(settle = Duration.ZERO, cap = Duration.ZERO, timeSource = testScheduler.timeSource)
        val (flow, _) = makeFlow(pairer = pairer, viewport = { meter.viewport() })
        flow.scanLink()
        val job = flow.inFlight
        runCurrent()
        assertTrue("nothing is sent before the screen is measured", pairer.attempts.isEmpty())
        meter.measured(MeasuredSize(1408.0, 950.0))
        job?.join()
        assertEquals(Viewport(1408, 950), pairer.attempts.first().viewport)
    }
}

/** `ViewportMeterTests`, on virtual time. */
@OptIn(ExperimentalCoroutinesApi::class)
class ViewportMeterTest {
    private fun TestScope.meter(settle: Duration, cap: Duration) =
        ViewportMeter(settle = settle, cap = cap, timeSource = testScheduler.timeSource)

    @Test
    fun waitsForTheFirstMeasure() = runTest {
        val meter = meter(Duration.ZERO, Duration.ZERO)
        val waiting = async { meter.viewport() }
        runCurrent()
        assertFalse(waiting.isCompleted)
        meter.measured(MeasuredSize(1408.0, 950.0))
        assertEquals(Viewport(1408, 950), waiting.await())
    }

    @Test
    fun reportsTheMeasureOnceItHoldsStill() = runTest {
        val meter = meter(100.milliseconds, 5.seconds)
        meter.measured(MeasuredSize(950.0, 1408.0))
        val waiting = async { meter.viewport() }
        advanceTimeBy(30.milliseconds)
        meter.measured(MeasuredSize(1408.0, 950.0))
        assertEquals("the size after the rotation, not before", Viewport(1408, 950), waiting.await())
        assertTrue("it waited for the new size to hold still", testScheduler.currentTime >= 130)
    }

    @Test
    fun aCancelledWaitEnds() = runTest {
        val meter = meter(Duration.ZERO, Duration.ZERO)
        val waiting = async { meter.viewport() }
        runCurrent()
        waiting.cancel()
        runCurrent()
        assertTrue(waiting.isCancelled)
        // A later measure finds no one left waiting.
        meter.measured(MeasuredSize(1408.0, 950.0))
        assertEquals(MeasuredSize(1408.0, 950.0), meter.size)
    }

    @Test
    fun givesUpWaitingAfterTheCapWithTheLatestMeasure() = runTest {
        val meter = meter(60.seconds, 50.milliseconds)
        meter.measured(MeasuredSize(1408.0, 950.0))
        assertEquals(Viewport(1408, 950), meter.viewport())
        assertTrue("the cap, not the settle", testScheduler.currentTime < 1000)
    }
}
