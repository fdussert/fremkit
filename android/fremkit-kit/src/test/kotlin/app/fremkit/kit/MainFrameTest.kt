package app.fremkit.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The shared `mainFrames` vectors (test-vectors/devices.json): `MainFrameTests`. */
class MainFrameTest {
    private fun check(vararg whys: String) {
        val vectors = Vectors.all.mainFrames.navigations.filter { it.why in whys }
        assertFalse("no shared vector for ${whys.toList()}", vectors.isEmpty())
        for (v in vectors) {
            assertEquals("${v.url} on ${v.host}:${v.port}", v.allowed, Dashboard.allowsMainFrame(v.url, v.host, v.port))
        }
    }

    @Test
    fun allowsTheMacsOwnOrigin() = check("the Mac's own origin")

    @Test
    fun refusesAnyOtherOrigin() {
        check("any other origin", "no URL")
        assertEquals(
            setOf("the Mac's own origin", "any other origin", "no URL"),
            Vectors.all.mainFrames.navigations.map { it.why }.toSet(),
        )
    }

    @Test
    fun hearsThePageFromItsOwnOriginOnly() {
        val vectors = Vectors.all.mainFrames.pageOrigins
        assertFalse(vectors.isEmpty())
        for (v in vectors) {
            assertEquals(
                "${v.scheme}://${v.originHost}:${v.originPort} for ${v.host}:${v.port}",
                v.heard, Dashboard.isPageOrigin(v.scheme, v.originHost, v.originPort, v.host, v.port),
            )
        }
    }

    @Test
    fun anAndroidOriginWithNoPortIsTheSchemesDefault() {
        // Not shared: `Uri.getPort()` says -1 where `WKSecurityOrigin` says 0.
        assertTrue(Dashboard.isPageOrigin("https", "example.local", -1, "example.local", 443))
        assertFalse(Dashboard.isPageOrigin("https", "example.local", -1, "example.local", 4243))
        assertTrue(Dashboard.isPageOrigin("https", "[fe80::1%25en0]", 4243, "fe80::1%en0", 4243))
    }
}
