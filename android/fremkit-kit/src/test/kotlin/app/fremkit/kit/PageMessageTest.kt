package app.fremkit.kit

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** `PageMessageTests` (in the Swift kit's AppModelTests.swift), on the shared `pageMessages` vectors. */
class PageMessageTest {
    /** The page's message as the shared vectors spell it, null for one the app ignores. */
    private fun expected(e: JsonElement?): PageMessage? {
        val o = e as? JsonObject ?: return null
        return when (o["type"]?.jsonPrimitive?.content) {
            "unauthorized" -> PageMessage.Unauthorized
            "screen" -> PageMessage.Screen(o["screenId"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content)
            "brightness" -> PageMessage.Brightness(o["target"]!!.jsonPrimitive.double, o["seq"]!!.jsonPrimitive.int)
            else -> null
        }
    }

    // The Android channel carries the string the page wrote with `JSON.stringify`.
    @Test
    fun readsWhatThePagePosts() {
        val accepted = Vectors.all.pageMessages.filter { it.expect != null && it.expect !is JsonNull }
        assertFalse(accepted.isEmpty())
        for (v in accepted) {
            assertEquals(v.body.toString(), expected(v.expect), PageMessage.parse(v.body.toString()))
        }
    }

    @Test
    fun ignoresAnythingElse() {
        val ignored = Vectors.all.pageMessages.filter { it.expect == null || it.expect is JsonNull }
        assertFalse(ignored.isEmpty())
        for (v in ignored) {
            assertNull(v.body.toString(), PageMessage.parse(v.body.toString()))
        }
    }

    @Test
    fun ignoresWhatIsNotAJsonObjectOrHasTheWrongTypes() {
        // Not shared: what only a string channel can carry, and booleans where numbers go.
        for (json in listOf("", "not json", "[]", "null", "42", """{"type":1}""", """{"type":"brightness","target":true,"seq":1}""",
            """{"type":"brightness","target":40,"seq":false}""", """{"type":"brightness","target":40,"seq":1e20}""",
            """{"type":"brightness","target":-1,"seq":1}""", """{"type":"brightness","target":40}""")) {
            assertNull(json, PageMessage.parse(json))
        }
        assertEquals(PageMessage.Brightness(0.0, 2), PageMessage.parse("""{"type":"brightness","target":0,"seq":2.0}"""))
    }

    // Not shared: the iPad app ignores it (the page offers the entry in the Android app only).
    @Test
    fun readsTheSettingsRequest() {
        assertEquals(PageMessage.Settings, PageMessage.parse("""{"type":"settings"}"""))
        assertEquals(PageMessage.Settings, PageMessage.parse("""{"type":"settings","extra":1}"""))
        assertNull(PageMessage.parse("""{"type":"Settings"}"""))
        assertNull(PageMessage.parse("\"settings\""))
    }

    @Test
    fun theDashboardUrlAndTheMacName() {
        assertEquals("https://192.0.2.10:4243/", Dashboard.url("192.0.2.10", 4243))
        assertEquals("https://[fe80::1%25en0]:4243/", Dashboard.url("fe80::1%en0", 4243))
        assertEquals("fremkit_device", Dashboard.COOKIE_NAME)
        val link = PairingLink(host = "studio.local", address = "192.0.2.10", port = 4243, code = "ABCDEFGH", keyHash = SpkiFixture.keyHash)
        assertEquals("studio", link.macName)
        assertEquals("studio", link.copy(host = "Studio.LOCAL").macName.lowercase())
    }

    @Test
    fun thePinCoversTheHostInUseTheNameAndTheAddressOnly() {
        val mac = PairedMac(
            host = "Studio.local.", address = "192.0.2.10", port = 4243, keyHash = SpkiFixture.keyHash,
            token = "t", deviceId = "d1", name = "studio",
        )
        assertEquals(setOf("fe80::1%en0", "studio.local", "192.0.2.10"), Dashboard.pinnedHosts(mac, "[FE80::1%25en0]"))
        assertEquals(setOf("studio.local", "192.0.2.10"), Dashboard.pinnedHosts(mac, "192.0.2.10"))
    }

    @Test
    fun theDashboardUrlIsAllowedAsTheMainFrame() {
        for (host in listOf("studio.local", "192.0.2.10", "fe80::1%en0")) {
            assertEquals(host, true, Dashboard.allowsMainFrame(Dashboard.url(host, 4243), host, 4243))
        }
    }
}
