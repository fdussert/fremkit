import Foundation

/// What a Mac's `_fremkit._tcp` TXT record says: the address the QR code would carry, and the
/// port. A device that cannot resolve the Mac's `.local` name (the SRV target) learns from it
/// where to connect.
public struct FremkitTXT: Equatable, Sendable {
    public let address: String
    public let port: Int

    /// The port when the record has none: the Mac's remote listener's.
    public static let defaultPort = 4243

    /// Nil unless `a` is an IPv4 literal (`isConnectableHost`); a missing `p` is the default port,
    /// an invalid one refuses the record.
    public init?(_ record: [String: String]) {
        guard let address = record["a"], isIPv4Literal(address) else { return nil }
        let port: Int
        if let text = record["p"] {
            guard let parsed = parsePort(text) else { return nil }
            port = parsed
        } else {
            port = Self.defaultPort
        }
        self.address = address
        self.port = port
    }
}

/// A Mac Bonjour found, listed by name as soon as it is browsed, and where it can be reached once
/// that is known.
public struct DiscoveredMac: Equatable, Sendable {
    /// The service name: the Mac's computer name.
    public let name: String
    /// Where the TXT record says it is, not yet checked.
    public var advertised: FremkitTXT?
    /// The advertised address answered a TCP connection.
    public var advertisedAnswers = false
    /// Where resolving the service endpoint led (needs the `.local` name to resolve).
    public var resolved: MacService?

    public init(name: String) {
        self.name = name
    }

    /// Where to connect, in order: the advertised address once it answered, then the resolved
    /// endpoint when it is one the Mac answers on (`isConnectableHost`: an IPv6 one is not).
    /// Empty while the address is pending.
    public var candidates: [MacService] {
        var list: [MacService] = []
        if advertisedAnswers, let advertised {
            list.append(MacService(name: name, address: advertised.address, port: advertised.port))
        }
        if let resolved, isConnectableHost(resolved.address), !list.contains(where: { $0.address == resolved.address && $0.port == resolved.port }) {
            list.append(resolved)
        }
        return list
    }

    /// The one to pair with: the first candidate. Nil while the address is pending.
    public var service: MacService? { candidates.first }
}

extension Array where Element == DiscoveredMac {
    /// Every candidate address of every Mac, by Mac name, each once: `Connector`'s discovered list.
    public var addresses: [String] {
        var seen = Set<String>()
        return sorted { $0.name < $1.name }
            .flatMap { $0.candidates.map(\.address) }
            .filter { seen.insert($0).inserted }
    }
}
