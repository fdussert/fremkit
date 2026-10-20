package app.fremkit.android

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Window
import app.fremkit.kit.AndroidBrightness
import app.fremkit.kit.BrightnessReporter
import app.fremkit.kit.BrightnessSync
import app.fremkit.kit.PairedMac
import app.fremkit.kit.PinnedTransport
import app.fremkit.kit.ReportOutcome
import kotlinx.coroutines.CoroutineScope

/**
 * The tablet as its screen's brightness hand (decision 8), over the kit's [AndroidBrightness] and
 * [BrightnessSync]:
 *
 * - A target from the Mac (the page's `brightness` message, [receive]) sets the **window's**
 *   brightness: no permission, in effect only while the app is in front, as on the iPad. The
 *   system level is never written.
 * - The user moving the system slider (a [ContentObserver] on `SCREEN_BRIGHTNESS` and its mode)
 *   drops the window override, so their level is what the screen shows, and reports it.
 * - While the dashboard is shown and the app started ([run]), the level is reported every 10 s,
 *   through the kit's pinned transport to the host the dashboard uses, which keeps the Mac from
 *   marking the screen as gone; a 401 is a revocation ([unauthorized]).
 *
 * One per process: the override outlives a new activity ([attach] re-applies it). Called on the
 * main thread; [scope] runs there.
 */
class ScreenBrightness(
    private val context: Context,
    scope: CoroutineScope,
    private val unauthorized: () -> Unit,
) {
    private var window: Window? = null
    private var reporter: BrightnessReporter? = null
    private var pairing: String? = null

    /** True while [run] runs: a change of the system level is reported only then. */
    private var running = false

    /** The window override over the system level (the kit's semantics). */
    val levels = AndroidBrightness(applyWindow = ::applyWindow, systemLevel = ::systemLevel)

    private val sync = BrightnessSync(
        scope = scope,
        read = levels::read,
        write = levels::write,
        send = { level, applied ->
            reporter?.sender(PinnedTransport.default)?.invoke(level, applied) ?: ReportOutcome.FAILED
        },
        unauthorized = unauthorized,
    )

    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = systemChanged()
    }

    /** The activity's window, which the override is set on; the system level is watched from now on. */
    fun attach(window: Window) {
        if (this.window == null) {
            val resolver = context.contentResolver
            resolver.registerContentObserver(Settings.System.getUriFor(Settings.System.SCREEN_BRIGHTNESS), false, observer)
            resolver.registerContentObserver(Settings.System.getUriFor(Settings.System.SCREEN_BRIGHTNESS_MODE), false, observer)
        }
        this.window = window
        levels.reapply()
    }

    /** The activity is gone. */
    fun detach(window: Window) {
        if (this.window !== window) return
        this.window = null
        context.contentResolver.unregisterContentObserver(observer)
    }

    /** The dashboard of [mac] is up at [host]: reports go there. A new pairing starts afresh. */
    fun show(mac: PairedMac, host: String) {
        if (pairing != mac.deviceId) {
            sync.reset()
            pairing = mac.deviceId
        }
        reporter = BrightnessReporter(mac, host)
    }

    /**
     * Reports now and every 10 s until cancelled (the dashboard went, or the app stopped); then
     * drops what was pending or in flight.
     */
    suspend fun run() {
        running = true
        try {
            sync.run()
        } finally {
            running = false
            sync.stop()
        }
    }

    /** A target from the Mac, through the page. Applied once per `seq`, then reported. */
    fun receive(target: Double, seq: Int) {
        sync.receive(target, seq)
    }

    /**
     * The system level or mode changed (the user's slider): the override goes, and the level the
     * screen now shows is reported when the dashboard runs.
     */
    fun systemChanged() {
        levels.systemChanged()
        if (running) sync.levelChanged()
    }

    private fun applyWindow(level: Float) {
        val window = window ?: return
        window.attributes = window.attributes.apply { screenBrightness = level }
    }

    private fun systemLevel(): Int = try {
        Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
    } catch (_: Settings.SettingNotFoundException) {
        DEFAULT_SYSTEM_LEVEL
    }

    private companion object {
        /** Half way, when a vendor build has no level at all. */
        const val DEFAULT_SYSTEM_LEVEL = 128
    }
}
