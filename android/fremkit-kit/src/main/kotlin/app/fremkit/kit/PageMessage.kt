package app.fremkit.kit

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * What the dashboard page posts to the app's `fremkit` message listener
 * (`ui/src/dashboard/native.ts`). Anything else is ignored.
 */
sealed interface PageMessage {
    /** The Mac no longer knows this device. */
    data object Unauthorized : PageMessage

    /** The device screen the page shows, or null while the Mac has given it none. */
    data class Screen(val screenId: String?) : PageMessage

    /** The brightness the Mac wants, 0–100, once per [seq]. */
    data class Brightness(val target: Double, val seq: Int) : PageMessage

    companion object {
        /**
         * Reads a message's data. The Android channel carries a string, which the page writes with
         * `JSON.stringify`: an object with a string `type`. Null for anything else, including a
         * field of the wrong type (a number where a string goes, a boolean where a number goes).
         */
        fun parse(json: String): PageMessage? {
            val fields = try {
                Json.parseToJsonElement(json) as? JsonObject
            } catch (_: SerializationException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            } ?: return null
            val type = fields["type"].string() ?: return null
            return when (type) {
                "unauthorized" -> Unauthorized
                "screen" -> when (val id = fields["screenId"]) {
                    is JsonNull -> Screen(null)
                    else -> id.string()?.let(::Screen)
                }
                "brightness" -> {
                    val target = fields["target"].number() ?: return null
                    if (!target.isFinite() || target !in 0.0..100.0) return null
                    val seq = fields["seq"].number() ?: return null
                    if (seq != Math.rint(seq) || seq !in Int.MIN_VALUE.toDouble()..Int.MAX_VALUE.toDouble()) return null
                    Brightness(target, seq.toInt())
                }
                else -> null
            }
        }

        private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun JsonElement?.number(): Double? {
            val p = this as? JsonPrimitive ?: return null
            if (p.isString || p is JsonNull || p.booleanOrNull != null) return null
            return p.doubleOrNull
        }
    }
}
