import Foundation

/// A Mac's address as the user typed it on the manual path, when Bonjour finds nothing: what
/// Settings → Devices shows beside the code. `TypedAddress.kt` follows the same rule, and both read
/// `typedAddresses` in `test-vectors/devices.json`.
///
/// Only what the Mac's remote listener answers on is taken (`isConnectableHost`): its `.local` name
/// or one of its IPv4 addresses, with an optional port. The host comes out as the Mac's Host set
/// writes it (lower case, no trailing dot, IPv4 without leading zeros), so the request it makes is
/// not refused 421 for a spelling.
public struct TypedAddress: Equatable, Sendable {
    public let host: String
    public let port: Int

    public init(host: String, port: Int) {
        self.host = host
        self.port = port
    }

    /// Nil unless `text` is `host` or `host:port`, spaces around it and a pasted `https://` (and
    /// one trailing `/`) aside. Never a path, userinfo, query, fragment, IPv6 literal or a port
    /// outside 1–65535.
    public init?(typed text: String) {
        var s = Substring(text.trimmingCharacters(in: .whitespacesAndNewlines))
        let scheme = "https://"
        if s.count >= scheme.count, s.prefix(scheme.count).lowercased() == scheme { s = s.dropFirst(scheme.count) }
        if s.hasSuffix("/") { s = s.dropLast() }
        guard !s.isEmpty, s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == ":") }) else {
            return nil
        }
        let parts = s.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return nil }
        var port = FremkitTXT.defaultPort
        if parts.count == 2 {
            guard let typed = parsePort(String(parts[1])) else { return nil }
            port = typed
        }
        let name = trimmingTrailingDot(parts[0].lowercased())
        if let canonical = canonicalIPv4(name) {
            self.init(host: canonical, port: port)
        } else if isLocalName(name) {
            self.init(host: name, port: port)
        } else {
            return nil
        }
    }
}

/// An IPv4 literal as `inet_ntop` writes it back (`010.0.2.10` is `10.0.2.10`), or nil.
private func canonicalIPv4(_ s: String) -> String? {
    var v4 = in_addr()
    guard inet_pton(AF_INET, s, &v4) == 1 else { return nil }
    var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
    guard inet_ntop(AF_INET, &v4, &buffer, socklen_t(buffer.count)) != nil else { return nil }
    return buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
}
