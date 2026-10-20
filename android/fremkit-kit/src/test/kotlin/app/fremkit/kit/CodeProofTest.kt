package app.fremkit.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** `CodeProofTests`, on the shared `codeProof` vector (test-vectors/devices.json). */
class CodeProofTest {
    private val vector = Vectors.all.codeProof

    // The server derives the same proof.
    @Test
    fun derivesTheServersProof() {
        assertEquals(vector.iterations, CodeProof.ITERATIONS)
        assertEquals(vector.proof, CodeProof.proof(vector.code, vector.keyHash))
    }

    @Test
    fun anotherKeyGivesAnotherProof() {
        val other = CodeProof.proof(vector.code, vector.anotherKeyHash)
        assertNotEquals(CodeProof.proof(vector.code, vector.keyHash), other)
        assertNotEquals(vector.proof, other)
    }

    @Test
    fun theProofIsUnpaddedBase64UrlOfThirtyTwoBytes() {
        val proof = CodeProof.proof(vector.code, vector.keyHash)
        assertTrue(proof, isKeyHash(proof))
    }

    @Test
    fun theProofNeverContainsTheCode() {
        assertTrue(!CodeProof.proof(vector.code, vector.keyHash).contains(vector.code))
    }
}
