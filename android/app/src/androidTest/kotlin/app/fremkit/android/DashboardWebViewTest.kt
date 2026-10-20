package app.fremkit.android

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.fremkit.kit.Exchange
import app.fremkit.kit.PageMessage
import app.fremkit.kit.PairedMac
import app.fremkit.kit.PinPolicy
import app.fremkit.kit.PinnedTransport
import app.fremkit.kit.Request
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The dashboard's WebView against a real TLS server on the Mac's LAN address
 * (`scripts/android-test-server.mjs`, started by `scripts/build-android.sh device-test`, which
 * passes its address, ports and the pins of its two throwaway keys as instrumentation arguments).
 * Without them, every test here is skipped.
 *
 * The pages report what they found through the app's own listener (`fremkit.postMessage` of a
 * `screen` message, which [PageMessage.parse] reads), and the server reports what reached it
 * (`/seen`), so each test checks both sides: what the page could do, and what left the tablet.
 */
@RunWith(AndroidJUnit4::class)
class DashboardWebViewTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val args = InstrumentationRegistry.getArguments()

    private lateinit var host: String
    private var mainPort = 0
    private var otherPort = 0
    private var wrongPort = 0
    private lateinit var pinA: String
    private lateinit var pinB: String

    private val views = mutableListOf<DashboardWebView>()

    /** A made-up token: public test data, nothing a Mac ever issued. */
    private val token = "device-test-token-not-a-secret"

    @Before
    fun setUp() {
        val h = args.getString("fremkitTestHost")
        assumeTrue("no test server (run scripts/build-android.sh device-test)", h != null)
        host = h!!
        mainPort = args.getString("fremkitTestMainPort")!!.toInt()
        otherPort = args.getString("fremkitTestOtherPort")!!.toInt()
        wrongPort = args.getString("fremkitTestWrongPort")!!.toInt()
        pinA = args.getString("fremkitTestPinA")!!
        pinB = args.getString("fremkitTestPinB")!!
        // Every test starts as a new process would: no SSL decision, no cookie.
        onMain {
            val hygiene = WebViewHygiene()
            val web = android.webkit.WebView(context)
            hygiene.prepare(web)
            web.destroy()
        }
        clearCookies()
    }

    @After
    fun tearDown() {
        onMain { views.forEach(DashboardWebView::destroy) }
    }

    // --- The pin ---------------------------------------------------------------------------------

    @Test
    fun pinnedLoadCarriesTheCookieAndOpensTheSocket() {
        reset("basic")
        val page = open(mainPort, pinA)
        page.awaitMessage("loaded:cookie=yes")
        page.awaitMessage("ws:open")
        assertEquals(0, page.failures.get())
        val requests = seen()
        assertTrue(requests.any { it.port == mainPort && it.path == "/" && it.cookie })
        assertTrue(requests.any { it.port == mainPort && it.ws && it.cookie })
    }

    @Test
    fun aWrongKeyIsRefusedBeforeAnythingIsSent() {
        reset("basic")
        val page = open(wrongPort, pinA)
        page.awaitFailure()
        page.assertNoMessage("loaded", 1500)
        assertEquals("the wrong-key server saw a request", emptyList<Seen>(), seen().filter { it.port == wrongPort })
    }

    @Test
    fun aWrongKeyRefusesTheWebSocketToo() {
        reset("wss-wrong")
        val page = open(mainPort, pinA)
        page.awaitMessage("loaded")
        page.awaitMessage("ws:error")
        assertFalse(page.saw("ws:open"))
        assertEquals(emptyList<Seen>(), seen().filter { it.port == wrongPort })
        // The page's own host refused a key: the dashboard is not to be trusted any more.
        page.awaitFailure()
    }

    @Test
    fun aPinChangeClearsTheRememberedDecision() {
        val hygiene = WebViewHygiene()
        reset("basic")
        open(mainPort, pinA, hygiene).awaitMessage("loaded:cookie=yes")

        // Without the clear, WebView reuses the proceed() taken under the old pin, in any instance,
        // for a pin that would refuse this key. Checked first so the next part proves something.
        reset("basic")
        val stale = open(mainPort, pinB, hygiene)
        val reused = stale.waitFor("loaded:cookie=yes", 8000)
        // Its favicon request comes after the page; let it land before the views go.
        SystemClock.sleep(1000)
        assumeTrue("this WebView does not remember proceed() across instances", reused)

        // The app's path on a pin change: the old WebView goes, and the next one starts with no
        // remembered decision.
        onMain {
            views.forEach(DashboardWebView::destroy)
            hygiene.pinChanged()
        }
        clearCookies()
        reset("basic")
        val fresh = open(mainPort, pinB, hygiene)
        fresh.awaitFailure()
        fresh.assertNoMessage("loaded:cookie=yes", 1500)
        assertEquals(emptyList<Seen>(), seen().filter { it.port == mainPort })
    }

    // --- The main frame and the frames -----------------------------------------------------------

    @Test
    fun theMainFrameCannotNavigateElsewhere() {
        reset("nav-get")
        val page = open(mainPort, pinA)
        page.awaitMessage("loaded")
        page.awaitMessage("still-here")
        assertEquals(emptyList<Seen>(), seen().filter { it.port == otherPort })
    }

    @Test
    fun theMainFrameCannotPostElsewhere() {
        reset("nav-post")
        val page = open(mainPort, pinA)
        page.awaitMessage("loaded")
        // The POST navigation never reaches shouldOverrideUrlLoading: shouldInterceptRequest answers
        // it with an empty 403, which leaves no page to show.
        page.awaitFailure()
        assertEquals(emptyList<Seen>(), seen().filter { it.port == otherPort })
    }

    @Test
    fun framesLoadWidgetsOnlyAndAreNotHeard() {
        reset("frames")
        val page = open(mainPort, pinA)
        page.awaitMessage("loaded")
        // The widget frame loaded, and the listener was reachable from it (same origin)...
        page.awaitMessage("frame-loaded:ok:object")
        page.awaitMessage("from-main")
        // ...but what it posted there was dropped: only the main frame speaks for the page.
        assertFalse("a frame's message was heard", page.saw("from-frame"))
        val paths = seen().filter { it.port == mainPort }.map { it.path }
        assertTrue(paths.toString(), "/widgets/ok/index.html" in paths)
        assertFalse(paths.toString(), "/admin" in paths)
        assertFalse(paths.toString(), "/notwidget.html" in paths)
        assertFalse(paths.toString(), paths.any { it.contains("%2e", ignoreCase = true) || it.contains("..") })
        assertEquals(0, page.failures.get())
    }

    @Test
    fun noCameraNorMicrophone() {
        reset("gum")
        val page = open(mainPort, pinA)
        page.awaitMessage("loaded")
        val result = page.awaitPrefix("gum:")
        assertTrue(result, result.startsWith("gum:rejected:"))
    }

    // --- Harness ---------------------------------------------------------------------------------

    private inner class Page {
        val messages = CopyOnWriteArrayList<String>()
        val failures = AtomicInteger()
        lateinit var dashboard: DashboardWebView

        fun saw(id: String) = id in messages

        fun waitFor(id: String, timeoutMillis: Long = TIMEOUT): Boolean = until(timeoutMillis) { saw(id) }

        fun awaitMessage(id: String) = assertTrue("no '$id' from the page; got $messages", waitFor(id))

        fun awaitPrefix(prefix: String): String {
            assertTrue("nothing starting with '$prefix'; got $messages", until(TIMEOUT) { messages.any { it.startsWith(prefix) } })
            return messages.first { it.startsWith(prefix) }
        }

        fun awaitFailure() = assertTrue("the dashboard did not fail; got $messages", until(TIMEOUT) { failures.get() > 0 })

        fun assertNoMessage(id: String, forMillis: Long) {
            SystemClock.sleep(forMillis)
            assertFalse("'$id' came: $messages", saw(id))
        }
    }

    private fun open(port: Int, pin: String, hygiene: WebViewHygiene = WebViewHygiene()): Page {
        val page = Page()
        val mac = PairedMac(host, host, port, pin, token, "device-test", "Studio")
        onMain {
            page.dashboard = DashboardWebView(
                context, host, port, mac, hygiene,
                onMessage = { message -> (message as? PageMessage.Screen)?.screenId?.let(page.messages::add) },
                onFailure = { page.failures.incrementAndGet() },
            )
            views += page.dashboard
            page.dashboard.load()
        }
        return page
    }

    private data class Seen(val port: Int, val method: String, val path: String, val cookie: Boolean, val ws: Boolean)

    /** What reached the server since the last [reset], asked over the kit's own pinned transport. */
    private fun seen(): List<Seen> {
        // Lets a request the WebView might still be sending arrive before the count.
        SystemClock.sleep(500)
        val body = get("/seen")
        return Json.parseToJsonElement(body).jsonArray.map { it.jsonObject }.map { o: JsonObject ->
            Seen(
                o.getValue("port").jsonPrimitive.int,
                o.getValue("method").jsonPrimitive.content,
                o.getValue("path").jsonPrimitive.content,
                o.getValue("cookie").jsonPrimitive.boolean,
                o.getValue("ws").jsonPrimitive.boolean,
            )
        }
    }

    private fun reset(scenario: String) {
        get("/reset?scenario=$scenario")
    }

    private fun get(path: String): String {
        // A few tries: the tablet's first connection to the Mac in a run can take a while.
        var exchange: Exchange = Exchange.Failed
        for (attempt in 1..3) {
            exchange = PinnedTransport.send(Request(URI("https://$host:$mainPort$path")), PinPolicy(pinA, setOf(host)))
            if (exchange is Exchange.Response) break
        }
        val response = exchange as? Exchange.Response ?: error("the test server did not answer $path: $exchange")
        assertEquals(200, response.status)
        return String(response.body, Charsets.UTF_8)
    }

    private fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)

    private fun clearCookies() {
        val done = java.util.concurrent.CountDownLatch(1)
        onMain { WebViewHygiene.clearCookies { done.countDown() } }
        assertTrue(done.await(5, TimeUnit.SECONDS))
    }

    private fun until(timeoutMillis: Long, condition: () -> Boolean): Boolean {
        val end = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < end) {
            if (condition()) return true
            SystemClock.sleep(50)
        }
        return condition()
    }

    private companion object {
        const val TIMEOUT = 20_000L
    }
}
