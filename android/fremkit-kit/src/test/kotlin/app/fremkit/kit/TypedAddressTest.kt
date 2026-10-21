package app.fremkit.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TypedAddressTest {
    @Test
    fun parsesEverySharedAddressAsExpected() {
        val vectors = Vectors.all.typedAddresses
        assertFalse(vectors.isEmpty())
        for (vector in vectors) {
            val expected = vector.expect?.let { TypedAddress(it.host, it.port) }
            assertEquals("${vector.why}: \"${vector.input}\"", expected, TypedAddress.parse(vector.input))
        }
    }

    @Test
    fun everyAcceptedHostIsOneTheAppConnectsTo() {
        for (vector in Vectors.all.typedAddresses) {
            val parsed = TypedAddress.parse(vector.input) ?: continue
            assertTrue(vector.why, isConnectableHost(parsed.host))
        }
    }
}
