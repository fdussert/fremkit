import Foundation

/// The alphabet of a pairing code: no 0/O, no 1/I, so a code read off a screen cannot be mistyped
/// into another one. The same as the server's.
let pairingCodeAlphabet = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

/// A pairing code as the user typed it: any case, with spaces or a dash. Returns the 8 characters
/// the server expects, or nil when they are not that.
public func normaliseCode(_ s: String) -> String? {
    let code = s.uppercased().filter { $0 != " " && $0 != "-" }
    guard code.count == 8, code.allSatisfy(pairingCodeAlphabet.contains) else { return nil }
    return code
}

/// What the QR code on the Mac carries:
/// `fremkit://pair?h=<name>.local&a=<lan ip>&p=4243&c=<code>&s=<secret>&k=<base64url SPKI sha256>`.
/// Every field must be present and valid, or there is no link: the app never guesses. The one
/// exception is `s`, which a Mac from before it does not send; when present it must be valid too.
public struct PairingLink: Equatable, Sendable {
    /// The Mac's Bonjour name, ending in `.local`.
    public let host: String
    /// The Mac's LAN address when the QR was shown, an IPv4 or IPv6 literal.
    public let address: String
    public let port: Int
    /// The pairing code, normalised.
    public let code: String
    /// The pin: base64url SHA-256 of the Mac's public key, no padding.
    public let keyHash: String
    /// The pairing secret bound to the code: 256 random bits, base64url, no padding. Sent instead
    /// of the code, since the Mac takes it even while it refuses codes to someone guessing them.
    /// Nil from a Mac that does not issue one: the code is sent then.
    public let secret: String?

    public init(host: String, address: String, port: Int, code: String, keyHash: String, secret: String? = nil) {
        self.host = host
        self.address = address
        self.port = port
        self.code = code
        self.keyHash = keyHash
        self.secret = secret
    }

    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "fremkit", components.host?.lowercased() == "pair",
              let items = components.queryItems else { return nil }
        var fields: [String: String] = [:]
        for item in items {
            // A repeated field is ambiguous: refuse rather than pick one.
            guard fields[item.name] == nil, let value = item.value else { return nil }
            fields[item.name] = value
        }
        guard let host = fields["h"].map(trimmingTrailingDot), isLocalName(host),
              // IPv4 only: the Mac answers on its IPv4 addresses and its `.local` name, never on an
              // IPv6 literal (`isConnectableHost`), and it never puts one in a link.
              let address = fields["a"], isIPv4Literal(address),
              let portText = fields["p"], let port = parsePort(portText),
              let codeText = fields["c"], let code = normaliseCode(codeText),
              let keyHash = fields["k"], isKeyHash(keyHash) else { return nil }
        let secret = fields["s"]
        if let secret, !isPairingSecret(secret) { return nil }
        self.init(host: host, address: address, port: port, code: code, keyHash: keyHash, secret: secret)
    }
}

/// Printing a link never shows its pin (nor its code or secret, as good as a password while they live).
extension PairingLink: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "PairingLink(\(host), \(address):\(port))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["host": host, "address": address, "port": port, "code": redacted, "keyHash": redacted,
                           "secret": secret == nil ? "none" : redacted])
    }
}

/// A fully qualified name's trailing dot dropped: `studio.local.` is `studio.local`.
func trimmingTrailingDot(_ s: String) -> String {
    s.hasSuffix(".") ? String(s.dropLast()) : s
}

/// `name.local` (or `name.local.`), each label letters, digits and hyphens: what Bonjour gives a Mac.
func isLocalName(_ s: String) -> Bool {
    let s = trimmingTrailingDot(s)
    guard s.lowercased().hasSuffix(".local") else { return false }
    let labels = s.split(separator: ".", omittingEmptySubsequences: false)
    return labels.count >= 2 && labels.allSatisfy { label in
        !label.isEmpty && label.count <= 63 && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }
}

/// An IPv4 literal.
public func isIPv4Literal(_ s: String) -> Bool {
    var v4 = in_addr()
    return inet_pton(AF_INET, s, &v4) == 1
}

/// A private IPv4 literal (RFC 1918: 10/8, 172.16/12, 192.168/16): what the app accepts as one of
/// the Mac's other addresses from the wire. Never a public, CGNAT, link-local or IPv6 one.
public func isPrivateIPv4Literal(_ s: String) -> Bool {
    var v4 = in_addr()
    guard inet_pton(AF_INET, s, &v4) == 1 else { return false }
    let b = withUnsafeBytes(of: v4.s_addr) { Array($0) }
    return b[0] == 10 || (b[0] == 172 && (16...31).contains(b[1])) || (b[0] == 192 && b[1] == 168)
}

/// A host the app connects to: a `.local` name or an IPv4 literal. The Mac answers on those only
/// (its remote listener's Host set is its `.local` name and its IPv4 addresses, and anything else
/// gets 421), and an IPv6 literal would also carry its zone into the cookie domain, the CSP and
/// the Origin check. A connection made by name may still run over IPv6.
public func isConnectableHost(_ s: String) -> Bool {
    isIPv4Literal(s) || isLocalName(s)
}

/// An IPv4 or IPv6 literal (an IPv6 one may carry a `%zone`).
public func isIPLiteral(_ s: String) -> Bool {
    var v4 = in_addr()
    if inet_pton(AF_INET, s, &v4) == 1 { return true }
    let parts = s.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: false)
    if parts.count == 2, parts[1].isEmpty || !parts[1].allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) { return false }
    var v6 = in6_addr()
    return inet_pton(AF_INET6, String(parts[0]), &v6) == 1
}

func parsePort(_ s: String) -> Int? {
    guard !s.isEmpty, s.count <= 5, s.allSatisfy({ $0.isASCII && $0.isNumber }), let port = Int(s),
          (1...65535).contains(port) else { return nil }
    return port
}

/// 43 base64url characters that decode to 32 bytes and re-encode to themselves (so the two
/// unused low bits are zero and there is exactly one spelling of each hash).
func isKeyHash(_ s: String) -> Bool {
    guard s.count == 43, let data = Data(base64URLEncoded: s), data.count == 32 else { return false }
    return data.base64URLEncoded() == s
}

/// A pairing secret has the shape of a key hash: 32 bytes in canonical base64url.
func isPairingSecret(_ s: String) -> Bool {
    isKeyHash(s)
}

extension Data {
    /// Base64url without padding, as the server's `toString('base64url')`.
    func base64URLEncoded() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strict base64url: only `A–Z a–z 0–9 - _`, no padding.
    init?(base64URLEncoded s: String) {
        guard s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var text = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = text.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 { text += String(repeating: "=", count: 4 - remainder) }
        self.init(base64Encoded: text)
    }
}
