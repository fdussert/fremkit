package app.fremkit.kit

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeSource

/**
 * A size the app measured, in dp: in the dashboard's WebView (`width=device-width`, text zoom
 * 100 %) a CSS pixel is a dp, so this is what the page will see.
 */
data class MeasuredSize(val width: Double, val height: Double) {
    /**
     * The size to report when pairing: each side rounded to the nearest dp (half away from zero),
     * within the server's bounds, 1 for a side that is not a number.
     */
    fun toViewport(): Viewport {
        fun side(value: Double): Int = if (!value.isFinite()) 1 else Math.round(value).coerceIn(1L, 10000L).toInt()
        return Viewport(side(width), side(height))
    }

    companion object {
        val ZERO = MeasuredSize(0.0, 0.0)
    }
}

/**
 * The region the dashboard is laid out in, as the app measures it on its container after
 * immersive mode is applied, and the wait for a measure worth reporting. Pairing never reports a
 * computed guess: it waits for the first measure, then for it to hold still for [settle] (a cold
 * launch from a link may lay out once before the window takes its final orientation), and after
 * at most [cap] reports the latest measure as it is.
 *
 * Called on the main thread, as the app measures there.
 */
class ViewportMeter(
    private val settle: Duration = 300.milliseconds,
    private val cap: Duration = 1.seconds,
    /** The clock [settle] and [cap] are read on; a test's virtual one in tests. */
    private val timeSource: TimeSource = TimeSource.Monotonic,
    private val delay: suspend (Duration) -> Unit = { kotlinx.coroutines.delay(it) },
) {
    private val measures = MutableStateFlow<MeasuredSize?>(null)
    private var changedAt = timeSource.markNow()

    /** The last measure, null before the first. */
    val size: MeasuredSize? get() = measures.value

    /** A new size of the container. */
    fun measured(size: MeasuredSize) {
        if (size == measures.value) return
        changedAt = timeSource.markNow()
        measures.value = size
    }

    /**
     * The size to report: waits for the first measure, then for it to settle (see above). A
     * cancelled caller stops waiting.
     */
    suspend fun viewport(): Viewport {
        measures.first { it != null }
        val start = timeSource.markNow()
        while (currentCoroutineContext().isActive && changedAt.elapsedNow() < settle && start.elapsedNow() < cap) {
            delay(POLL)
        }
        return (measures.value ?: MeasuredSize.ZERO).toViewport()
    }

    private companion object {
        val POLL = 20.milliseconds
    }
}

/**
 * Where pairing is, from the welcome screen's two buttons (or a `fremkit://pair` link) to a
 * stored pairing.
 */
sealed interface PairingStep {
    /** Nothing in progress: the app shows whatever [AppModel] says. */
    data object Idle : PairingStep

    /** The camera is looking for the Mac's QR code. */
    data object Scanning : PairingStep

    /** Pairing with a scanned or opened link. */
    data class Link(val link: PairingLink) : PairingStep

    /** The manual path: the Macs NSD found, by name. */
    data object ManualList : PairingStep

    /** The manual path: reading the key of the Mac the user picked. */
    data class ManualKey(val service: MacService) : PairingStep

    /** The manual path: the key's words are shown, the user types the code. */
    data class ManualCode(val service: MacService, val keyHash: String) : PairingStep {
        override fun toString(): String = "ManualCode($service)"
    }
}

/** Why the last step failed, for the line under the button. */
sealed interface PairingProblem {
    /**
     * The Mac refused the code (wrong, expired, or too many tries): its own message, as is. May
     * be empty when the Mac sent none.
     */
    data class Refused(val message: String) : PairingProblem

    /** Nothing answered. */
    data object Unreachable : PairingProblem

    /** Something answered with another key than the code's Mac. */
    data object WrongMac : PairingProblem

    /** The Mac did not accept the request itself (a version mismatch, not the user's doing). */
    data object InvalidRequest : PairingProblem

    /** The Mac shows no live code: a new one has to be made there. */
    data object NoCode : PairingProblem

    /** The Mac paired this tablet but the store refused to keep it. */
    data object NotSaved : PairingProblem
}

/** One `POST /api/pair`, as [PairClient.pair] takes it. Printing it never shows the code, the secret or the pin. */
class PairAttempt(
    val hosts: List<String>,
    val port: Int,
    val keyHash: String,
    val code: String,
    /** The QR link's secret, when it carried one; null on the manual path. */
    val secret: String?,
    val name: String,
    val viewport: Viewport,
    val macName: String,
) {
    override fun equals(other: Any?): Boolean =
        other is PairAttempt && hosts == other.hosts && port == other.port && keyHash == other.keyHash &&
            code == other.code && secret == other.secret && name == other.name && viewport == other.viewport &&
            macName == other.macName

    override fun hashCode(): Int = listOf(hosts, port, keyHash, code, secret, name, viewport, macName).hashCode()

    override fun toString(): String = "PairAttempt($hosts, port $port)"
}

