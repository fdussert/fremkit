import Foundation

public enum ConnectResult: Equatable, Sendable {
    /// `host` is the candidate that answered: store it with `PairedMac.updating(address:)`.
    case connected(host: String, info: DeviceInfo)
    case unauthorized
    /// Nobody answered with the right key and at least one answered with another: the Mac's
    /// certificate was reset, or another machine holds its address.
    case keyChanged
    case unreachable
}

/// Finds the paired Mac when it may have moved: its `.local` name, then the last address that
/// worked, then the other addresses it last listed, then whatever Bonjour resolved. A wrong key is
/// "not this one, next" (remembered: if nothing else answers and the Mac's own name or last address
/// presented it, the key changed); a 401 from the right key ends the search, since another address
/// would only say the same.
public struct Connector: Sendable {
    public let prober: any Prober

    public init(prober: any Prober = HTTPProber()) {
        self.prober = prober
    }

    /// - Parameter preferring: a host to try before all others (the one a dashboard is using, so a
    ///   page that still works stays where it is).
    /// A wrong key ends in `.keyChanged` only when `preferring`, `mac.host` or `mac.address`
    /// presented it: one from the Mac's other addresses or from Bonjour is only "not this one" (a
    /// stale address another machine now holds), and alone it leaves the result `.unreachable`.
    public func connect(mac: PairedMac, discovered: [String], preferring: String? = nil) async -> ConnectResult {
        let (result, wrongKey) = await search(Self.candidates(mac: mac, discovered: discovered, preferring: preferring), mac: mac)
        let own = Set([preferring, mac.host, mac.address].compactMap { $0 }.map(PinnedSession.normalise))
        if result == .keyChanged, wrongKey.isDisjoint(with: own) { return .unreachable }
        return result
    }

    /// Looks for the Mac behind a dashboard that is using `current`: `current` first, then as
    /// `connect`. A wrong key from another candidate is only "not this one" (a stale address another
    /// Mac now holds, say): it ends in `.keyChanged` only when the host in use itself presented
    /// another key and nobody answered with the right one. Otherwise nothing answered that matters,
    /// and the result is `.unreachable`, which leaves the dashboard alone.
    public func relocate(mac: PairedMac, discovered: [String], current: String) async -> ConnectResult {
        let (result, wrongKey) = await search(Self.candidates(mac: mac, discovered: discovered, preferring: current), mac: mac)
        if result == .keyChanged, !wrongKey.contains(PinnedSession.normalise(current)) { return .unreachable }
        return result
    }

    /// Tries each host in turn; also says which answered with another key (normalised).
    private func search(_ hosts: [String], mac: PairedMac) async -> (result: ConnectResult, wrongKey: Set<String>) {
        var wrongKey = Set<String>()
        for host in hosts {
            switch await prober.probe(host: host, port: mac.port, mac: mac) {
            case let .ok(info): return (.connected(host: host, info: info), wrongKey)
            case .unauthorized: return (.unauthorized, wrongKey)
            case .pinMismatch: wrongKey.insert(PinnedSession.normalise(host))
            case .unreachable: continue
            }
        }
        return (wrongKey.isEmpty ? .unreachable : .keyChanged, wrongKey)
    }

    /// `preferring`, `mac.host`, `mac.address`, the Mac's other addresses (`mac.addresses`), then
    /// `discovered`, each once (compared without case), keeping only the `.local` names and IPv4
    /// literals the Mac answers on (`isConnectableHost`). Each is probed under the pin like any other.
    static func candidates(mac: PairedMac, discovered: [String], preferring: String? = nil) -> [String] {
        var seen = Set<String>()
        return ([preferring ?? ""] + [mac.host, mac.address] + mac.addresses + discovered).filter { host in
            isConnectableHost(host) && seen.insert(PinnedSession.normalise(host)).inserted
        }
    }
}
