package app.fremkit.android

/**
 * NSD resolutions, one at a time. API 28's `NsdManager` fails a resolution started while another
 * is in flight (`FAILURE_ALREADY_ACTIVE`), so services found together are resolved in turn: each
 * name waits once in line, [start] is called for one at a time, and [done] (resolved or failed)
 * lets the next one go.
 *
 * No Android type: tested on the JVM. Called on the main thread.
 */
class ResolveQueue(private val start: (String) -> Unit) {
    private val waiting = ArrayDeque<String>()

    /** The name being resolved, null when none is. */
    var current: String? = null
        private set

    /** The names waiting, in order. */
    val pending: List<String> get() = waiting.toList()

    /** Resolves [name] after those already waiting; nothing if it is waiting or in flight. */
    fun add(name: String) {
        if (name == current || name in waiting) return
        waiting.addLast(name)
        next()
    }

    /** [name] is gone: it no longer waits. One in flight finishes on its own and calls [done]. */
    fun remove(name: String) {
        waiting.remove(name)
    }

    /** The resolution of [name] ended; the next one starts. A late answer for another name is ignored. */
    fun done(name: String) {
        if (current != name) return
        current = null
        next()
    }

    /** Forgets everything (browsing stopped); a late [done] does nothing. */
    fun clear() {
        waiting.clear()
        current = null
    }

    private fun next() {
        if (current != null) return
        val name = waiting.removeFirstOrNull() ?: return
        current = name
        start(name)
    }
}
