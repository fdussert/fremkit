package app.fremkit.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** The shared `subframes` vectors (test-vectors/devices.json), group by group: `SubframeTests`. */
class SubframeTest {
    private fun check(vararg whys: String) {
        val vectors = Vectors.all.subframes.filter { it.why in whys }
        assertFalse("no shared vector for ${whys.toList()}", vectors.isEmpty())
        for (v in vectors) {
            assertEquals("${v.url} on ${v.host}:${v.port}", v.allowed, Dashboard.allowsSubframe(v.url, v.host, v.port))
        }
    }

    @Test
    fun everySharedVectorIsInAGroupThisFileChecks() {
        val groups = setOf(
            "the Mac's widgets", "anything else", "where an earlier rule and the Mac's WidgetFrames disagreed",
            "no URL", "WidgetFrames: a widget document on the same origin",
            "WidgetFrames: everything else", "WidgetFrames: the page's own origin",
        )
        assertEquals(groups, Vectors.all.subframes.map { it.why }.toSet())
    }

    @Test
    fun allowsTheMacsWidgets() = check("the Mac's widgets")

    @Test
    fun refusesAnythingElse() =
        // Where the earlier rule and the Mac's `WidgetFrames` disagreed, the Mac's answer wins.
        check("anything else", "where an earlier rule and the Mac's WidgetFrames disagreed", "no URL")

    // `WidgetFramesTests` (native/Tests/FremkitCoreTests), case for case, on the tablet's origin:
    // `http://127.0.0.1:4242` becomes `https://studio.local:4243`, and its other-origin cases
    // (another port, another name for the same host, another scheme) keep their meaning.

    @Test
    fun widgetFramesAllowsAWidgetDocumentOnTheSameOrigin() = check("WidgetFrames: a widget document on the same origin")

    @Test
    fun widgetFramesRefusesEverythingElse() = check("WidgetFrames: everything else", "no URL")

    @Test
    fun widgetFramesFollowsThePagesOwnOrigin() = check("WidgetFrames: the page's own origin")

    @Test
    fun refusesWhatJavaNetUriCannotParse() {
        // Not shared: a URL the parser refuses is refused, never guessed at.
        assertFalse(Dashboard.allowsSubframe("https://studio.local:4243/widgets/a%ZZ", "studio.local", 4243))
        assertFalse(Dashboard.allowsSubframe("https://studio.local:4243/widgets/a b", "studio.local", 4243))
        assertFalse(Dashboard.allowsSubframe("", "studio.local", 4243))
    }
}
