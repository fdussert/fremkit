package app.fremkit.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ResolveQueueTest {
    private val started = mutableListOf<String>()
    private val queue = ResolveQueue { started += it }

    @Test
    fun oneAtATimeInOrder() {
        queue.add("Studio")
        queue.add("Kitchen")
        queue.add("Office")
        assertEquals(listOf("Studio"), started)
        queue.done("Studio")
        assertEquals(listOf("Studio", "Kitchen"), started)
        queue.done("Kitchen")
        queue.done("Office")
        assertEquals(listOf("Studio", "Kitchen", "Office"), started)
        assertNull(queue.current)
    }

    @Test
    fun aNameWaitsOnce() {
        queue.add("Studio")
        queue.add("Studio")
        queue.add("Kitchen")
        queue.add("Kitchen")
        assertEquals(listOf("Kitchen"), queue.pending)
        queue.done("Studio")
        queue.done("Kitchen")
        assertEquals(listOf("Studio", "Kitchen"), started)
    }

    @Test
    fun aLostNameNoLongerWaits() {
        queue.add("Studio")
        queue.add("Kitchen")
        queue.remove("Kitchen")
        queue.done("Studio")
        assertEquals(listOf("Studio"), started)
    }

    @Test
    fun aLateAnswerForAnotherNameIsIgnored() {
        queue.add("Studio")
        queue.add("Kitchen")
        queue.done("Kitchen")
        assertEquals(listOf("Studio"), started)
        assertEquals("Studio", queue.current)
    }

    @Test
    fun aNameResolvedCanBeAskedAgain() {
        queue.add("Studio")
        queue.done("Studio")
        queue.add("Studio")
        assertEquals(listOf("Studio", "Studio"), started)
    }

    @Test
    fun clearDropsEverything() {
        queue.add("Studio")
        queue.add("Kitchen")
        queue.clear()
        queue.done("Studio")
        assertEquals(listOf("Studio"), started)
        queue.add("Office")
        assertEquals(listOf("Studio", "Office"), started)
    }
}