/** Where a `fremkit://pair` link came from, which decides whether it is confirmed first. */
enum class LinkSource {
    /** The app's own scanner: the user just pointed the camera at the Mac. */
    SCANNER,

    /**
     * An intent from another app (a camera app, a browser): any installed app can send one, so
     * the user always confirms the Mac first, paired or not.
     */
    INTENT,
}

/** What the pairing screens show. */
data class PairingState(
    val step: PairingStep = PairingStep.Idle,
    /** True while a request runs: the button is disabled and a spinner shows. */
    val isWorking: Boolean = false,
    /** What went wrong with the last request, shown under the button. */
    val problem: PairingProblem? = null,
    /**
     * A link waiting for the user to confirm its Mac: every link from an intent, and a scanned
     * one while this tablet is paired (it would replace the pairing).
     */
    val pendingLink: PairingLink? = null,
)

/**
 * Pairing from the app: the QR code, a `fremkit://pair` link, or the manual path (a Mac NSD
 * found, its key's four words compared by eye, then the code). On success the pairing goes to
 * [AppModel.pair], which stores it and connects.
 *
 * Every method is called on [dispatcher]'s thread, the one [model] uses, and every job it starts
 * runs there.
 *
 * @param deviceName this tablet's name, shown on the Mac.
 * @param viewport the size to report, awaited just before the request is sent: the app waits
 *   there for its first real measure ([ViewportMeter]).
 */
