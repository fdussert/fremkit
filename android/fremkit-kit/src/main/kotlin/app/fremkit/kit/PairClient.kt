package app.fremkit.kit

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The screen size the tablet reports when it pairs, in dp, within the server's `ViewportSchema`
 * bounds (integers, 1–10000).
 */
class Viewport(width: Int, height: Int) {
    val width: Int = width.coerceIn(1, 10000)
    val height: Int = height.coerceIn(1, 10000)

    override fun equals(other: Any?): Boolean = other is Viewport && width == other.width && height == other.height
    override fun hashCode(): Int = 31 * width + height
    override fun toString(): String = "Viewport($width x $height)"
}

/**
 * Why pairing failed. No case carries the token, the key, the code or the secret, and none keeps
 * a cause: the messages are the server's own, already localized for the Mac's language.
 */
sealed class PairError(message: String) : Exception(message) {
    /** 403: the code is wrong or expired; the server's message says which. */
    class Rejected(val serverMessage: String) : PairError(serverMessage) {
        override fun equals(other: Any?): Boolean = other is Rejected && serverMessage == other.serverMessage
        override fun hashCode(): Int = serverMessage.hashCode()
        override fun toString(): String = "PairError.Rejected($serverMessage)"
    }

    /**
     * 429 from every Mac address that answered: too many tries. One address refusing is not
     * enough, since the Mac counts tries per address.
     */
    class Limited(val serverMessage: String) : PairError(serverMessage) {
        override fun equals(other: Any?): Boolean = other is Limited && serverMessage == other.serverMessage
        override fun hashCode(): Int = serverMessage.hashCode()
        override fun toString(): String = "PairError.Limited($serverMessage)"
    }

    /**
     * 404 from the Mac itself (it passed the pin): no pairing code is showing on it right now —
     * none was made, it was used, or its five minutes are over.
     */
    data object NoCode : PairError("no pairing code is showing on the Mac")

    /** An address answered with another key than the link's: not the Mac that showed the code. */
    data object WrongMac : PairError("another Mac answered")

    /** Nothing answered. */
    data object Unreachable : PairError("the Mac did not answer")

    /** 400: the app sent something the server does not accept (a bug, not the user's doing). */
    data object InvalidRequest : PairError("the Mac refused the request")
}

/** `POST /api/pair` to the first of the hosts that answers under the pin. */
class PairClient(
    private val transport: Transport = PinnedTransport.default,
    /** The typed code's proof for a key ([CodeProof.proof]); a seam for tests. */
    private val prove: (code: String, keyHash: String) -> String = CodeProof::proof,
) {
    @Serializable
    private class Paired(val token: String, val deviceId: String)

    @Serializable
    private class Refusal(val error: String)

    /**
     * Pairs, and returns the record to store.
     *
     * @param hosts where to try, in order: the link's `.local` name and address, or a discovered
     *   service's name and resolved addresses.
     * @param name this tablet's name, shown on the Mac.
     * @param macName the Mac's name for people, stored in the record.
     * @param code the normalised code, sent as its proof for [keyHash]: only the Mac holding that
     *   key can take it. The code itself never leaves the tablet.
     * @param secret the QR link's secret, sent instead of the code when there is one: the Mac
     *   takes it even while it refuses codes to someone guessing them.
     * @throws PairError
     */
    suspend fun pair(
        hosts: List<String>,
        port: Int,
        keyHash: String,
        code: String,
        secret: String? = null,
        name: String,
        viewport: Viewport,
        macName: String,
    ): PairedMac {
        val trimmed = hosts.map(::trimmingTrailingDot)
        val policy = PinPolicy(keyHash, trimmed.toSet())
        // `proof` or `secret`, never both: the one not sent is not in the body at all.
        val proof = if (secret == null) {
            try {
                withContext(Dispatchers.Default) { prove(code, keyHash) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                throw PairError.InvalidRequest
            }
        } else {
            null
        }
        val body = buildJsonObject {
            if (proof != null) put("proof", proof)
            if (secret != null) put("secret", secret)
            put("name", name)
            put("viewport", buildJsonObject {
                put("width", viewport.width)
                put("height", viewport.height)
            })
            put("platform", PLATFORM)
        }.toString().toByteArray()

        var sawWrongMac = false
        // The Mac counts wrong codes per address, so one candidate answering 429 says nothing about
        // the next. A right code is never counted as a wrong one, so trying it again elsewhere
        // costs nothing.
        var limited: String? = null
        for (host in trimmed) {
            val request = Endpoint.request(host, port, "/api/pair", token = null)?.copy(
                method = "POST",
                headers = mapOf("Content-Type" to "application/json"),
                body = body,
            ) ?: continue
            when (val exchange = transport(request, policy)) {
                is Exchange.Response -> when (exchange.status) {
                    200 -> {
                        val paired = decode(Paired.serializer(), exchange.body) ?: throw PairError.Unreachable
                        return PairedMac(
                            host = trimmed.firstOrNull(::isLocalName) ?: host,
                            address = if (isIPv4Literal(host)) host else trimmed.firstOrNull(::isIPv4Literal) ?: host,
                            port = port, keyHash = keyHash, token = paired.token, deviceId = paired.deviceId, name = macName,
                        )
                    }
                    403 -> throw PairError.Rejected(message(exchange.body))
                    429 -> if (limited == null) limited = message(exchange.body)
                    404 -> throw PairError.NoCode
                    400 -> throw PairError.InvalidRequest
                    else -> continue
                }
                Exchange.PinRejected -> sawWrongMac = true
                Exchange.Failed -> continue
            }
        }
        // Every candidate failed: the Mac's own answer first, then an impostor, then silence.
        limited?.let { throw PairError.Limited(it) }
        throw if (sawWrongMac) PairError.WrongMac else PairError.Unreachable
    }

    private companion object {
        /** What the server records for this app's devices. */
        const val PLATFORM = "android"

        val wire = Json { ignoreUnknownKeys = true }

        fun <T> decode(serializer: KSerializer<T>, body: ByteArray): T? = try {
            wire.decodeFromString(serializer, body.decodeToString())
        } catch (_: Exception) {
            // The library quotes its input in its messages: nothing of it goes further.
            null
        }

        fun message(body: ByteArray): String = decode(Refusal.serializer(), body)?.error ?: ""
    }
}

/** Reads the key a Mac presents on first contact, trusting nothing and sending nothing. */
object FirstContact {
    /**
     * Opens TLS to [host]:[port] under a [PinnedTls] in first-contact mode, which refuses the
     * handshake after recording the key: no request reaches the Mac. Null when nothing answered
     * or the key is not one a Fremkit Mac uses.
     */
    suspend fun keyHash(host: String, port: Int, timeoutMillis: Int = Endpoint.TIMEOUT_MILLIS): String? {
        val request = Endpoint.request(host, port, "/api/devices/me", token = null)?.copy(timeoutMillis = timeoutMillis)
            ?: return null
        val pinned = PinnedTls(keyHash = null, hosts = setOf(host))
        return runInterruptible(Dispatchers.IO) {
            PinnedTransport.send(request, pinned)
            pinned.observedKeyHash
        }
    }
}
