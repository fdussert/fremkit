package app.fremkit.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The merged debug manifest (what the APK carries once every library has added its part) and the
 * XML it points to: the Android side of "the data folder is 0700 and its files 0600" (app-private,
 * out of every backup), no cleartext, no user CAs, no Safe Browsing or metrics, and no permission
 * the app does not need.
 */
class ManifestTest {
    private val ns = "http://schemas.android.com/apk/res/android"

    private fun parse(file: File): Document {
        assertTrue("missing $file", file.isFile)
        return DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(file)
    }

    private val manifest: Document = parse(
        File(System.getProperty("fremkit.mergedManifest") ?: error("fremkit.mergedManifest is not set")),
    )
    private val application = manifest.getElementsByTagName("application").item(0) as Element

    private fun xml(attribute: String): Document {
        val ref = application.getAttributeNS(ns, attribute)
        assertTrue("$attribute is not set", ref.startsWith("@xml/"))
        return parse(File("src/main/res/xml/${ref.removePrefix("@xml/")}.xml"))
    }

    private fun elements(doc: Document, tag: String): List<Element> =
        doc.getElementsByTagName(tag).let { list -> (0 until list.length).map { list.item(it) as Element } }

    @Test
    fun noBackup() {
        assertEquals("false", application.getAttributeNS(ns, "allowBackup"))
    }

    @Test
    fun backupRulesExcludeEverything() {
        val domains = setOf("root", "file", "database", "sharedpref", "external")
        val full = xml("fullBackupContent")
        assertEquals(emptyList<Element>(), elements(full, "include"))
        assertEquals(domains, elements(full, "exclude").filter { it.getAttribute("path") == "." }.map { it.getAttribute("domain") }.toSet())

        val extraction = xml("dataExtractionRules")
        assertEquals(emptyList<Element>(), elements(extraction, "include"))
        for (section in listOf("cloud-backup", "device-transfer")) {
            val node = elements(extraction, section).single()
            assertEquals("$section excludes", domains,
                elements(node.ownerDocument, "exclude").filter { it.parentNode == node && it.getAttribute("path") == "." }
                    .map { it.getAttribute("domain") }.toSet())
        }
    }

    @Test
    fun noCleartextAndSystemAnchorsOnly() {
        assertTrue(application.getAttributeNS(ns, "usesCleartextTraffic") != "true")
        val config = xml("networkSecurityConfig")
        val base = elements(config, "base-config").single()
        assertEquals("false", base.getAttribute("cleartextTrafficPermitted"))
        assertEquals(listOf("system"), elements(config, "certificates").map { it.getAttribute("src") })
        assertEquals(emptyList<Element>(), elements(config, "domain-config"))
        assertEquals(emptyList<Element>(), elements(config, "debug-overrides"))
    }

    @Test
    fun noSafeBrowsingNorMetrics() {
        val meta = elements(manifest, "meta-data").associate { it.getAttributeNS(ns, "name") to it.getAttributeNS(ns, "value") }
        assertEquals("false", meta["android.webkit.WebView.EnableSafeBrowsing"])
        assertEquals("true", meta["android.webkit.WebView.MetricsOptOut"])
    }

    @Test
    fun onlyTheNeededPermissions() {
        val requested = elements(manifest, "uses-permission").map { it.getAttributeNS(ns, "name") }.toSet()
        // AndroidX core declares its own signature permission for unexported dynamic receivers.
        val own = requested.filter { it.endsWith(".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION") }.toSet()
        assertEquals(
            setOf(
                "android.permission.INTERNET",
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.CAMERA",
                "android.permission.CHANGE_WIFI_MULTICAST_STATE",
            ),
            requested - own,
        )
    }

    @Test
    fun oneActivityThatSurvivesConfigurationChanges() {
        val activity = elements(manifest, "activity").single { it.getAttributeNS(ns, "name").endsWith(".MainActivity") }
        assertEquals("singleTask", activity.getAttributeNS(ns, "launchMode"))
        val changes = activity.getAttributeNS(ns, "configChanges").split("|").toSet()
        for (c in listOf("orientation", "screenSize", "screenLayout", "smallestScreenSize", "density", "keyboard", "keyboardHidden", "uiMode")) {
            assertTrue("configChanges lacks $c", c in changes)
        }
        assertNotNull(application.getAttributeNS(ns, "localeConfig").takeIf { it.isNotEmpty() })
    }

    @Test
    fun theCameraIsOptional() {
        val camera = elements(manifest, "uses-feature").single { it.getAttributeNS(ns, "name") == "android.hardware.camera.any" }
        assertEquals("false", camera.getAttributeNS(ns, "required"))
        // Nothing may make a camera required behind our back (a library's manifest).
        assertTrue(elements(manifest, "uses-feature").none { it.getAttributeNS(ns, "required") != "false" })
    }

    @Test
    fun pairingLinksOpenTheActivity() {
        val activity = elements(manifest, "activity").single { it.getAttributeNS(ns, "name").endsWith(".MainActivity") }
        val filter = elements(manifest, "intent-filter").single { f ->
            f.parentNode == activity && elements(manifest, "data").any { it.parentNode == f }
        }
        val data = elements(manifest, "data").filter { it.parentNode == filter }
        assertEquals(listOf("fremkit" to "pair"), data.map { it.getAttributeNS(ns, "scheme") to it.getAttributeNS(ns, "host") })
        val actions = elements(manifest, "action").filter { it.parentNode == filter }.map { it.getAttributeNS(ns, "name") }
        assertEquals(listOf("android.intent.action.VIEW"), actions)
    }

    @Test
    fun theRestartHelperRunsInItsOwnProcessAndIsNotExported() {
        val activity = elements(manifest, "activity").single { it.getAttributeNS(ns, "name").endsWith(".RestartActivity") }
        assertEquals(ProcessRestart.PROCESS_SUFFIX, activity.getAttributeNS(ns, "process"))
        assertEquals("false", activity.getAttributeNS(ns, "exported"))
    }
}