class PairingFlow(
    private val model: AppModel,
    dispatcher: CoroutineDispatcher,
    private val deviceName: () -> String,
    private val viewport: suspend () -> Viewport,
    private val pair: suspend (PairAttempt) -> PairedMac = { attempt ->
        PairClient().pair(
            hosts = attempt.hosts, port = attempt.port, keyHash = attempt.keyHash, code = attempt.code,
            secret = attempt.secret, name = attempt.name, viewport = attempt.viewport, macName = attempt.macName,
        )
    },
    private val readKey: suspend (host: String, port: Int) -> String? = { host, port -> FirstContact.keyHash(host, port) },
) {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val _state = MutableStateFlow(PairingState())

    val state: StateFlow<PairingState> = _state.asStateFlow()

    val step: PairingStep get() = _state.value.step
    val isWorking: Boolean get() = _state.value.isWorking
    val problem: PairingProblem? get() = _state.value.problem
    val pendingLink: PairingLink? get() = _state.value.pendingLink

    private var running: Job? = null

    /** Bumped by each new step, so a late answer for a step the user left is dropped. */
    private var generation = 0

    /** The request in flight, for tests to wait on. */
    internal val inFlight: Job? get() = running

    /** The four words of the key on screen in the manual path, empty elsewhere. */
    val words: List<String>
        get() = (step as? PairingStep.ManualCode)?.let { Fingerprint.words(it.keyHash) } ?: emptyList()

    /** Opens the camera. */
    fun scan() = move(PairingStep.Scanning)

    /** Starts the manual path. */
    fun enterCode() = move(PairingStep.ManualList)

    /** Back to whatever [AppModel] shows; a request in flight is dropped. */
    fun cancel() {
        update { it.copy(pendingLink = null) }
        move(PairingStep.Idle)
    }

    /**
     * A `fremkit://pair` link. Returns false when it is not a valid one. From an intent it always
     * waits in [pendingLink] for [confirmLink]; from the scanner, only while this tablet has a
     * pairing that still works.
     */
    fun handle(url: String, source: LinkSource = LinkSource.INTENT): Boolean {
        val link = PairingLink.parse(url) ?: return false
        if (source == LinkSource.INTENT || needsConfirmation) {
            // The camera stops while the question is up, so a code still in view cannot ask again
            // once the user has said no.
            if (step == PairingStep.Scanning) move(PairingStep.Idle)
            update { it.copy(pendingLink = link) }
        } else {
            start(link)
        }
        return true
    }

    /**
     * What the camera decoded. Only while scanning, and only a valid pairing link counts: the
     * first one stops the scan. Returns whether it did.
     */
    fun scanned(text: String): Boolean {
        if (step != PairingStep.Scanning || PairingLink.parse(text) == null) return false
        return handle(text, LinkSource.SCANNER)
    }

    /** The user agreed to pair with [pendingLink]'s Mac (replacing the current pairing, if any). */
    fun confirmLink() {
        val link = pendingLink ?: return
        update { it.copy(pendingLink = null) }
        start(link)
    }

    /** The user said no: the link is dropped, the current pairing (if any) kept. */
    fun declineLink() = update { it.copy(pendingLink = null) }

    /** Pairs with the link on screen again, after a failure. */
    fun retry(): Job? {
        val link = (step as? PairingStep.Link)?.link ?: return null
        if (isWorking) return null
        return send(listOf(link.host, link.address), link.port, link.keyHash, link.code, link.secret, link.macName)
    }

    /** The manual path: the user picked a Mac in the list. Reads its key, to show its words. */
    fun choose(service: MacService): Job {
        move(PairingStep.ManualKey(service))
        update { it.copy(isWorking = true) }
        val generation = generation
        return launch {
            val keyHash = readKey(service.address, service.port)
            finishReading(keyHash, service, generation)
        }
    }

    /**
     * The manual path: the user typed the code under the words and pressed **Pair**. The key they
     * compared is the pin from now on. Null when the code is not 8 valid characters.
     */
    fun submit(code: String): Job? {
        val step = step as? PairingStep.ManualCode ?: return null
        if (isWorking) return null
        val normalised = normaliseCode(code) ?: return null
        return send(listOf(step.service.address), step.service.port, step.keyHash, normalised, null, step.service.name)
    }

    /** Stops every job; the flow is not used after this. */
    fun close() = scope.cancel()

    /**
     * Whether a scanned link must be confirmed first: this tablet has a pairing that still works.
     * One the Mac removed, or one the store could not read, is not worth asking about.
     */
    private val needsConfirmation: Boolean
        get() = model.mac.value != null && model.state.value != AppState.Unauthorized

    private fun start(link: PairingLink) {
        move(PairingStep.Link(link))
        retry()
    }

    private fun move(step: PairingStep) {
        generation += 1
        running?.cancel()
        running = null
        update { it.copy(step = step, isWorking = false, problem = null) }
    }

    private fun update(change: (PairingState) -> PairingState) {
        _state.value = change(_state.value)
    }

    /** Starts [block] as the one running job, recorded before it starts (see [AppModel]). */
    private fun launch(block: suspend () -> Unit): Job {
        val job = scope.launch(start = CoroutineStart.LAZY) { block() }
        running = job
        job.start()
        return job
    }

    private fun send(
        hosts: List<String>,
        port: Int,
        keyHash: String,
        code: String,
        secret: String?,
        macName: String,
    ): Job {
        generation += 1
        val generation = generation
        update { it.copy(isWorking = true, problem = null) }
        val name = deviceName()
        return launch {
            val viewport = viewport()
            if (generation != this.generation) return@launch
            val attempt = PairAttempt(hosts, port, keyHash, code, secret, name, viewport, macName)
            val result = try {
                Result.success(pair(attempt))
            } catch (e: CancellationException) {
                throw e
            } catch (e: PairError) {
                Result.failure(e)
            } catch (_: Exception) {
                Result.failure(PairError.Unreachable)
            }
            finishPairing(result, generation)
        }
    }

    private fun finishReading(keyHash: String?, service: MacService, generation: Int) {
        if (generation != this.generation) return
        running = null
        // A key that has no words cannot be compared, and is not a Fremkit Mac's anyway.
        if (keyHash == null || Fingerprint.words(keyHash).isEmpty()) {
            update { it.copy(step = PairingStep.ManualList, isWorking = false, problem = PairingProblem.Unreachable) }
            return
        }
        update { it.copy(step = PairingStep.ManualCode(service, keyHash), isWorking = false) }
    }

    private fun finishPairing(result: Result<PairedMac>, generation: Int) {
        if (generation != this.generation) return
        running = null
        update { it.copy(isWorking = false) }
        result.fold(
            onSuccess = { mac ->
                try {
                    model.pair(mac)
                    move(PairingStep.Idle)
                } catch (_: Exception) {
                    update { it.copy(problem = PairingProblem.NotSaved) }
                }
            },
            onFailure = { error ->
                val problem = when (error) {
                    is PairError.Rejected -> PairingProblem.Refused(error.serverMessage)
                    is PairError.Limited -> PairingProblem.Refused(error.serverMessage)
                    PairError.WrongMac -> PairingProblem.WrongMac
                    PairError.InvalidRequest -> PairingProblem.InvalidRequest
                    PairError.NoCode -> PairingProblem.NoCode
                    else -> PairingProblem.Unreachable
                }
                update { it.copy(problem = problem) }
            },
        )
    }
}
