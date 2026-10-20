package app.fremkit.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The kit stays a plain JVM library: no `android.*` anywhere in its sources, so every test runs
 * on any JVM and the app is the only place Android APIs are used. A source scan, since a
 * compile-time check would need the Android jar on the kit's classpath to fail on.
 */
class ArchitectureTest {
    /** Gradle runs a module's tests from the module's folder. */
    private val main = File("src/main/kotlin")

    private val sources: List<File> by lazy {
        main.walkTopDown().filter { it.isFile && it.extension in setOf("kt", "java") }.toList()
    }

    @Test
    fun theScanSeesTheKitsSources() {
        assertTrue("no sources under ${main.absolutePath}", sources.any { it.name == "PairingLink.kt" })
    }

    /** An import, or a fully qualified name in code (`android.util.Log.d(…)`); comments skipped. */
    private val android = Regex("""(^|[^\w.])(android|androidx)\.[a-z]""")

    /** A line's code, without a line comment; nothing for a line of a block comment. */
    private fun code(line: String): String {
        val code = line.substringBefore("//").trimStart()
        return if (code.startsWith("*") || code.startsWith("/*")) "" else code
    }

    private fun usesAndroid(line: String): Boolean = android.containsMatchIn(code(line))

    @Test
    fun theScanCatchesAnImportAndAQualifiedCall() {
        // Spelled in two halves so `grep -rn "import android\." android/fremkit-kit` stays empty.
        val a = "android"
        assertTrue(usesAndroid("import $a.util.Log"))
        assertTrue(usesAndroid("import ${a}x.annotation.Keep"))
        assertTrue(usesAndroid("        $a.util.Log.d(\"tag\", text)"))
        assertTrue(!usesAndroid("// android.util.Log is the app's business"))
        assertTrue(!usesAndroid(" * see android.webkit.WebView"))
        assertTrue(!usesAndroid("val x = app.fremkit.android.Thing"))
    }

    @Test
    fun noKitSourceUsesAndroid() {
        val offenders = sources.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line -> if (usesAndroid(line)) "${file.name}:${i + 1}: ${line.trim()}" else null }
        }
        assertEquals("the kit must not use Android APIs", emptyList<String>(), offenders)
    }

    @Test
    fun theAddressParserNeverResolvesANameOrDelegatesToTheJdk() {
        // InetAddress.getByName takes spellings inet_pton refuses and may ask the DNS.
        val lines = File(main, "app/fremkit/kit/PairingLink.kt").readLines()
        assertTrue("PairingLink.kt uses InetAddress", lines.none { "InetAddress" in code(it) })
    }
}
