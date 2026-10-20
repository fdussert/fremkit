package app.fremkit.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.security.MessageDigest

/** `FingerprintTests` (in the Swift kit's PinTests.swift), on the shared `fingerprint` vectors. */
class FingerprintTest {
    @Test
    fun listHashMatchesTheServerConstant() {
        assertEquals(Vectors.all.fingerprint.listSha256, Fingerprint.LIST_SHA256)
    }

    @Test
    fun bundledListHashesToTheConstant() {
        val stream = javaClass.getResourceAsStream("/fingerprint-words.txt")
        assertNotNull("fingerprint-words.txt is not on the classpath", stream)
        val digest = MessageDigest.getInstance("SHA-256").digest(stream!!.use { it.readBytes() })
        assertEquals(Fingerprint.LIST_SHA256, digest.joinToString("") { "%02x".format(it) })
        assertEquals(Vectors.all.fingerprint.listLength, Fingerprint.list.size)
    }

    @Test
    fun mapsTheFirstFourBytesToWords() {
        // The shared vectors, which server/test/devices-fingerprint.test.ts reads too.
        val cases = Vectors.all.fingerprint.cases
        assert(cases.isNotEmpty())
        for (vector in cases) {
            assertEquals(vector.keyHash, base64UrlEncode(hex(vector.bytesHex)))
            assertEquals(vector.words, Fingerprint.words(vector.keyHash))
        }
    }

    @Test
    fun givesNoWordsForAHashShorterThanFourBytes() {
        // Where the server throws, the app shows no words.
        for (keyHash in Vectors.all.fingerprint.tooShort) {
            assertEquals(keyHash, emptyList<String>(), Fingerprint.words(keyHash))
        }
        // Not shared: Node's base64url decoder skips the characters it does not know.
        assertEquals(emptyList<String>(), Fingerprint.words("not base64!"))
    }

    @Test
    fun readsOnlyTheFirstFourBytesOfAFullHash() {
        // A real pin is 32 bytes; the words come from its first four, whatever follows.
        val words = Fingerprint.words(SpkiFixture.keyHash)
        assertEquals(4, words.size)
        val first = SpkiFixture.keyHash.let { base64UrlDecode(it)!! }.copyOf(4)
        assertEquals(first.map { Fingerprint.list[it.toInt() and 0xff] }, words)
    }

    @Test
    fun aListThatDoesNotHashToTheConstantStopsTheApp() {
        val error = runCatching { Fingerprint.checked("aardvark\n".toByteArray()) }.exceptionOrNull()
        assertNotNull("a wrong list was accepted", error)
        assert(error is IllegalStateException)
    }
}
