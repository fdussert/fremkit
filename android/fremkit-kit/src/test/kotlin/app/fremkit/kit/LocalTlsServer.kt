package app.fremkit.kit

import com.sun.net.httpserver.HttpsConfigurator
import com.sun.net.httpserver.HttpsServer
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.security.KeyPair
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext

/**
 * A TLS server on 127.0.0.1 and an ephemeral port, with a key made for the test (P-256 by
 * default, RSA or another curve on request) and a self-signed certificate: the real handshake
 * the pinning trust manager sees, with no key committed. Answers by path from a table and
 * records every request that reached it.
 */
class LocalTlsServer(keys: KeyPair = TestCertificates.ecKeyPair()) : AutoCloseable {
    sealed interface Answer {
        data class Status(val code: Int, val body: String) : Answer
        /** A 302 to [location]. */
        data class Redirect(val location: String) : Answer
        /** Waits [millis] before answering 200, to outlast a client's timeout. */
        data class Slow(val millis: Long, val body: String) : Answer
    }

    class Seen(val method: String, val path: String, val headers: Map<String, List<String>>, val body: ByteArray) {
        fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value?.firstOrNull()
    }

    /** The pin of the server's key as the kit computes it (null for a key that is not P-256). */
    val keyHash: String = base64UrlEncode(MessageDigest.getInstance("SHA-256").digest(keys.public.encoded))

    private val answers = mutableMapOf<String, Answer>()
    private val seen = CopyOnWriteArrayList<Seen>()
    private val pool = Executors.newCachedThreadPool()
    private val server: HttpsServer = HttpsServer.create(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0)

    init {
        val der = TestCertificates.selfSigned(keys)
        val certificate = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der))
        val password = "test".toCharArray()
        val store = KeyStore.getInstance("PKCS12").apply {
            load(null, null)
            setKeyEntry("server", keys.private, password, arrayOf(certificate))
        }
        val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
        val context = SSLContext.getInstance("TLS").apply { init(managers.keyManagers, null, null) }
        server.httpsConfigurator = HttpsConfigurator(context)
        server.executor = pool
        server.createContext("/") { exchange ->
            val body = exchange.requestBody.readBytes()
            val path = exchange.requestURI.rawPath + (exchange.requestURI.rawQuery?.let { "?$it" } ?: "")
            seen += Seen(exchange.requestMethod, path, exchange.requestHeaders.toMap(), body)
            val answer = synchronized(answers) { answers[exchange.requestURI.rawPath] }
            exchange.responseHeaders.add("Content-Type", "application/json")
            when (answer) {
                is Answer.Status -> respond(exchange, answer.code, answer.body)
                is Answer.Redirect -> {
                    exchange.responseHeaders.add("Location", answer.location)
                    respond(exchange, 302, "")
                }
                is Answer.Slow -> {
                    Thread.sleep(answer.millis)
                    respond(exchange, 200, answer.body)
                }
                null -> respond(exchange, 404, """{"statusCode":404,"error":"Not Found"}""")
            }
        }
        server.start()
    }

    val host: String get() = "127.0.0.1"
    val port: Int get() = server.address.port

    fun answer(path: String, with: Answer) {
        synchronized(answers) { answers[path] = with }
    }

    /** Every request that reached the handler: none when the client refused the handshake. */
    val requests: List<Seen> get() = seen.toList()

    override fun close() {
        server.stop(0)
        pool.shutdownNow()
    }

    private fun respond(exchange: com.sun.net.httpserver.HttpExchange, code: Int, text: String) {
        val bytes = text.toByteArray()
        exchange.sendResponseHeaders(code, if (bytes.isEmpty()) -1 else bytes.size.toLong())
        if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
        exchange.close()
    }
}
