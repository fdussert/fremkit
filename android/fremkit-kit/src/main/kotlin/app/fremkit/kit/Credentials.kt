package app.fremkit.kit

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

/** What a secret prints as. */
internal const val REDACTED = "<redacted>"

/**
 * The Mac this tablet is paired with, and the token that proves it.
 *
 * [toString] never shows the token or the pin. Read and write a stored record with [fromJson] and
 * [toJson]: the JSON library quotes its input in its own error messages, and [fromJson] is what
 * keeps the token out of them.
 */
@Serializable(with = PairedMacSerializer::class)
class PairedMac(
    /** The Mac's `.local` name. */
    val host: String,
    /** The last address that answered, usually an IP literal. */
    val address: String,
    val port: Int,
    /** The pin, base64url SHA-256 of the Mac's SPKI. */
    val keyHash: String,
    /** The device token, sent as the `fremkit_device` cookie. Never logged. */
    val token: String,
    val deviceId: String,
    /** The Mac's name for people: its `.local` name without the suffix, or its Bonjour name. */
    val name: String,
    addresses: List<String> = emptyList(),
) {
    /**
     * The Mac's other LAN addresses, as it last listed them (`DeviceInfo.addresses`): tried after
     * [host] and [address] when looking for it, under the same pin. Private IPv4 literals only, at
     * most [MAX_ADDRESSES].
     */
    val addresses: List<String> = cleaned(addresses)

    /** The record with [addresses] (cleaned) as the Mac's other addresses: what it listed last. */
    fun updating(addresses: List<String>): PairedMac =
        PairedMac(host, address, port, keyHash, token, deviceId, name, addresses)

    /**
     * The record with [address] as the one to try first next time, when it is an IP literal (the
     * Mac moved). A name that answered changes nothing: [host] already is that name.
     */
    fun updating(address: String): PairedMac =
        if (!isIPLiteral(address)) this else PairedMac(host, address, port, keyHash, token, deviceId, name, addresses)

    /** The record as stored: the same keys as the iPad's. */
    fun toJson(): String = storage.encodeToString(serializer(), this)

    override fun equals(other: Any?): Boolean =
        other is PairedMac && host == other.host && address == other.address && port == other.port &&
            keyHash == other.keyHash && token == other.token && deviceId == other.deviceId && name == other.name &&
            addresses == other.addresses

    override fun hashCode(): Int = listOf(host, address, port, keyHash, token, deviceId, name, addresses).hashCode()

    override fun toString(): String = "PairedMac($name, $host, $address:$port, device $deviceId)"

    companion object {
        /** How many of the Mac's other addresses are kept. */
        const val MAX_ADDRESSES = 8

        /** Unknown keys are ignored: a record written by a newer app still loads. */
        private val storage = Json { ignoreUnknownKeys = true }

        /** The private IPv4 literals of [addresses], each once, in order, at most [MAX_ADDRESSES]. */
        internal fun cleaned(addresses: List<String>): List<String> =
            addresses.filter(::isPrivateIPv4Literal).distinct().take(MAX_ADDRESSES)

        /**
         * A stored record. A record stored before `addresses` existed has none. Throws
         * [UnreadableCredentialsException], which quotes nothing of [json], when it is not one.
         */
        fun fromJson(json: String): PairedMac = try {
            storage.decodeFromString(serializer(), json)
        } catch (_: SerializationException) {
            throw UnreadableCredentialsException("the stored pairing is not a pairing record")
        } catch (_: IllegalArgumentException) {
            throw UnreadableCredentialsException("the stored pairing is not a pairing record")
        }
    }
}

/**
 * A pairing is stored but cannot be read: never "not paired". Its message never carries anything
 * of the record, and it keeps no cause, whose message would.
 */
class UnreadableCredentialsException(message: String) : Exception(message)

/** The stored form: [PairedMac]'s fields, with `addresses` read leniently. */
@Serializable
private class PairedMacRecord(
    val host: String,
    val address: String,
    val port: Int,
    val keyHash: String,
    val token: String,
    val deviceId: String,
    val name: String,
    val addresses: JsonElement? = null,
)

internal object PairedMacSerializer : KSerializer<PairedMac> {
    override val descriptor: SerialDescriptor = PairedMacRecord.serializer().descriptor

    override fun serialize(encoder: Encoder, value: PairedMac) {
        val record = PairedMacRecord(value.host, value.address, value.port, value.keyHash, value.token, value.deviceId,
            value.name, JsonArray(value.addresses.map(::JsonPrimitive)))
        encoder.encodeSerializableValue(PairedMacRecord.serializer(), record)
    }

    /** Anything but a list of strings in `addresses` is no addresses, as in the Swift kit. */
    override fun deserialize(decoder: Decoder): PairedMac {
        val r = decoder.decodeSerializableValue(PairedMacRecord.serializer())
        val list = r.addresses as? JsonArray
        val addresses = if (list != null && list.all { it is JsonPrimitive && it.isString }) {
            list.map { (it as JsonPrimitive).content }
        } else {
            emptyList()
        }
        return PairedMac(r.host, r.address, r.port, r.keyHash, r.token, r.deviceId, r.name, addresses)
    }
}

interface CredentialStore {
    /**
     * Null when nothing is stored (not paired). Throws when something is stored but cannot be
     * read, so a Keystore failure is never mistaken for "not paired".
     */
    fun load(): PairedMac?

    fun save(mac: PairedMac)

    fun clear()
}

/** A store in memory, for tests and previews. */
class MemoryCredentialStore(mac: PairedMac? = null) : CredentialStore {
    private val lock = Any()
    private var stored: PairedMac? = mac

    override fun load(): PairedMac? = synchronized(lock) { stored }
    override fun save(mac: PairedMac) = synchronized(lock) { stored = mac }
    override fun clear() = synchronized(lock) { stored = null }
}
