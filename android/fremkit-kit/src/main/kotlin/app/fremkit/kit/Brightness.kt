package app.fremkit.kit

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/**
 * Which targets from the Mac the app has applied. The Mac bumps `seq` for each new target and
 * restarts it at 0 with the server, so a target is applied when its `seq` differs from the last
 * one applied (not when it is greater). A level the user sets with the system slider is
 * therefore reported, not overwritten at every push.
 */
class BrightnessState(lastApplied: Int? = null) {
    var lastApplied: Int? = lastApplied
        private set

    /**
     * True when [seq] is new and the caller should set the screen to [target]; records it.
     *
     * Edge case (R5): if the server restarts and its first `seq` is 0 while 0 was the last
     * applied, that one target is skipped; the next `seq` applies.
     */
    fun apply(target: Double, seq: Int): Boolean {
        if (!target.isFinite() || seq == lastApplied) return false
        lastApplied = seq
        return true
    }

    companion object {
        /** [target] (0–100) as a screen level (0–1). */
        fun level(forTarget: Double): Double {
            if (!forTarget.isFinite()) return 0.0
            return (forTarget / 100).coerceIn(0.0, 1.0)
        }
    }
}

/** How a brightness report ended. */
enum class ReportOutcome {
    SENT,

    /** The Mac does not know this tablet any more. */
    UNAUTHORIZED,

    /** Anything else: the next heartbeat retries. */
    FAILED,
    ;

    companion object {
        /**
         * The outcome of an answer: its HTTP status, or null for a pin refusal or a network
         * failure. Only a 401 is told apart; a 409 (no device screen) is [FAILED].
         */
        fun of(status: Int?): ReportOutcome = when {
            status == null -> FAILED
            status in 200..299 -> SENT
            status == 401 -> UNAUTHORIZED
            else -> FAILED
        }
    }
}

/**
 * `POST /api/devices/me/brightness`, ready to send under the pin: [url], [headers] and [body],
 * and the pin to send it under ([keyHash] for [pinnedHosts]). [toString] shows neither the
 * device token (in the `Cookie` header) nor the pin.
 */
class BrightnessRequest internal constructor(
    val url: String,
    val headers: Map<String, String>,
    val body: String,
    val keyHash: String,
    val pinnedHosts: Set<String>,
) {
    val method: String get() = "POST"

    override fun toString(): String = "BrightnessRequest($method $url)"
}

/**
 * Builds `POST /api/devices/me/brightness { value, applied? }`: the level the tablet's screen is
 * at, and the last `seq` the app applied (so the Mac knows its target landed). Sending it, under
 * the pin, is the caller's job: [send] takes the transport as a function of the request.
 */
class BrightnessReporter(val mac: PairedMac, /** The candidate the app is connected through. */ val host: String) {
    fun request(brightness: Double, applied: Int?): BrightnessRequest {
        val body = buildJsonObject {
            put("value", value(brightness))
            if (applied != null) put("applied", applied)
        }
        return BrightnessRequest(
            url = Dashboard.resource(host, mac.port, "/api/devices/me/brightness"),
            headers = mapOf("Cookie" to "${Dashboard.COOKIE_NAME}=${mac.token}", "Content-Type" to "application/json"),
            body = body.toString(),
            keyHash = mac.keyHash,
            pinnedHosts = setOf(host, mac.host, mac.address),
        )
    }

    /**
     * Sends one report through [post], which answers the HTTP status, or null for a pin refusal
     * or a network failure.
     */
    suspend fun send(brightness: Double, applied: Int?, post: suspend (BrightnessRequest) -> Int?): ReportOutcome =
        ReportOutcome.of(post(request(brightness, applied)))

    override fun toString(): String = "BrightnessReporter($host)"

    companion object {
        /** A screen level (0–1) as the server's 0–100 integer, half rounded up. */
        fun value(brightness: Double): Int {
            if (!brightness.isFinite()) return 0
            return Math.round(brightness * 100).coerceIn(0L, 100L).toInt()
        }
    }
}

/**
 * Applies the Mac's brightness target and reports the screen's level: on a new target, shortly
 * after the level changes (the user's slider), and every [interval] while [run] is running, which
 * is what keeps the Mac from marking the device as gone. The screen and the network are
 * functions, so it is tested with neither.
 *
 * Every method is called on [scope]'s thread (the main thread in the app), and every job it
 * starts runs there: that is what keeps its state consistent without a lock.
 *
 * @param read the screen's brightness, 0–1.
 * @param write sets the screen's brightness, 0–1.
 * @param send reports a brightness (0–1) and the `seq` applied, if any.
 * @param unauthorized called when a report is answered 401.
 */
