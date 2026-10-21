package app.fremkit.kit

import java.net.Socket
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager

/**
 * The pin, applied to a TLS handshake: the Kotlin twin of the iPad's `PinnedSession`. One per
 * request (or per first contact), holding what an allowed host presented ([observedKeyHash]) and
 * whether the pin refused it ([rejectedPin]), both written on the handshake's thread and read by
 * the caller's, under one lock.
 *
 * - [trustManager] checks the leaf of an allowed host against the pin, P-256 keys only (the Mac's
 *   listener uses nothing else, so an RSA key or another curve is refused whatever it hashes
 *   to). In first-contact mode (`keyHash` null) it records the key and refuses it, so no request
 *   reaches a Mac not yet trusted. A host the pin does not cover is left to the system's trust.
 * - [hostnameVerifier] accepts the policy's hosts and nothing else: the pin is the identity (the
 *   Mac's certificate names no host), but the request still goes only where it was meant to.
 * - [open] gives a connection that follows no redirect: a redirect would take the device cookie
 *   and the pin's trust somewhere the app did not choose. The 3xx itself becomes the response.
 */
class PinnedTls(
    /** The expected pin, or null for first-contact mode: record what the server presents, trust nothing. */
    val keyHash: String?,
    hosts: Set<String>,
) {
    /** The paired Mac's `.local` name and the addresses the app is using for it, normalised. */
    val hosts: Set<String> = hosts.map(Pin::normaliseHost).toSet()

    private val lock = Any()
    private var observed: String? = null
    private var rejected = false

    /** The last key an allowed host presented. */
    val observedKeyHash: String? get() = synchronized(lock) { observed }

    /** True once an allowed host has been refused: the request failed because of the pin, not the network. */
    val rejectedPin: Boolean get() = synchronized(lock) { rejected }

    /** Decides, and records what an allowed host presented. */
    fun apply(host: String, presented: String?): PinDecision {
        val decision = Pin.decide(host, presented, keyHash, hosts)
        synchronized(lock) {
            // A handshake whose key could not be read must not erase one that was.
            if (decision != PinDecision.DefaultHandling && presented != null) observed = presented
            if (decision is PinDecision.Reject) rejected = true
        }
        return decision
    }

    val trustManager: X509ExtendedTrustManager = PinningTrustManager()

    val hostnameVerifier: HostnameVerifier = HostnameVerifier { hostname, _ ->
        hostname != null && Pin.normaliseHost(hostname) in this.hosts
    }

    /** A TLS context of its own, trusting through [trustManager] only. */
    val socketFactory: SSLSocketFactory by lazy {
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), null) }.socketFactory
    }

    /**
     * An `https` connection under the pin: this session's socket factory and hostname verifier, no
     * redirects, no cache. The caller sets the method, the timeouts and the headers. The socket
     * factory is this instance's own, so a pooled connection made under another pin is never
     * reused for it.
     */
    fun open(url: URL): HttpsURLConnection {
        val connection = url.openConnection() as? HttpsURLConnection
            ?: throw IllegalArgumentException("not an https URL")
        connection.sslSocketFactory = socketFactory
        connection.hostnameVerifier = hostnameVerifier
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        return connection
    }

    /** Printing a session never shows the pin. */
    override fun toString(): String =
        "PinnedTls(${if (keyHash == null) "first contact" else "pinned"}, hosts=${hosts.sorted()})"

    private inner class PinningTrustManager : X509ExtendedTrustManager() {
        /** The platform's own trust, for a host the pin does not cover. */
        private val system: X509ExtendedTrustManager by lazy {
            val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            factory.init(null as KeyStore?)
            factory.trustManagers.filterIsInstance<X509ExtendedTrustManager>().first()
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
            check(chain, (socket as? SSLSocket)?.handshakeSession?.peerHost) {
                system.checkServerTrusted(chain, authType, socket)
            }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
            check(chain, engine?.handshakeSession?.peerHost ?: engine?.peerHost) {
                system.checkServerTrusted(chain, authType, engine)
            }

        /** No host to check the pin for: never trusted. */
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) =
            throw CertificateException("no host to check the pin for")

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
            throw CertificateException("client certificates are not accepted")

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
            throw CertificateException("client certificates are not accepted")

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
            throw CertificateException("client certificates are not accepted")

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

        /**
         * Hashes the leaf only for a host the pin covers (any other host is none of the pin's
         * business), then trusts, refuses, or hands over to the system. The exception names no
         * key: the observed one is read from [observedKeyHash].
         */
        private fun check(chain: Array<out X509Certificate>?, host: String?, system: () -> Unit) {
            if (host == null) throw CertificateException("no host to check the pin for")
            val presented = if (Pin.normaliseHost(host) in hosts) chain?.firstOrNull()?.let(Pin::keyHashOf) else null
            when (apply(host, presented)) {
                PinDecision.Trust -> Unit
                is PinDecision.Reject -> throw CertificateException("the server's key is not the paired Mac's")
                PinDecision.DefaultHandling -> system()
            }
        }
    }
}
