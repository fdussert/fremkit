package app.fremkit.android

import android.content.Context

/** Release builds read no seeded pairing link: see the debug build's `Seed`. */
internal object Seed {
    @Suppress("UNUSED_PARAMETER", "FunctionOnlyReturningConstant")
    fun take(context: Context): String? = null
}
