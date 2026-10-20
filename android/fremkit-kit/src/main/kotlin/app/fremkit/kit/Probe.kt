package app.fremkit.kit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.net.URISyntaxException

/** What `GET /api/devices/me` returns. */
@Serializable(with = DeviceInfoSerializer::class)
class DeviceInfo(
    val id: String,
    val name: String,
    /** The device screen this tablet shows, or null while the Mac has not given it one. */
    val screenId: String?,
    /** What the Mac wants the screen's brightness at, or null when brightness is not the Mac's to set. */
    val brightness: DeviceBrightness?,
    addresses: List<String> = emptyList(),
    /**
     * The Fremkit version the Mac runs, for the "update your Mac" line; null from a Mac older
     * than the field (or one that sends something else than a string).
     */
    val serverVersion: String? = null,
) {
    /**
     * The Mac's other LAN addresses, where to look for it when the one in use goes away. Only the
     * private IPv4 literals the Mac sent, at most [PairedMac.MAX_ADDRESSES]; empty from a Mac that
     * sends none.
     */
    val addresses: List<String> = PairedMac.cleaned(addresses)

    override fun equals(other: Any?): Boolean =
        other is DeviceInfo && id == other.id && name == other.name && screenId == other.screenId &&
            brightness == other.brightness && addresses == other.addresses && serverVersion == other.serverVersion

    override fun hashCode(): Int = listOf(id, name, screenId, brightness, addresses, serverVersion).hashCode()

    override fun toString(): String =
        "DeviceInfo(id=$id, name=$name, screenId=$screenId, brightness=$brightness, addresses=$addresses, serverVersion=$serverVersion)"

    companion object {
        private val wire = Json { ignoreUnknownKeys = true }

        /**
         * The device record in a response body, or null when it is not one. Lenient about
         * `addresses` and `serverVersion` only: missing or of the wrong type is none. The wire is
         * never trusted with where the app connects.
         */
        fun fromJson(json: String): DeviceInfo? = try {
            wire.decodeFromString(serializer(), json)
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}

@Serializable
data class DeviceBrightness(
    /** 0–100, or null for "leave it alone". */
    val target: Double? = null,
    /** Bumped by the Mac for each new target: the app applies a target once per `seq`. */
    val seq: Int,
)

/** The wire form of [DeviceInfo], with the lenient fields left as JSON. */
@Serializable
private class DeviceInfoRecord(
    val id: String,
    val name: String,
    val screenId: String? = null,
    val brightness: DeviceBrightness? = null,
    val addresses: JsonElement? = null,
    val serverVersion: JsonElement? = null,
)

internal object DeviceInfoSerializer : KSerializer<DeviceInfo> {
    override val descriptor: SerialDescriptor = DeviceInfoRecord.serializer().descriptor

    override fun serialize(encoder: Encoder, value: DeviceInfo) {
        val record = DeviceInfoRecord(value.id, value.name, value.screenId, value.brightness,
            JsonArray(value.addresses.map(::JsonPrimitive)), value.serverVersion?.let(::JsonPrimitive))
        encoder.encodeSerializableValue(DeviceInfoRecord.serializer(), record)
    }

    /** A list entry that is not a string is dropped, as on the iPad; a list that is not one is no list. */
    override fun deserialize(decoder: Decoder): DeviceInfo {
        val r = decoder.decodeSerializableValue(DeviceInfoRecord.serializer())
        val addresses = (r.addresses as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content }
        val version = (r.serverVersion as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
        return DeviceInfo(r.id, r.name, r.screenId, r.brightness, addresses, version)
    }
}

sealed interface ProbeOutcome {
    data class Ok(val info: DeviceInfo) : ProbeOutcome

    /** The Mac answered and does not know this token: the pairing was removed. */
    data object Unauthorized : ProbeOutcome

    /** Something answered with another key: not the paired Mac, try the next address. */
    data object PinMismatch : ProbeOutcome

    /** Nothing answered, or not as a Fremkit Mac would. */
    data object Unreachable : ProbeOutcome
}

fun interface Prober {
    suspend fun probe(host: String, port: Int, mac: PairedMac): ProbeOutcome
}

/** Which hosts the pin covers and which key it expects. Printing a policy never shows the pin. */
class PinPolicy(val keyHash: String, val hosts: Set<String>) {
    override fun equals(other: Any?): Boolean = other is PinPolicy && keyHash == other.keyHash && hosts == other.hosts
    override fun hashCode(): Int = 31 * keyHash.hashCode() + hosts.hashCode()
    override fun toString(): String = "PinPolicy(hosts=${hosts.sorted()})"
}

/**
 * One HTTPS request, as the kit builds it. Its [toString] shows the method and the URL only: the
 * headers carry the device cookie and the body a pairing proof or secret.
 */
class Request(
    val uri: URI,
    val method: String = "GET",
    headers: Map<String, String> = emptyMap(),
    val body: ByteArray? = null,
    val timeoutMillis: Int = Endpoint.TIMEOUT_MILLIS,
) {
    val headers: Map<String, String> = headers.toMap()

    /** A header's value, its name compared without case. */
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

    fun copy(
        method: String = this.method,
        headers: Map<String, String> = this.headers,
        body: ByteArray? = this.body,
        timeoutMillis: Int = this.timeoutMillis,
    ): Request = Request(uri, method, headers, body, timeoutMillis)

    override fun toString(): String = "Request($method $uri)"
}

/** How a pinned request ended. */
sealed interface Exchange {
    class Response(val status: Int, val body: ByteArray) : Exchange {
        override fun equals(other: Any?): Boolean = other is Response && status == other.status && body.contentEquals(other.body)
        override fun hashCode(): Int = 31 * status + body.contentHashCode()
        override fun toString(): String = "Response($status, ${body.size} bytes)"
    }

    /** The host is the paired Mac's but presented another key. */
    data object PinRejected : Exchange

    /** Timeout, refused, TLS failure, anything else. */
    data object Failed : Exchange
}

/** Sends one request under a pin. The real one is [PinnedTransport.default]; tests pass their own. */
typealias Transport = suspend (Request, PinPolicy) -> Exchange

object PinnedTransport {
    /** A response body larger than this is not a Fremkit Mac's answer. */
    internal const val MAX_BODY = 1 shl 20

    /** [send] on the IO dispatcher, interrupted when the caller is cancelled. */
    val default: Transport = { request, policy -> runInterruptible(Dispatchers.IO) { send(request, policy) } }

    /**
     * Sends [request] through a fresh [PinnedTls] for [policy], so a pin refusal is told apart
     * from a network failure. Blocking. No cache, no redirect, the request's own timeout for the
     * connection and for each read; the cookie is the request's header, set by hand, and nothing
     * is kept from the response.
     */
    fun send(request: Request, policy: PinPolicy): Exchange = send(request, PinnedTls(policy.keyHash, policy.hosts))

    internal fun send(request: Request, pinned: PinnedTls): Exchange {
        val connection = try {
            pinned.open(request.uri.toURL())
        } catch (_: Exception) {
            return Exchange.Failed
        }
        return try {
            connection.requestMethod = request.method
            connection.connectTimeout = request.timeoutMillis
            connection.readTimeout = request.timeoutMillis
            connection.doInput = true
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            request.body?.let { body ->
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use(::readCapped) ?: ByteArray(0)
            if (body.size > MAX_BODY) Exchange.Failed else Exchange.Response(status, body)
        } catch (_: IOException) {
            if (pinned.rejectedPin) Exchange.PinRejected else Exchange.Failed
        } catch (_: RuntimeException) {
            // Some stacks wrap a TLS failure in an unchecked exception.
            if (pinned.rejectedPin) Exchange.PinRejected else Exchange.Failed
        } finally {
            connection.disconnect()
        }
    }

    /** At most one byte past [MAX_BODY], so an oversized body is seen without reading all of it. */
    private fun readCapped(stream: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (out.size() <= MAX_BODY) {
            val n = stream.read(buffer)
            if (n < 0) break
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }
}

object Endpoint {
    const val TIMEOUT_MILLIS = 5000

    /**
     * `https://<host>:<port><path>` as the dashboard spells it ([Dashboard.resource]: an IPv6
     * literal in brackets, its zone escaped), or null when that is not a URL with a host.
     */
    fun url(host: String, port: Int, path: String): URI? = try {
        URI(Dashboard.resource(host, port, path)).takeIf { it.host != null }
    } catch (_: URISyntaxException) {
        null
    }

    fun request(host: String, port: Int, path: String, token: String?): Request? {
        val uri = url(host, port, path) ?: return null
        val headers = if (token != null) mapOf("Cookie" to "${Dashboard.COOKIE_NAME}=$token") else emptyMap()
        return Request(uri, headers = headers)
    }
}

/**
 * Asks one address whether it is the paired Mac and whether it still knows this tablet:
 * `GET https://<host>:<port>/api/devices/me?addresses=1` with the device cookie, 5 s timeout. The
 * `addresses=1` asks for the Mac's other addresses (and its version), which only the app does.
 */
class HttpProber(private val transport: Transport = PinnedTransport.default) : Prober {
    override suspend fun probe(host: String, port: Int, mac: PairedMac): ProbeOutcome {
        val request = Endpoint.request(host, port, "/api/devices/me?addresses=1", mac.token) ?: return ProbeOutcome.Unreachable
        val policy = PinPolicy(mac.keyHash, Dashboard.pinnedHosts(mac, host))
        return when (val exchange = transport(request, policy)) {
            is Exchange.Response -> when (exchange.status) {
                200 -> DeviceInfo.fromJson(exchange.body.decodeToString())?.let(ProbeOutcome::Ok) ?: ProbeOutcome.Unreachable
                401 -> ProbeOutcome.Unauthorized
                else -> ProbeOutcome.Unreachable
            }
            Exchange.PinRejected -> ProbeOutcome.PinMismatch
            Exchange.Failed -> ProbeOutcome.Unreachable
        }
    }
}
