import Foundation

/// What `GET /api/devices/me` returns.
public struct DeviceInfo: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    /// The device screen this iPad shows, or nil while the Mac has not given it one.
    public let screenId: String?
    /// What the Mac wants the screen's brightness at, or nil when brightness is not the Mac's to set.
    public let brightness: DeviceBrightness?
    /// The Mac's other LAN addresses, where to look for it when the one in use goes away. Only the
    /// private IPv4 literals the Mac sent (`isPrivateIPv4Literal`), at most `PairedMac.maxAddresses`;
    /// empty from a Mac that sends none.
    public let addresses: [String]

    public init(id: String, name: String, screenId: String?, brightness: DeviceBrightness?, addresses: [String] = []) {
        self.id = id
        self.name = name
        self.screenId = screenId
        self.brightness = brightness
        self.addresses = PairedMac.cleaned(addresses)
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, screenId, brightness, addresses
    }

    /// Lenient about `addresses` only: missing (an older Mac) or not a list of strings is `[]`, and
    /// an entry that is not a private IPv4 literal is dropped. The wire is never trusted with where
    /// the app connects.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id),
                  name: try c.decode(String.self, forKey: .name),
                  screenId: try c.decodeIfPresent(String.self, forKey: .screenId),
                  brightness: try c.decodeIfPresent(DeviceBrightness.self, forKey: .brightness),
                  addresses: (try? c.decodeIfPresent([LossyString].self, forKey: .addresses))?.compactMap(\.value) ?? [])
    }
}

/// A list entry that may not be a string: decoded as nil instead of failing the whole list.
private struct LossyString: Decodable {
    let value: String?
    init(from decoder: any Decoder) throws {
        value = try? decoder.singleValueContainer().decode(String.self)
    }
}

public struct DeviceBrightness: Codable, Equatable, Sendable {
    /// 0–100, or nil for "leave it alone".
    public let target: Double?
    /// Bumped by the Mac for each new target: the app applies a target once per `seq`.
    public let seq: Int

    public init(target: Double?, seq: Int) {
        self.target = target
        self.seq = seq
    }
}

public enum ProbeOutcome: Equatable, Sendable {
    case ok(DeviceInfo)
    /// The Mac answered and does not know this token: the pairing was removed.
    case unauthorized
    /// Something answered with another key: not the paired Mac, try the next address.
    case pinMismatch
    /// Nothing answered, or not as a Fremkit Mac would.
    case unreachable
}

public protocol Prober: Sendable {
    func probe(host: String, port: Int, mac: PairedMac) async -> ProbeOutcome
}

/// Which hosts the pin covers and which key it expects.
public struct PinPolicy: Equatable, Sendable {
    public let keyHash: String
    public let hosts: Set<String>

    public init(keyHash: String, hosts: Set<String>) {
        self.keyHash = keyHash
        self.hosts = hosts
    }
}

/// Printing a policy never shows the pin.
extension PinPolicy: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "PinPolicy(hosts: \(hosts.sorted()))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["keyHash": redacted, "hosts": hosts.sorted()]) }
}

/// How a pinned request ended.
public enum Exchange: Sendable {
    case response(status: Int, body: Data)
    /// The host is the paired Mac's but presented another key.
    case pinRejected
    /// Timeout, refused, TLS failure, anything else.
    case failed
}

/// Sends one request under a pin. The real one is `PinnedTransport.send`; tests pass their own.
public typealias Transport = @Sendable (URLRequest, PinPolicy) async -> Exchange

public enum PinnedTransport {
    /// Sends `request` through a fresh session whose delegate is a `PinnedSession` for `policy`, so
    /// a pin refusal is told apart from a network failure. `configuration` is the seam tests use to
    /// put a `URLProtocol` stub in front of the network.
    public static func send(_ request: URLRequest, policy: PinPolicy, configuration: URLSessionConfiguration) async -> Exchange {
        let pinned = PinnedSession(keyHash: policy.keyHash, hosts: policy.hosts)
        let session = URLSession(configuration: configuration, delegate: pinned, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed }
            return .response(status: http.statusCode, body: data)
        } catch {
            return pinned.rejectedPin ? .pinRejected : .failed
        }
    }

    /// The configuration both clients use by default: no cache, no cookie jar (the token cookie is
    /// set by hand on each request), nothing kept on disk.
    public static var defaultConfiguration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 5
        configuration.waitsForConnectivity = false
        return configuration
    }
}

enum Endpoint {
    static let cookie = "fremkit_device"
    static let timeout: TimeInterval = 5

    /// `https://<host>:<port><path>`, with an IPv6 literal in brackets and its zone escaped.
    static func url(host: String, port: Int, path: String) -> URL? {
        var h = host
        if h.contains(":"), !h.hasPrefix("[") {
            h = "[" + h.replacingOccurrences(of: "%", with: "%25") + "]"
        }
        return URL(string: "https://\(h):\(port)\(path)")
    }

    static func request(host: String, port: Int, path: String, token: String?) -> URLRequest? {
        guard let url = url(host: host, port: port, path: path) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpShouldHandleCookies = false
        if let token { request.setValue("\(cookie)=\(token)", forHTTPHeaderField: "Cookie") }
        return request
    }
}

/// Asks one address whether it is the paired Mac and whether it still knows this iPad:
/// `GET https://<host>:<port>/api/devices/me?addresses=1` with the device cookie, 5 s timeout. The
/// `addresses=1` asks for the Mac's other addresses, which only the app does (the page does not).
public struct HTTPProber: Prober {
    private let transport: Transport

    public init(configuration: URLSessionConfiguration = PinnedTransport.defaultConfiguration) {
        transport = { request, policy in await PinnedTransport.send(request, policy: policy, configuration: configuration) }
    }

    init(transport: @escaping Transport) {
        self.transport = transport
    }

    public func probe(host: String, port: Int, mac: PairedMac) async -> ProbeOutcome {
        guard let request = Endpoint.request(host: host, port: port, path: "/api/devices/me?addresses=1", token: mac.token) else {
            return .unreachable
        }
        let policy = PinPolicy(keyHash: mac.keyHash, hosts: Dashboard.pinnedHosts(mac: mac, host: host))
        switch await transport(request, policy) {
        case let .response(200, body):
            guard let info = try? JSONDecoder().decode(DeviceInfo.self, from: body) else { return .unreachable }
            return .ok(info)
        case .response(401, _): return .unauthorized
        case .response: return .unreachable
        case .pinRejected: return .pinMismatch
        case .failed: return .unreachable
        }
    }
}
