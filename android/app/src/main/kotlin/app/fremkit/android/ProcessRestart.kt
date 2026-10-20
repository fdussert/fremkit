package app.fremkit.android

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Process

/**
 * Restarts the app in a fresh process, so nothing the old one held survives: Chromium's pool of
 * keep-alive TLS connections above all ([PinChangeGuard]).
 *
 * The main process starts [RestartActivity], which runs in a process of its own (`:restart` in
 * the manifest), kills the main process, launches [MainActivity] in a new one and exits. The
 * pairing is already on disk when this runs ([app.fremkit.kit.AppModel.pair] and `forget` write
 * the store before they announce the change), so the new process starts from it.
 */
object ProcessRestart {
    internal const val EXTRA_PID = "app.fremkit.android.restart.pid"

    /** The name suffix of the helper process, which runs nothing of the app's own. */
    const val PROCESS_SUFFIX = ":restart"

    fun now(context: Context) {
        val intent = Intent(context, RestartActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(EXTRA_PID, Process.myPid())
        context.startActivity(intent)
    }

    /** Whether this process is the restart helper's (whose `Application.onCreate` must do nothing). */
    fun isHelperProcess(): Boolean = Application.getProcessName().endsWith(PROCESS_SUFFIX)
}

/** The restart helper: no window, a moment's life in its own process. */
class RestartActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pid = intent.getIntExtra(ProcessRestart.EXTRA_PID, -1)
        if (pid > 0 && pid != Process.myPid()) Process.killProcess(pid)
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        finish()
        Runtime.getRuntime().exit(0)
    }
}
