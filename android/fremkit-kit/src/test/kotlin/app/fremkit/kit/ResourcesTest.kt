package app.fremkit.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** The two files the kit reads from outside android/ reach it where the build says they do. */
class ResourcesTest {
    @Test
    fun fingerprintWordsAreAMainResource() {
        val words = javaClass.getResourceAsStream("/fingerprint-words.txt")
        assertNotNull("fingerprint-words.txt is not on the kit's classpath", words)
        val lines = words!!.bufferedReader().readLines().filter { it.isNotBlank() }
        assertEquals(256, lines.size)
    }

    @Test
    fun sharedVectorsAreATestResource() {
        val vectors = javaClass.getResourceAsStream("/devices.json")
        // test-vectors/devices.json arrives with the shared-vectors stage; until it is merged
        // there is nothing to read, and the kit's real tests (which need it) do not exist yet.
        assumeTrue("test-vectors/devices.json is not in this tree yet", vectors != null)
        val text = vectors!!.bufferedReader().readText()
        assertTrue("devices.json has no version", text.contains("\"version\""))
    }
}
