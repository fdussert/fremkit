package app.fremkit.kit

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** What the app shows. */
sealed interface AppState {
    /** Not paired (or the stored pairing could not be read): scan or type a code. */
    data object Welcome : AppState

    /** Looking for the paired Mac, nothing to show yet. */
    data object Connecting : AppState

    /** The dashboard, served by [host] (the candidate that answered). */
    data class Dashboard(val host: String, val info: DeviceInfo) : AppState

    /** The paired Mac did not answer at any address. Retried by the app on its own ([AppModel.run]). */
    data class Unreachable(val name: String) : AppState

    /** The Mac answered and no longer knows this tablet. */
    data object Unauthorized : AppState

    /**
     * The Mac (or something at its address) answered with a key other than the pinned one. The
     * pairing is kept: the app retries on its own, and the user can pair again.
     */
    data class KeyChanged(val name: String) : AppState
}

/**
 * The paired Mac changed identity: from now on another key, or none, is the pin. The app clears
 * the WebView's SSL preferences before it creates the next WebView, so a certificate decision
 * taken under the old pin is never reused.
 */
enum class MacIdentityChange {
    /** A new pairing replaced whatever there was (a first pairing, or pairing again after a key change). */
    PAIRED,

    /** The pairing was dropped. */
    FORGOTTEN,
}

/**
 * The app's state machine, with no UI: it loads the pairing, finds the Mac with [Connector], and
 * moves between the screens. The screens and the platform pieces (NSD, the network callback, the
 * WebView) call into it; it never calls out to them.
 *
 * Every method is called on [dispatcher]'s thread (`Dispatchers.Main.immediate` in the app, a test
 * dispatcher in tests), and every job it starts runs there: that is what keeps its state
 * consistent without a lock, as `@MainActor` does on the iPad.
 *
 * @param discovered the addresses NSD resolved for `_fremkit._tcp`, read at the start of each attempt.
 * @param delay how [run] waits between its checks and retries; a test's virtual time runs them instantly.
 */
