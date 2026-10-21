package app.fremkit.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingLinkTest {
    private val key = Vectors.all.spki.keyHash
    private val secret = Vectors.all.pairingLinks.firstNotNullOf { it.expect?.secret }

    private fun link(query: String): PairingLink? = PairingLink.parse("fremkit://pair?$query")

    /** The query of the shared vectors' first link, a valid one without a secret. */
    private val valid: String get() = Vectors.all.pairingLinks[0].url.removePrefix("fremkit://pair?")

    /** Checks the shared links whose `why` passes [filter], and that there is at least one. */
    private fun checkLinks(filter: (String) -> Boolean) {
        val vectors = Vectors.all.pairingLinks.filter { filter(it.why) }
        assertFalse("no shared link for this test", vectors.isEmpty())
        for (vector in vectors) {
            val parsed = PairingLink.parse(vector.url)
            val e = vector.expect
            if (e != null) {
                assertEquals("${vector.why}: ${vector.url}",
                    PairingLink(e.host, e.address, e.port, e.code, e.keyHash, e.secret), parsed)
            } else {
                assertNull("${vector.why}: ${vector.url} parsed", parsed)
            }
        }
    }

    private fun checkLinks(vararg whys: String) = checkLinks { it in whys }

    @Test
    fun parsesEverySharedLinkAsExpected() = checkLinks { true }

    @Test
    fun parsesAValidLink() = checkLinks("a valid link")

    @Test
    fun aLinkWithoutASecretHasNone() {
        assertEquals("a valid link", Vectors.all.pairingLinks.first().why)
        val parsed = link(valid)
        assertNotNull(parsed)
        assertNull("a Mac from before the secret still pairs, with the code", parsed!!.secret)
    }

    @Test
    fun parsesTheSecret() = checkLinks("a link with the secret")

    @Test
    fun refusesABadSecret() = checkLinks("a bad secret", "a repeated secret")

    @Test
    fun printingALinkNeverShowsTheSecret() {
        val parsed = link("$valid&s=$secret")!!
        assertEquals(secret, parsed.secret)
        assertFalse(parsed.toString().contains(secret))
    }

    @Test
    fun refusesAnIPv6AddressTheMacWouldAnswer421To() =
        checkLinks("an IPv6 address, which the Mac would answer 421 to")

    @Test
    fun normalisesALowercaseCodeWithADash() = checkLinks("a lowercase code with a dash")

    @Test
    fun refusesALinkMissingAnyField() {
        checkLinks { it.startsWith("no ") }
        assertEquals("one per required field", 5, Vectors.all.pairingLinks.count { it.why.startsWith("no ") })
    }

    @Test
    fun refusesABadPort() = checkLinks("a bad port", "the highest port")

    @Test
    fun refusesABadKey() = checkLinks("a bad key hash")

    @Test
    fun refusesAHostThatIsNotLocal() = checkLinks("a host that is not a .local name")

    @Test
    fun refusesAnAddressThatIsNotAnIPLiteral() = checkLinks("an address that is not an IP literal")

    @Test
    fun refusesAnotherSchemeOrAction() = checkLinks("another scheme", "another action")

    @Test
    fun dropsATrailingDotFromTheHost() = checkLinks("a trailing dot on the host, dropped")

    @Test
    fun printingNeverShowsTheKeyOrCode() {
        val parsed = link(valid)!!
        val text = parsed.toString()
        assertFalse(text.contains(key))
        assertFalse(text.contains(parsed.code))
        assertTrue(text.contains("studio.local"))
    }

    @Test
    fun refusesABadCode() = checkLinks("a code with a character outside the alphabet")

    // Kotlin only: what java.net.URI and a hand-written query parser could get wrong.

    @Test
    fun refusesAStringThatIsNotAURI() {
        assertNull(PairingLink.parse("fremkit://pair?h=studio local&a=192.0.2.10"))
        assertNull(PairingLink.parse(""))
        assertNull(PairingLink.parse("not a link"))
    }

    @Test
    fun matchesTheSchemeAndActionWithoutCase() {
        assertNotNull(PairingLink.parse("FREMKIT://PAIR?$valid"))
    }

    @Test
    fun refusesAFieldWithoutAValueOrAMalformedEscape() {
        assertNull(link("$valid&s"))
        assertNull(link("$valid&"))
        assertNull(link("$valid&s=%zz"))
        assertNull(link("$valid&s=%4"))
    }

    @Test
    fun aPlusIsNotASpace() {
        // URLComponents does not read `+` as a space, and neither does the kit: `ABCD+EFGH` is
        // nine characters, one outside the alphabet.
        assertNull(link(valid.replace("c=ABCDEFGH", "c=ABCD+EFGH")))
        assertNotNull(link(valid.replace("c=ABCDEFGH", "c=ABCD%20EFGH")))
    }

    @Test
    fun anEqualsSignInAValueIsPartOfIt() {
        assertNull(link(valid.replace("p=4243", "p=4243=1")))
    }

    @Test
    fun refusesALinkWithNoQuery() {
        assertNull(PairingLink.parse("fremkit://pair"))
        assertNull(PairingLink.parse("fremkit://pair?"))
    }
}

