package app.fremkit.kit

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * The pairing-protocol vectors shared with the server's tests and the Swift kit's:
 * `test-vectors/devices.json` at the repository root, on the test classpath through
 * `sourceSets.test.resources` in build.gradle.kts.
 */
object Vectors {
    val text: String by lazy {
        val stream = Vectors::class.java.getResourceAsStream("/devices.json")
            ?: error("test-vectors/devices.json is not on the test classpath")
        stream.bufferedReader().use { it.readText() }
    }

    private val lenient = Json { ignoreUnknownKeys = true }

    val all: File by lazy { lenient.decodeFromString(File.serializer(), text) }

    /** The raw JSON, for the values a typed decode would flatten (a page message's body). */
    val json: JsonObject by lazy { Json.parseToJsonElement(text).jsonObject }

    @Serializable
    data class File(
        val version: Int,
        val codeProof: CodeProofVector,
        val fingerprint: FingerprintVectors,
        val spki: SpkiVector,
        val codes: CodeVectors,
        val pairingLinks: List<PairingLinkVector>,
        val ipv4: List<Ipv4Vector>,
        val subframes: List<FrameVector>,
        val mainFrames: MainFrameVectors,
        val pageMessages: List<PageMessageVector>,
    )

    @Serializable
    data class CodeProofVector(
        val iterations: Int,
        val code: String,
        val keyHash: String,
        val proof: String,
        val anotherKeyHash: String,
    )

    @Serializable
    data class FingerprintVectors(
        val listSha256: String,
        val listLength: Int,
        val cases: List<Case>,
        val tooShort: List<String>,
    ) {
        @Serializable
        data class Case(val bytesHex: String, val keyHash: String, val words: List<String>)
    }

    @Serializable
    data class SpkiVector(
        val derHex: String,
        val keyHash: String,
        val rawOffset: Int,
        val rejectedRawHex: List<String>,
    )

    @Serializable
    data class CodeVectors(val alphabet: String, val length: Int, val normalise: List<Normalise>) {
        @Serializable
        data class Normalise(val input: String, val output: String?, val why: String)
    }

    @Serializable
    data class PairingLinkVector(val why: String, val url: String, val expect: Parsed?) {
        @Serializable
        data class Parsed(
            val host: String,
            val address: String,
            val port: Int,
            val code: String,
            val keyHash: String,
            val secret: String?,
        )
    }

    @Serializable
    data class Ipv4Vector(
        val literal: String,
        val ipv4: Boolean,
        val private: Boolean,
        val why: String? = null,
    )

    @Serializable
    data class FrameVector(
        val url: String?,
        val host: String,
        val port: Int,
        val allowed: Boolean,
        val why: String,
    )

    @Serializable
    data class MainFrameVectors(val navigations: List<FrameVector>, val pageOrigins: List<Origin>) {
        @Serializable
        data class Origin(
            val scheme: String,
            val originHost: String,
            val originPort: Int,
            val host: String,
            val port: Int,
            val heard: Boolean,
        )
    }

    /** A page message: its body as the page posts it, and the expected parse (null: ignored). */
    @Serializable
    data class PageMessageVector(val body: JsonElement, val expect: JsonElement? = null)
}

/** Bytes from lowercase or uppercase hex; fails on anything else (test data only). */
fun hex(text: String): ByteArray {
    require(text.length % 2 == 0) { "odd hex length" }
    return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
