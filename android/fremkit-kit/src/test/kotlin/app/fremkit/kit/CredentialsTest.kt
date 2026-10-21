package app.fremkit.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

/** The paired Mac the kit's tests share (generic values: a documentation-range address). */
val sampleMac = PairedMac(
    host = "studio.local", address = "192.0.2.10", port = 4243, keyHash = SpkiFixture.keyHash,
    token = "device-token", deviceId = "d1", name = "studio",
)

class CredentialsTest {
    /** The paired Mac with two other addresses it listed earlier (RFC 1918, generic values). */
    private val macWithAddresses = sampleMac.updating(addresses = listOf("192.168.1.20", "172.16.4.2"))

    @Test
    fun memoryStoreSavesLoadsAndClears() {
        val store = MemoryCredentialStore()
        assertNull(store.load())
        store.save(sampleMac)
        assertEquals(sampleMac, store.load())
        store.clear()
        assertNull(store.load())
    }

    @Test
    fun pairedMacRoundTripsThroughJson() {
        assertEquals(sampleMac, PairedMac.fromJson(sampleMac.toJson()))
    }

    @Test
    fun aPairingStoredBeforeAddressesStillLoads() {
        val legacy = """{"host":"studio.local","address":"192.0.2.10","port":4243,"keyHash":"${SpkiFixture.keyHash}","token":"device-token","deviceId":"d1","name":"studio"}"""
        val mac = PairedMac.fromJson(legacy)
        assertEquals(sampleMac, mac)
        assertEquals(emptyList<String>(), mac.addresses)
    }

    @Test
    fun theAddressesAreStoredWithThePairing() {
        val back = PairedMac.fromJson(macWithAddresses.toJson())
        assertEquals(listOf("192.168.1.20", "172.16.4.2"), back.addresses)
        assertEquals(macWithAddresses, back)
    }

    @Test
    fun updatingAddressesCleansDedupesAndCaps() {
        val updated = sampleMac.updating(
            addresses = listOf("192.168.1.20", "192.168.1.20", "198.51.100.7", "fd00::1") + (1..10).map { "10.9.2.$it" },
        )
        assertEquals(listOf("192.168.1.20") + (1..7).map { "10.9.2.$it" }, updated.addresses)
        assertEquals(sampleMac.token, updated.token)
        assertEquals(sampleMac.keyHash, updated.keyHash)
        assertEquals(sampleMac.address, updated.address)
    }

    // Kotlin only.

    @Test
    fun theStoredFormatHasTheSwiftKeys() {
        val keys = Json.parseToJsonElement(macWithAddresses.toJson()).jsonObject.keys
        assertEquals(setOf("host", "address", "port", "keyHash", "token", "deviceId", "name", "addresses"), keys)
    }

    @Test
    fun addressesThatAreNotAListOfStringsGiveNone() {
        val base = sampleMac.toJson().removeSuffix("}")
        for (value in listOf("null", "\"10.20.30.40\"", "42", "{}", "[\"10.20.30.40\", 42]", "[null]")) {
            assertEquals(value, emptyList<String>(), PairedMac.fromJson("""$base,"addresses":$value}""").addresses)
        }
    }

    @Test
    fun theConstructorCleansTheAddresses() {
        val mac = PairedMac("studio.local", "192.0.2.10", 4243, SpkiFixture.keyHash, "device-token", "d1", "studio",
            addresses = listOf("10.20.30.40", "198.51.100.7", "fd00::1", "studio.local", "10.1.2.3 ", "10.20.30.40"))
        assertEquals(listOf("10.20.30.40"), mac.addresses)
        val stored = sampleMac.toJson().removeSuffix("}") + ""","addresses":["203.0.113.5","172.31.255.254"]}"""
        assertEquals(listOf("172.31.255.254"), PairedMac.fromJson(stored).addresses)
        assertEquals(PairedMac.MAX_ADDRESSES, 8)
    }

    @Test
    fun updatingTheAddressTakesAnIPLiteralOnly() {
        assertEquals("198.51.100.7", sampleMac.updating(address = "198.51.100.7").address)
        assertEquals("2001:db8::1", sampleMac.updating(address = "2001:db8::1").address)
        // A name that answered changes nothing: `host` already is that name.
        assertSame(sampleMac, sampleMac.updating(address = "studio.local"))
        assertEquals(sampleMac.token, sampleMac.updating(address = "198.51.100.7").token)
    }

    @Test
    fun unknownKeysAreIgnored() {
        val newer = sampleMac.toJson().removeSuffix("}") + ""","somethingNew":{"a":1}}"""
        assertEquals(sampleMac, PairedMac.fromJson(newer))
    }

    @Test
    fun aRecordMissingAFieldIsUnreadable() {
        for (field in listOf("host", "address", "port", "keyHash", "token", "deviceId", "name")) {
            val without = JsonObject(Json.parseToJsonElement(sampleMac.toJson()).jsonObject - field).toString()
            assertThrows(field, UnreadableCredentialsException::class.java) { PairedMac.fromJson(without) }
        }
        assertThrows(UnreadableCredentialsException::class.java) { PairedMac.fromJson("") }
        assertThrows(UnreadableCredentialsException::class.java) { PairedMac.fromJson("[]") }
    }

    @Test
    fun equalityCoversEveryField() {
        val variants = listOf(
            sampleMac.copyWith(host = "other.local"), sampleMac.copyWith(address = "192.0.2.11"),
            sampleMac.copyWith(port = 4244), sampleMac.copyWith(keyHash = "x"), sampleMac.copyWith(token = "t"),
            sampleMac.copyWith(deviceId = "d2"), sampleMac.copyWith(name = "n"), macWithAddresses,
        )
        for (v in variants) assertNotEquals(sampleMac, v)
        assertEquals(sampleMac.hashCode(), sampleMac.copyWith().hashCode())
        assertEquals(sampleMac, sampleMac.copyWith())
    }

    private fun PairedMac.copyWith(
        host: String = this.host, address: String = this.address, port: Int = this.port, keyHash: String = this.keyHash,
        token: String = this.token, deviceId: String = this.deviceId, name: String = this.name,
    ) = PairedMac(host, address, port, keyHash, token, deviceId, name, addresses)
}
