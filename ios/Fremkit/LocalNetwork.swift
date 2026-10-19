import FremkitKit
import Network
import Observation

/// The Macs advertising `_fremkit._tcp` on the local network, listed by name as soon as they are
/// browsed, and where each answers: the address its TXT record carries once a TCP connection to it
/// succeeds, and the service endpoint resolved the Bonjour way (which needs the Mac's `.local`
/// name to resolve, and on some networks never does). Also whether the network is up.
@Observable @MainActor
final class LocalNetwork {
    /// Every browsed Mac by service name (the Mac's computer name), its address possibly pending.
    private(set) var macs: [String: DiscoveredMac] = [:]

    /// Every known address, in a stable order: the `discovered` candidates of `Connector`.
    var addresses: [String] { Array(macs.values).addresses }

    /// Called when an address is newly known or the network becomes usable again.
    @ObservationIgnored var onChange: (@MainActor () -> Void)?

    @ObservationIgnored private var browser: NWBrowser?
    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored private var endpoints: [String: NWEndpoint] = [:]
    /// The checks in flight, by Mac name and kind, so one of each runs at a time.
    @ObservationIgnored private var checking: [Check: NWConnection] = [:]
    /// Each in-flight check's give-up timer.
    @ObservationIgnored private var timeouts: [Check: Task<Void, Never>] = [:]
    @ObservationIgnored private var online = true

    static let serviceType = "_fremkit._tcp"
    /// How long a connection may sit waiting (a name that does not resolve, an address that does
    /// not answer) before the check gives up; the next `refresh()` tries again.
    static let checkTimeout: Duration = .seconds(3)

    private struct Check: Hashable {
        enum Kind { case advertised, endpoint }
        let name: String
        let kind: Kind
    }

    func start() {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: .tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            MainActor.assumeIsolated { self?.update(results) }
        }
        browser.start(queue: .main)
        self.browser = browser

        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            MainActor.assumeIsolated { self?.pathChanged(satisfied: path.status == .satisfied) }
        }
        monitor.start(queue: .main)
        self.monitor = monitor
    }

    /// Checks every Mac again (its advertised address and its endpoint), so a Mac that moved, or
    /// whose check timed out, is found without waiting for a network change. Called at the start of
    /// each connection attempt; a new address fires `onChange`.
    func refresh() {
        for name in macs.keys { checkAll(name) }
    }

    private func update(_ found: Set<NWBrowser.Result>) {
        var current: [String: (NWEndpoint, FremkitTXT?)] = [:]
        for result in found {
            guard case let .service(name, _, _, _) = result.endpoint else { continue }
            var txt: FremkitTXT?
            if case let .bonjour(record) = result.metadata { txt = FremkitTXT(record.dictionary) }
            current[name] = (result.endpoint, txt)
        }
        for name in macs.keys where current[name] == nil {
            macs[name] = nil
            endpoints[name] = nil
            for kind in [Check.Kind.advertised, .endpoint] { drop(Check(name: name, kind: kind)) }
        }
        for (name, (endpoint, txt)) in current {
            var mac = macs[name] ?? DiscoveredMac(name: name)
            let isNew = macs[name] == nil
            if mac.advertised != txt {
                mac.advertised = txt
                mac.advertisedAnswers = false
                drop(Check(name: name, kind: .advertised))
            }
            macs[name] = mac
            endpoints[name] = endpoint
            if isNew || !mac.advertisedAnswers { checkAll(name) }
        }
    }

    private func pathChanged(satisfied: Bool) {
        defer { online = satisfied }
        guard satisfied, !online else { return }
        // Back on a network, perhaps another one: what answered before may not any more, and a
        // check still waiting on the old network would hold up a new one.
        for check in Array(checking.keys) { drop(check) }
        for name in macs.keys {
            macs[name]?.advertisedAnswers = false
            macs[name]?.resolved = nil
        }
        refresh()
        onChange?()
    }

    private func checkAll(_ name: String) {
        if let txt = macs[name]?.advertised,
           let port = NWEndpoint.Port(rawValue: UInt16(txt.port)) {
            connect(Check(name: name, kind: .advertised), to: .hostPort(host: NWEndpoint.Host(txt.address), port: port))
        }
        if let endpoint = endpoints[name] {
            connect(Check(name: name, kind: .endpoint), to: endpoint)
        }
    }

    /// Opens a TCP connection just to learn whether (and from which address) the Mac answers, then
    /// closes it. A connection still waiting after `checkTimeout` is given up.
    private func connect(_ check: Check, to endpoint: NWEndpoint) {
        guard checking[check] == nil else { return }
        // IPv4 only: the address this records is a candidate the Mac must accept as a Host, and it
        // accepts its IPv4 addresses and its `.local` name, never an IPv6 literal (`isConnectableHost`).
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }
        let connection = NWConnection(to: endpoint, using: parameters)
        checking[check] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            MainActor.assumeIsolated {
                guard let self, let connection else { return }
                switch state {
                case .ready:
                    let answered = connection.currentPath?.remoteEndpoint.flatMap(Self.hostPort(of:))
                    self.finish(check, connection, .answered(answered))
                case .failed:
                    self.finish(check, connection, .failed)
                case .cancelled:
                    self.finish(check, connection, .gaveUp)
                default:
                    // `.waiting` is not an answer: a name that does not resolve yet, a route not up.
                    break
                }
            }
        }
        connection.start(queue: .main)
        timeouts[check] = Task { [weak self, weak connection] in
            try? await Task.sleep(for: Self.checkTimeout)
            guard !Task.isCancelled, let self, let connection, self.checking[check] === connection else { return }
            self.finish(check, connection, .gaveUp)
        }
    }

    /// Stops a check without an outcome.
    private func drop(_ check: Check) {
        if let connection = checking.removeValue(forKey: check) {
            connection.stateUpdateHandler = nil
            connection.cancel()
        }
        timeouts.removeValue(forKey: check)?.cancel()
    }

    private enum Outcome {
        case answered((host: String, port: Int)?)
        case failed
        case gaveUp
    }

    private func finish(_ check: Check, _ connection: NWConnection, _ outcome: Outcome) {
        connection.stateUpdateHandler = nil
        connection.cancel()
        guard checking[check] === connection else { return }
        checking[check] = nil
        timeouts.removeValue(forKey: check)?.cancel()
        guard var mac = macs[check.name] else { return }
        let before = mac.candidates
        switch (check.kind, outcome) {
        case (.advertised, .answered):
            mac.advertisedAnswers = true
        case (.advertised, _):
            mac.advertisedAnswers = false
        case let (.endpoint, .answered(found?)):
            mac.resolved = MacService(name: check.name, address: found.host, port: found.port)
        case (.endpoint, .failed):
            // Refused: its last address is no longer worth trying.
            mac.resolved = nil
        case (.endpoint, _):
            // Still unresolved: keep what was known, the next refresh tries again.
            break
        }
        macs[check.name] = mac
        if mac.candidates != before, !mac.candidates.isEmpty { onChange?() }
    }

    /// An address as `Connector` takes it (an IPv4 literal or a name) and the port the service
    /// answered on. Nil for an IPv6 one, which the Mac would refuse as a Host.
    nonisolated static func hostPort(of endpoint: NWEndpoint) -> (host: String, port: Int)? {
        guard case let .hostPort(host, port) = endpoint else { return nil }
        let text: String
        switch host {
        case let .ipv4(address): text = "\(address)"
        case .ipv6: return nil
        case let .name(name, _): text = name
        @unknown default: return nil
        }
        return (text, Int(port.rawValue))
    }
}