class AppModel(
    private val store: CredentialStore,
    private val connector: Connector = Connector(),
    private val discovered: () -> List<String> = { emptyList() },
    private val dispatcher: CoroutineDispatcher,
    private val delay: suspend (Duration) -> Unit = { kotlinx.coroutines.delay(it) },
) {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val _state = MutableStateFlow<AppState>(AppState.Connecting)
    private val _mac = MutableStateFlow<PairedMac?>(null)
    private val _isConnecting = MutableStateFlow(false)
    private val _credentialsUnreadable = MutableStateFlow(false)
    private val _serverVersion = MutableStateFlow<String?>(null)
    private val identityChanges = Channel<MacIdentityChange>(Channel.UNLIMITED)

    val state: StateFlow<AppState> = _state.asStateFlow()

    /** The pairing in use, null when there is none. */
    val mac: StateFlow<PairedMac?> = _mac.asStateFlow()

    /**
     * True while a connection attempt or a check is running, so a screen that stays up during a
     * retry (unreachable, key changed, unauthorized) can say so.
     */
    val isConnecting: StateFlow<Boolean> = _isConnecting.asStateFlow()

    /**
     * True when the store held something it could not give back at launch. The welcome screen
     * shows, the stored pairing is left alone (a Keystore failure is not "not paired"), and
     * [resume] reads it again when the app comes back to the foreground.
     */
    val credentialsUnreadable: StateFlow<Boolean> = _credentialsUnreadable.asStateFlow()

    /**
     * The Fremkit version the paired Mac said it runs in its last answer, for the "update your
     * Mac" line on the app's own screens. Kept while the Mac does not answer (the unreachable
     * screen is where the line helps), dropped with the pairing; null when the Mac's last answer
     * had none (a Mac older than the field) or none came yet.
     */
    val serverVersion: StateFlow<String?> = _serverVersion.asStateFlow()

    /**
     * One event per change of the paired Mac's identity ([pair], [forget]), in order, kept until
     * collected. One collector: the app, which clears the WebView's SSL preferences on each.
     */
    val macIdentityChanged: Flow<MacIdentityChange> = identityChanges.receiveAsFlow()

    private var running: Job? = null

    /**
     * What [running] is. A periodic check or a relocation gives way to anything else rather than
     * being joined: both leave the dashboard up when the Mac does not answer, which a reconnect or
     * a resume must not.
     */
    private var runningWork: Work? = null

    /** Periodic checks in a row that found nobody at the host in use. Reset by any answer. */
    private var unansweredChecks = 0

    /**
     * An address was announced while a check or a relocation ran on the dashboard: look again
     * when it ends rather than drop it.
     */
    private var relocationPending = false

    /** Bumped by [pair] and [forget], so the result of an attempt started for another pairing is dropped. */
    private var generation = 0

    private enum class Work {
        CONNECT, CHECK, PERIODIC_CHECK, RELOCATE;

        /** Runs behind the dashboard: anything the user or the page asks for comes first. */
        val isBackground: Boolean get() = this == PERIODIC_CHECK || this == RELOCATE
    }

    /** Loads the pairing and connects, or shows the welcome screen. */
    fun start(): Job? {
        val stored = try {
            store.load().also { _credentialsUnreadable.value = false }
        } catch (_: Exception) {
            _credentialsUnreadable.value = true
            null
        }
        if (stored == null) {
            _mac.value = null
            _state.value = AppState.Welcome
            return null
        }
        _mac.value = stored
        _state.value = AppState.Connecting
        return reconnect()
    }

    /**
     * Stores a new pairing (replacing any other) and connects to it.
     *
     * @throws Exception from the store when it refuses the pairing: a pairing that would be gone at
     *   the next launch is not a pairing, and nothing changes.
     */
    fun pair(mac: PairedMac): Job {
        store.save(mac)
        cancelRunning()
        _mac.value = mac
        _credentialsUnreadable.value = false
        _serverVersion.value = null
        identityChanges.trySend(MacIdentityChange.PAIRED)
        _state.value = AppState.Connecting
        return reconnect()
    }

    /** Drops the pairing, here and in the store. */
    fun forget() {
        store.clear()
        cancelRunning()
        _mac.value = null
        _credentialsUnreadable.value = false
        _serverVersion.value = null
        identityChanges.trySend(MacIdentityChange.FORGOTTEN)
        _state.value = AppState.Welcome
    }

    /**
     * Finds the Mac again: its name, its last address, then whatever NSD resolved. The
     * unreachable, key-changed and unauthorized screens stay up while it tries; the dashboard
     * gives way to [AppState.Connecting]. One attempt at a time: a call during an attempt joins it.
     */
    fun reconnect(): Job {
        running?.let { job ->
            if (runningWork?.isBackground != true) return job
            cancelRunning()
        }
        val mac = _mac.value
        if (mac == null) {
            _state.value = AppState.Welcome
            return Job().apply { complete() }
        }
        if (_state.value is AppState.Dashboard) _state.value = AppState.Connecting
        val generation = generation
        val candidates = discovered()
        // This attempt reads every address known now: one announced earlier needs no relocation.
        relocationPending = false
        return launch(Work.CONNECT) {
            val result = connector.connect(mac, candidates)
            finish(result, mac, generation)
        }
    }

    /** The page said the device was revoked. */
    fun pageSaidUnauthorized() {
        if (_state.value !is AppState.Dashboard) return
        cancelRunning()
        _state.value = AppState.Unauthorized
    }

    /**
     * The WebView could not load the page, its renderer died, or it refused the page's own
     * certificate. Always goes through [AppState.Connecting], so the dashboard comes back in a new
     * WebView: a check that was running ([resume]) is dropped rather than joined, since its answer
     * would keep the dead view.
     */
    fun dashboardFailed() {
        if (_state.value !is AppState.Dashboard) return
        cancelRunning()
        _state.value = AppState.Connecting
        reconnect()
    }

    /**
     * The app is in the foreground again (`onStart`). On the dashboard, asks the Mac whether it
     * still knows this tablet (`/api/devices/me` on the host in use); elsewhere, tries to connect
     * again.
     */
    fun resume(): Job? {
        val mac = _mac.value ?: return if (_credentialsUnreadable.value) start() else null
        val state = _state.value as? AppState.Dashboard ?: return reconnect()
        running?.let { job ->
            if (runningWork?.isBackground != true) return job
            cancelRunning()
        }
        return check(state.host, mac, periodic = false)
    }

    /**
     * The dashboard's safety net: asks the Mac whether it still knows this tablet, so a revocation
     * shows the app's screen even when the page does not say so. [AppState.Unauthorized], or a
     * wrong key (which reconnects), changes the screen. A Mac that does not answer is first the
     * page's to wait for, as it reconnects by itself, but only to the address it was loaded from:
     * after [UNANSWERED_CHECKS_BEFORE_RELOCATING] such checks in a row, the app looks for the Mac
     * at its other addresses behind the dashboard, in case it moved.
     * Null when not on the dashboard or while another attempt or check runs (never two at once).
     */
    fun checkAuthorization(): Job? {
        val state = _state.value as? AppState.Dashboard ?: return null
        val mac = _mac.value ?: return null
        if (running != null) return null
        return check(state.host, mac, periodic = true)
    }

    /**
     * NSD or the network callback learned a new address. On the dashboard, looks for the Mac
     * behind it, the host in use first: a page that still works stays where it is, and one whose
     * Mac moved follows it without waiting for the periodic checks. Elsewhere, the caller's
     * business (the unreachable and key-changed screens reconnect).
     * Announced while a check or a relocation runs, it is remembered and acted on when that ends.
     * Null when not on the dashboard or while another job runs.
     */
    fun addressesChanged(): Job? {
        val state = _state.value as? AppState.Dashboard ?: return null
        val mac = _mac.value ?: return null
        if (running != null) {
            relocationPending = true
            return null
        }
        return relocate(state.host, mac)
    }

    /**
     * What the iPad's root view does with timers, while the app is started: on the dashboard,
     * [checkAuthorization] every [AUTHORIZATION_CHECK_INTERVAL]; on the unreachable and
     * key-changed screens, [reconnect] every [RETRY_INTERVAL]. Each screen starts its own count.
     * Returns only when the caller is cancelled (`onStop`).
     */
    suspend fun run() = withContext(dispatcher) {
        _state.map { it::class }.distinctUntilChanged().collectLatest { screen ->
            when (screen) {
                AppState.Dashboard::class -> while (true) {
                    delay(AUTHORIZATION_CHECK_INTERVAL)
                    checkAuthorization()?.join()
                }
                AppState.Unreachable::class, AppState.KeyChanged::class -> while (true) {
                    delay(RETRY_INTERVAL)
                    reconnect().join()
                }
                else -> Unit
            }
        }
    }

    /** Stops every job; the model is not used after this. */
    fun close() {
        scope.cancel()
        identityChanges.close()
    }

    /** Probes `/api/devices/me` on the host in use. A resume reconnects when the Mac does not
     * answer there; a periodic check leaves that to the page. A wrong key reconnects in both. */
    private fun check(host: String, mac: PairedMac, periodic: Boolean): Job {
        val generation = generation
        return launch(if (periodic) Work.PERIODIC_CHECK else Work.CHECK) {
            val outcome = connector.prober.probe(host, mac.port, mac)
            finishCheck(outcome, host, generation, reconnectOnFailure = !periodic)
        }
    }

    /**
     * Runs the `Connector` without leaving the dashboard, and moves it only when the Mac answers
     * at another host. A Mac that answers nowhere (asleep, say) leaves the page as it is, so it
     * does not flicker; a revocation shows its screen, and a wrong key does only when the host in
     * use presented it ([Connector.relocate]).
     */
    private fun relocate(host: String, mac: PairedMac): Job {
        val generation = generation
        val candidates = discovered()
        relocationPending = false
        return launch(Work.RELOCATE) {
            val result = connector.relocate(mac, candidates, host)
            finishRelocate(result, host, generation)
        }
    }

    /**
     * Starts [work] as the one running job. Recorded before it starts, so an immediate dispatcher
     * that runs it to the end at once still finds it recorded, and clears it.
     */
    private fun launch(work: Work, block: suspend () -> Unit): Job {
        _isConnecting.value = true
        val job = scope.launch(start = CoroutineStart.LAZY) { block() }
        running = job
        runningWork = work
        job.start()
        return job
    }

    private fun ended() {
        running = null
        runningWork = null
        _isConnecting.value = false
    }

    private fun finish(result: ConnectResult, mac: PairedMac, generation: Int) {
        if (generation != this.generation) return
        ended()
        when (result) {
            is ConnectResult.Connected -> {
                remember(result.host, result.info, mac)
                unansweredChecks = 0
                _state.value = AppState.Dashboard(result.host, result.info)
            }
            ConnectResult.Unauthorized -> _state.value = AppState.Unauthorized
            ConnectResult.KeyChanged -> _state.value = AppState.KeyChanged(mac.name)
            ConnectResult.Unreachable -> _state.value = AppState.Unreachable(mac.name)
        }
    }

    private fun finishCheck(outcome: ProbeOutcome, host: String, generation: Int, reconnectOnFailure: Boolean) {
        if (generation != this.generation) return
        ended()
        if ((_state.value as? AppState.Dashboard)?.host != host) return
        val mac = _mac.value ?: return
        if (outcome != ProbeOutcome.Unreachable) unansweredChecks = 0
        when (outcome) {
            is ProbeOutcome.Ok -> {
                remember(null, outcome.info, mac)
                _state.value = AppState.Dashboard(host, outcome.info)
            }
            ProbeOutcome.Unauthorized -> _state.value = AppState.Unauthorized
            // A wrong key reconnects even from the periodic check: the Connector then decides
            // between the dashboard (another candidate answers) and the key-changed screen.
            ProbeOutcome.PinMismatch -> reconnect()
            ProbeOutcome.Unreachable -> if (reconnectOnFailure) {
                reconnect()
            } else {
                unansweredChecks += 1
                if (unansweredChecks >= UNANSWERED_CHECKS_BEFORE_RELOCATING) {
                    relocate(host, mac)
                    return
                }
            }
        }
        runPendingRelocation()
    }

    private fun finishRelocate(result: ConnectResult, from: String, generation: Int) {
        if (generation != this.generation) return
        ended()
        if ((_state.value as? AppState.Dashboard)?.host != from) return
        val mac = _mac.value ?: return
        when (result) {
            is ConnectResult.Connected -> {
                remember(result.host, result.info, mac)
                unansweredChecks = 0
                // A new host rebuilds the WebView; the same one keeps it.
                _state.value = AppState.Dashboard(result.host, result.info)
            }
            ConnectResult.Unauthorized -> _state.value = AppState.Unauthorized
            ConnectResult.KeyChanged -> _state.value = AppState.KeyChanged(mac.name)
            ConnectResult.Unreachable -> Unit
        }
        runPendingRelocation()
    }

    /**
     * Runs the relocation an address announced during the job that just ended asked for, if the
     * dashboard is still up and nothing else started.
     */
    private fun runPendingRelocation() {
        if (!relocationPending) return
        relocationPending = false
        val state = _state.value as? AppState.Dashboard ?: return
        val mac = _mac.value ?: return
        if (running != null) return
        relocate(state.host, mac)
    }

    /**
     * What an answer taught: the address that answered (null for a check of the host in use),
     * the other addresses the Mac listed, remembered for the next search and the next launch (if
     * the store refuses, this session still has them), and the version it runs.
     */
    private fun remember(host: String?, info: DeviceInfo, mac: PairedMac) {
        _serverVersion.value = info.serverVersion
        var updated = mac.updating(addresses = info.addresses)
        if (host != null) updated = updated.updating(address = host)
        if (updated == mac) return
        try {
            store.save(updated)
        } catch (_: Exception) {
            // Kept for this session; the next answer tries again.
        }
        _mac.value = updated
    }

    private fun cancelRunning() {
        generation += 1
        relocationPending = false
        running?.cancel()
        ended()
    }

    companion object {
        /** How often the dashboard asks the Mac whether it still knows this tablet ([checkAuthorization]). */
        val AUTHORIZATION_CHECK_INTERVAL: Duration = 30.seconds

        /** How often the unreachable and key-changed screens try again. */
        val RETRY_INTERVAL: Duration = 5.seconds

        /**
         * Periodic checks in a row that must find nobody at the host in use before the app looks
         * for the Mac elsewhere: about a minute, so one lost request moves nothing.
         */
        const val UNANSWERED_CHECKS_BEFORE_RELOCATING = 2
    }
}

/** What the app's screens say about the Mac's Fremkit version next to the app's own. */
enum class VersionNudge {
    /** The Mac runs an older Fremkit than this app: update the Mac. */
    UPDATE_MAC,

    /** The Mac runs a newer Fremkit than this app: update the app. */
    UPDATE_APP,
    ;

    companion object {
        /**
         * Compares `major.minor.patch`, a pre-release or build suffix ignored. Null when they are
         * the same, or when either is not a version (a Mac older than `serverVersion` sends none,
         * and says nothing).
         */
        fun of(serverVersion: String?, appVersion: String): VersionNudge? {
            val server = parse(serverVersion ?: return null) ?: return null
            val app = parse(appVersion) ?: return null
            for (i in 0 until 3) {
                if (server[i] < app[i]) return UPDATE_MAC
                if (server[i] > app[i]) return UPDATE_APP
            }
            return null
        }

        private val VERSION = Regex("""^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+].*)?$""")

        private fun parse(version: String): List<Int>? =
            VERSION.matchEntire(version.trim())?.groupValues?.drop(1)?.map(String::toInt)
    }
}
