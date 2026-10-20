package app.fremkit.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Every app string exists in English and in French, with the same placeholders: the rule the
 * admin's locales keep (`ui/test`'s parity test), for the app's `strings.xml`.
 */
class StringsParityTest {
    private fun strings(folder: String): Map<String, String> {
        val file = File("src/main/res/$folder/strings.xml")
        assertTrue("missing $file", file.isFile)
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = doc.getElementsByTagName("string")
        return (0 until nodes.length).associate { i ->
            val node = nodes.item(i)
            node.attributes.getNamedItem("name").nodeValue to node.textContent
        }
    }

    private val english = strings("values")
    private val french = strings("values-fr")

    @Test
    fun sameKeysInBothLanguages() {
        assertEquals("keys only in English", emptySet<String>(), english.keys - french.keys)
        assertEquals("keys only in French", emptySet<String>(), french.keys - english.keys)
    }

    @Test
    fun samePlaceholders() {
        val placeholder = Regex("""%\d+\$[sd]""")
        for ((key, text) in english) {
            val en = placeholder.findAll(text).map { it.value }.sorted().toList()
            val fr = placeholder.findAll(french.getValue(key)).map { it.value }.sorted().toList()
            assertEquals("placeholders of $key", en, fr)
        }
    }

    @Test
    fun frenchSaysAppairer() {
        for ((key, text) in french) assertFalse("$key says « jumeler »", text.contains("jumel", ignoreCase = true))
    }

    @Test
    fun noStringIsEmpty() {
        for ((key, text) in english + french.mapKeys { "fr:" + it.key }) assertTrue("$key is empty", text.isNotBlank())
    }
}