class BrightnessSync(
    private val scope: CoroutineScope,
    private val read: () -> Double,
    private val write: (Double) -> Unit,
    private val send: suspend (Double, Int?) -> ReportOutcome,
    private val unauthorized: () -> Unit,
    private val debounce: Duration = DEBOUNCE,
    private val interval: Duration = HEARTBEAT,
    private val delay: suspend (Duration) -> Unit = { kotlinx.coroutines.delay(it) },
) {
    private var state = BrightnessState()

    /** The `seq` the Mac has not yet been told about: sent with each report until one succeeds. */
    private var unreportedApplied: Int? = null
    private var debounced: Job? = null

    /** Reports on their way, cancelled by [stop]. */
    private val inFlight = mutableSetOf<Job>()

    /** For tests: the last `seq` applied. */
    val lastApplied: Int? get() = state.lastApplied

    /** A `brightness` message from the page. Applies it when its `seq` is new, then reports. */
    fun receive(target: Double, seq: Int): Job? {
        if (!state.apply(target, seq)) return null
        write(BrightnessState.level(target))
        unreportedApplied = seq
        return report()
    }

    /** The screen's brightness changed: reports once it has stopped changing. */
    fun levelChanged() {
        debounced?.cancel()
        debounced = scope.launch {
            delay(debounce)
            report().join()
        }
    }

    /**
     * Reports now, and then every [interval], until the calling coroutine is cancelled. Run it
     * while the dashboard is shown and the app started.
     */
    suspend fun run() {
        while (currentCoroutineContext().isActive) {
            report().join()
            delay(interval)
        }
    }

    /**
     * Drops a pending debounced report and cancels the ones in flight (the dashboard went away or
     * the app was stopped).
     */
    fun stop() {
        debounced?.cancel()
        debounced = null
        inFlight.toList().forEach { it.cancel() }
        inFlight.clear()
    }

    /** Forgets what was applied and reported: for a new pairing, whose Mac numbers its targets on its own. */
    fun reset() {
        stop()
        state = BrightnessState()
        unreportedApplied = null
    }

    private fun report(): Job {
        val level = read()
        val applied = unreportedApplied
        // Started once recorded, so an immediate dispatcher cannot finish it before it is.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            val outcome = try {
                send(level, applied)
            } finally {
                inFlight.remove(coroutineContext.job)
            }
            if (!isActive) return@launch
            when (outcome) {
                ReportOutcome.SENT -> if (applied != null && unreportedApplied == applied) unreportedApplied = null
                ReportOutcome.UNAUTHORIZED -> unauthorized()
                ReportOutcome.FAILED -> Unit
            }
        }
        inFlight.add(job)
        job.start()
        return job
    }

    companion object {
        val DEBOUNCE: Duration = 500.milliseconds
        val HEARTBEAT: Duration = 10.seconds
    }
}

/**
 * The tablet's half of brightness, without Android types: the window override the app sets
 * (`WindowManager.LayoutParams.screenBrightness`, 0–1, or [OVERRIDE_NONE]) over the system level
 * it only ever reads (`Settings.System.SCREEN_BRIGHTNESS`, 0–255). Its [read] and [write] are
 * what [BrightnessSync] is given.
 *
 * - A new target is written as the window override.
 * - The user moving the system slider ([systemChanged]) drops the override, so their level is
 *   what the screen shows and what the next report sends: the iPad's "a level set in Control
 *   Center is reported, not overwritten". With an override in place the slider would do nothing
 *   visible.
 * - The level reported is the override when there is one, else the system level mapped to 0–1.
 *   With automatic brightness on, that is the last manual level; the report says so rather than
 *   guessing the sensor's.
 *
 * @param applyWindow sets the window's brightness attribute: a level, or [OVERRIDE_NONE].
 * @param systemLevel the system level, 0–255.
 */
class AndroidBrightness(
    private val applyWindow: (Float) -> Unit,
    private val systemLevel: () -> Int,
) {
    /** The window override in place, 0–1, or null when the system level shows. */
    var override: Double? = null
        private set

    /** The level to report, 0–1. */
    fun read(): Double = override ?: systemToLevel(systemLevel())

    /** Sets the window override to [level] (0–1, clamped). */
    fun write(level: Double) {
        val clamped = if (level.isFinite()) level.coerceIn(0.0, 1.0) else 0.0
        override = clamped
        applyWindow(clamped.toFloat())
    }

    /**
     * The system level or mode changed (the user's slider): drops the override. The caller then
     * tells [BrightnessSync.levelChanged], which reports the system level.
     */
    fun systemChanged() {
        override = null
        applyWindow(OVERRIDE_NONE)
    }

    /**
     * Re-applies the override in place, if any, to a window that lost it (a new activity).
     * Nothing to do without one: a fresh window has none.
     */
    fun reapply() {
        override?.let { applyWindow(it.toFloat()) }
    }

    companion object {
        /** `WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE`. */
        const val OVERRIDE_NONE = -1f

        /** A system level, 0–255, as a screen level, 0–1. */
        fun systemToLevel(raw: Int): Double = raw.coerceIn(0, 255) / 255.0
    }
}
