import CryptoKit
import Foundation
import Security

/// The Mac's key pin: base64url (no padding) SHA-256 of the leaf certificate's
/// SubjectPublicKeyInfo, the same string as the QR's `k`.
public enum Pin {
    /// The DER prefix of a P-256 SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { id-ecPublicKey,
    /// prime256v1 }, BIT STRING (66 bytes, 0 unused bits) }. What follows is the 65-byte point.
    static let p256Header: [UInt8] = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
                                      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]

    public static func keyHash(spki: Data) -> String {
        Data(SHA256.hash(data: spki)).base64URLEncoded()
    }

    /// The pin of the leaf certificate a server presented, or nil when it is not a P-256 key
    /// (the Mac's listener only ever uses one, so anything else is not the paired Mac). A 65-byte
    /// `04 || X || Y` external representation is only ever a P-256 point: RSA keys come out as
    /// PKCS#1 DER and other curves at other lengths.
    public static func keyHash(of trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              let key = SecCertificateCopyKey(leaf),
              let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              let spki = spki(p256Raw: raw) else { return nil }
        return keyHash(spki: spki)
    }

    /// Wraps the X9.63 form Security returns (`04 || X || Y`) into the SPKI the server hashes.
    static func spki(p256Raw raw: Data) -> Data? {
        guard raw.count == 65, raw.first == 0x04 else { return nil }
        return Data(p256Header) + raw
    }
}

/// What the challenge handler does with a server's certificate.
public enum PinDecision: Equatable, Sendable {
    /// The paired Mac's host presenting the paired key.
    case trust
    /// The paired Mac's host presenting another key, or any key in first-contact mode.
    case reject(observed: String?)
    /// Not the paired Mac's host: the pin does not apply, the system decides.
    case defaultHandling
}

/// The pin, applied to the TLS challenge. Holds `observedKeyHash` and `rejectedPin`, written from
/// URLSession's delegate queue and read from the caller's task: both are behind `lock`, which is
/// why the class can be `@unchecked Sendable`. Everything else is immutable.
public final class PinnedSession: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    /// The expected pin, or nil for first-contact mode: record what the server presents (so the
    /// app can show its words before trusting it) and trust nothing.
    public let keyHash: String?
    /// The paired Mac's `.local` name and the addresses the app is using for it.
    public let hosts: Set<String>

    private let lock = NSLock()
    private var observed: String?
    private var rejected = false

    public init(keyHash: String?, hosts: Set<String>) {
        self.keyHash = keyHash
        self.hosts = Set(hosts.map(Self.normalise))
    }

    /// The last key an allowed host presented.
    public var observedKeyHash: String? { lock.withLock { observed } }

    /// True once an allowed host has been refused: the request failed because of the pin, not the
    /// network.
    public var rejectedPin: Bool { lock.withLock { rejected } }

    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        // Hash only for a host the pin covers; any other host is none of the pin's business.
        let presented = hosts.contains(Self.normalise(space.host)) ? Pin.keyHash(of: trust) : nil
        switch apply(host: space.host, presented: presented) {
        case .trust: completionHandler(.useCredential, URLCredential(trust: trust))
        case .reject: completionHandler(.cancelAuthenticationChallenge, nil)
        case .defaultHandling: completionHandler(.performDefaultHandling, nil)
        }
    }

    /// No redirects: a redirect would take the device cookie and the pin's trust somewhere the app
    /// did not choose. The 3xx itself becomes the response.
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// Decides, and records what an allowed host presented.
    func apply(host: String, presented: String?) -> PinDecision {
        let decision = Self.decide(host: host, presented: presented, expected: keyHash, hosts: hosts)
        lock.withLock {
            // A challenge whose key could not be read must not erase one that was.
            if decision != .defaultHandling, let presented { observed = presented }
            if case .reject = decision { rejected = true }
        }
        return decision
    }

    /// The whole policy, with no Security types so it can be tested: an allowed host presenting the
    /// expected key is trusted, an allowed host presenting anything else is refused, in first-contact
    /// mode every allowed host is refused, and any other host is left to the system.
    public static func decide(host: String, presented: String?, expected: String?, hosts: Set<String>) -> PinDecision {
        guard hosts.contains(where: { normalise($0) == normalise(host) }) else { return .defaultHandling }
        guard let expected, let presented, presented == expected else { return .reject(observed: presented) }
        return .trust
    }

    /// Hosts compare without case, brackets, a trailing dot or a percent-encoded zone separator.
    static func normalise(_ host: String) -> String {
        var h = host.lowercased()
        if h.hasPrefix("["), h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
        if h.hasSuffix(".") { h = String(h.dropLast()) }
        return h.replacingOccurrences(of: "%25", with: "%")
    }
}
