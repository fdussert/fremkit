package app.fremkit.kit

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.PrintWriter
import java.io.StringWriter

/** No secret, token or pin in anything the kit prints or throws. */
class RedactionTest {
    private val token = "device-token"

    @Test
    fun printingAPairingNeverShowsTheTokenOrKey() {
        val text = "$sampleMac ${listOf(sampleMac)} ${mapOf("mac" to sampleMac)}"
        assertFalse(text.contains(token))
        assertFalse(text.contains(SpkiFixture.keyHash))
        assertTrue(text.contains("studio.local"))
        assertTrue(text.contains("d1"))
    }

    @Test
    fun printingALinkNeverShowsItsCodeKeyOrSecret() {
        val secret = Vectors.all.pairingLinks.firstNotNullOf { it.expect?.secret }
        val link = PairingLink("studio.local", "192.0.2.10", 4243, "ABCDEFGH", SpkiFixture.keyHash, secret)
        val text = "$link ${listOf(link)}"
        for (hidden in listOf("ABCDEFGH", SpkiFixture.keyHash, secret)) assertFalse(text.contains(hidden))
        assertTrue(text.contains("studio.local"))
    }

    /** Everything a log line could show of an exception: messages, causes, stack trace. */
    private fun everything(error: Throwable): String {
        val out = StringWriter()
        error.printStackTrace(PrintWriter(out))
        return "$error ${error.message} ${error.localizedMessage} ${error.cause} $out"
    }

    private fun unreadable(json: String): Throwable {
        try {
            PairedMac.fromJson(json)
        } catch (e: UnreadableCredentialsException) {
            return e
        }
        fail("read: a record that should not be")
        error("unreachable")
    }

    @Test
    fun anUnreadableRecordNeverQuotesItsToken() {
        val stored = sampleMac.toJson()
        // kotlinx.serialization quotes the input around the error: each of these would carry the
        // token into the message if the kit let its exception through.
        val broken = listOf(
            stored.dropLast(1),                                                   // truncated
            stored.replace("\"port\":4243", "\"port\":\"x\""),                      // a field of the wrong type
            stored.replace("\"name\":\"studio\"", "\"name\":studio"),              // an unquoted value
            "$stored trailing",                                                   // garbage after the record
            stored.replace("\"deviceId\":\"d1\",", ""),                           // a missing field
            stored.replace("\"token\":\"$token\"", "\"token\":[\"$token\"]"),      // the token itself malformed
        )
        for (json in broken) {
            assertTrue("the case does carry the token", json.contains(token))
            val text = everything(unreadable(json))
            assertFalse("the token leaked from: $json", text.contains(token))
            assertFalse(text.contains(SpkiFixture.keyHash))
        }
    }

    @Test
    fun anUnreadableRecordKeepsNoCause() {
        // A cause would print its own message, which is where the input is quoted.
        val e = unreadable(sampleMac.toJson().dropLast(1))
        assertTrue(e.cause == null && e.suppressed.isEmpty())
    }
}
