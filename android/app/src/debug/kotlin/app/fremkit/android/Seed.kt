package app.fremkit.android

import android.content.Context
import java.io.File
import java.io.IOException

/**
 * Debug builds only: a pairing link `scripts/build-android.sh install --seed` wrote into the app's
 * private files, opened as if the app's own scanner had read it, so a development install pairs
 * without the camera (the iPad's `seedFromInstall()`). The file is read once and deleted before the
 * link is used. It is a file, written through `run-as` from the script's stdin, and never a launch
 * argument or an `adb push`: the link carries the code's secret, and every account on the Mac reads
 * a process's arguments with `ps`. Release builds have a `Seed` that does nothing.
 */
internal object Seed {
    /** In `filesDir`: where the script's `run-as … sh -c 'cat > files/seed-link'` writes. */
    const val FILE = "seed-link"

    /** The seeded link, once; null when there is none. */
    fun take(context: Context): String? {
        val file = File(context.filesDir, FILE)
        if (!file.exists()) return null
        val text = try {
            file.readText()
        } catch (_: IOException) {
            null
        } finally {
            file.delete()
        }
        return text?.trim()?.takeIf { it.isNotEmpty() }
    }
}
