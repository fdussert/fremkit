package app.fremkit.kit

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `Dashboard.isNavigationRequest`, on the `Accept` headers the spike's WebView sent to
 * `shouldInterceptRequest` (android/spike evidence, q6-q8): an iframe's document load against the
 * page's subresources. No Swift counterpart: WebKit tells frames apart by itself.
 */
class NavigationRequestTest {
    private val document =
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"

    @Test
    fun aFramesDocumentLoadIsANavigation() {
        assertTrue(Dashboard.isNavigationRequest(document))
    }

    @Test
    fun theHeaderIsReadWithoutCaseOrSpacing() {
        assertTrue(Dashboard.isNavigationRequest("Text/HTML, application/XHTML+xml, */*;q=0.8"))
        assertTrue(Dashboard.isNavigationRequest("text/html;charset=utf-8,application/xhtml+xml"))
    }

    @Test
    fun subresourcesAreNot() {
        for (accept in listOf("*/*", "text/css,*/*;q=0.1", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", "application/json")) {
            assertFalse(accept, Dashboard.isNavigationRequest(accept))
        }
    }

    @Test
    fun noHeaderOrAnHtmlOnlyHeaderIsNot() {
        assertFalse(Dashboard.isNavigationRequest(null))
        assertFalse(Dashboard.isNavigationRequest(""))
        assertFalse(Dashboard.isNavigationRequest("text/html"))
        assertFalse(Dashboard.isNavigationRequest("application/xhtml+xml,text/html"))
    }
}