class NormaliseCodeTest {
    private fun checkCodes(why: String) {
        val vectors = Vectors.all.codes.normalise.filter { it.why == why }
        assertFalse("no shared code for this test", vectors.isEmpty())
        for (vector in vectors) assertEquals(vector.input, vector.output, normaliseCode(vector.input))
    }

    @Test
    fun theAlphabetAndLengthAreTheServers() {
        assertEquals(Vectors.all.codes.alphabet.toSet(), PAIRING_CODE_ALPHABET)
        assertEquals(Vectors.all.codes.alphabet.length, PAIRING_CODE_ALPHABET.size)
        for (vector in Vectors.all.codes.normalise) {
            vector.output?.let { assertEquals(Vectors.all.codes.length, it.length) }
        }
    }

    @Test
    fun uppercasesAndDropsSpacesAndDashes() = checkCodes("any case, spaces and a dash")

    @Test
    fun refusesCharactersOutsideTheAlphabet() = checkCodes("outside the alphabet")

    @Test
    fun refusesTheWrongLength() = checkCodes("the wrong length")
}

/** The address checks every other part of the kit relies on. */
class HostsTest {
    // The shared `ipv4` vectors: what inet_pton says on the Mac is what this parser is held to,
    // leading zeros read as decimal included.
    @Test
    fun isPrivateIPv4Literal() {
        assertFalse(Vectors.all.ipv4.isEmpty())
        for (v in Vectors.all.ipv4) {
            assertEquals("isIPv4Literal(${v.literal})", v.ipv4, isIPv4Literal(v.literal))
            assertEquals("isPrivateIPv4Literal(${v.literal})", v.private, isPrivateIPv4Literal(v.literal))
        }
    }

    @Test
    fun refusesNonAsciiDigits() {
        // Character.isDigit says yes to these; inet_pton does not.
        assertFalse(isIPv4Literal("١٠.1.2.3"))
        assertFalse(isIPv4Literal("10.1.2.３"))
    }

    @Test
    fun aConnectableHostIsALocalNameOrAnIPv4Literal() {
        for (host in listOf("studio.local", "Studio.local.", "192.0.2.10")) assertTrue(host, isConnectableHost(host))
        for (host in listOf("2001:db8::1", "[2001:db8::1]", "fe80::1%en0", "example.com", "studio", "", "stu dio.local")) {
            assertFalse(host, isConnectableHost(host))
        }
    }

    @Test
    fun isIPLiteralTakesBothFamilies() {
        for (s in listOf("192.0.2.10", "010.1.2.3", "::", "::1", "2001:db8::1", "2001:DB8:0:0:0:0:0:1", "fe80::1%en0",
            "::ffff:192.0.2.10", "64:ff9b::192.0.2.1", "1:2:3:4:5:6:7:8", "1::8", "1:2:3:4:5:6::8", "::2:3:4:5:6:7:8")) {
            assertTrue(s, isIPLiteral(s))
        }
        for (s in listOf("", "studio.local", "[2001:db8::1]", "2001:db8::1%", "fe80::1%en-0", "1:2:3:4:5:6:7:8:9",
            "1::2::3", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:", "12345::1", "g::1", "::ffff:192.0.2", "::ffff:192.0.2.256",
            "1:2:3:4:5:6:7:192.0.2.1", "::192.0.2.1:1", "192.0.2.1::", ":::1", "1.2.3")) {
            assertFalse(s, isIPLiteral(s))
        }
    }

    @Test
    fun aLocalNameIsLabelsOfLettersDigitsAndHyphens() {
        for (s in listOf("studio.local", "Studio.LOCAL.", "my-mac.local", "a.b.local")) assertTrue(s, isLocalName(s))
        for (s in listOf("local", ".local", "studio..local", "stu_dio.local", "stüdio.local", "studio.local..",
            "${"a".repeat(64)}.local", "studio.example.com")) {
            assertFalse(s, isLocalName(s))
        }
        assertTrue(isLocalName("${"a".repeat(63)}.local"))
    }
}

/** Strict, canonical base64url: one spelling of each value. */
class Base64UrlTest {
    @Test
    fun roundTripsWithoutPadding() {
        for (size in 0..40) {
            val bytes = ByteArray(size) { (it * 37 + 11).toByte() }
            val text = base64UrlEncode(bytes)
            assertFalse(text.contains('=') || text.contains('+') || text.contains('/'))
            assertTrue(bytes.contentEquals(base64UrlDecode(text)))
        }
    }

    @Test
    fun refusesPaddingAndTheStandardAlphabet() {
        assertNull(base64UrlDecode("AQ=="))
        assertNull(base64UrlDecode("+/8"))
        assertNull(base64UrlDecode("A"))
        assertNull(base64UrlDecode("AQ\n"))
    }

    @Test
    fun aKeyHashIs32BytesInItsOnlySpelling() {
        assertTrue(isKeyHash(Vectors.all.spki.keyHash))
        assertFalse(isKeyHash(Vectors.all.spki.keyHash.dropLast(1) + "R"))
        assertFalse(isKeyHash(base64UrlEncode(ByteArray(31))))
    }
}
