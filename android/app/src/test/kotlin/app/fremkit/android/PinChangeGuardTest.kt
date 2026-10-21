package app.fremkit.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PinChangeGuardTest {
    private val calls = mutableListOf<String>()
    private val guard = PinChangeGuard(restartProcess = { calls += "restart" }, clearInProcess = { calls += "clear" })

    @Test
    fun beforeAnyWebViewLoadClearsInPlace() {
        guard.pinChanged()
        assertEquals(listOf("clear"), calls)
        assertFalse(guard.webViewLoaded)
        assertFalse(guard.restarting)
    }

    @Test
    fun afterAWebViewLoadedRestartsTheProcess() {
        assertTrue(guard.webViewLoading())
        guard.pinChanged()
        assertEquals(listOf("restart"), calls)
        assertTrue(guard.restarting)
    }

    @Test
    fun aClearedProcessStillRestartsAfterItsFirstLoad() {
        guard.pinChanged()
        assertTrue(guard.webViewLoading())
        guard.pinChanged()
        assertEquals(listOf("clear", "restart"), calls)
    }

    @Test
    fun nothingLoadsOnceARestartIsUnderWay() {
        guard.webViewLoading()
        guard.pinChanged()
        // The new pairing's dashboard must not load down the old pin's pooled sockets meanwhile.
        assertFalse(guard.webViewLoading())
        assertFalse(guard.webViewLoading())
    }

    @Test
    fun aSecondChangeDuringTheRestartDoesNotRestartTwice() {
        guard.webViewLoading()
        guard.pinChanged()
        guard.pinChanged()
        assertEquals(listOf("restart"), calls)
    }
}
