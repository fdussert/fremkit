import Foundation

/// The screen size the iPad reports when it pairs, in points, within the server's
/// `ViewportSchema` bounds (integers, 1–10000).
public struct Viewport: Codable, Equatable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = min(max(width, 1), 10000)
        self.height = min(max(height, 1), 10000)
    }
}

/// Why pairing failed. No case carries the token or the key: the messages are the server's own,
/// already localized for the Mac's language.
public enum PairError: Error, Equatable, Sendable {
    /// 403: the code is wrong or expired; the server's message says which.
    case rejected(String)
    /// 429 from every Mac address that answered: too many tries. One address refusing is not
    /// enough, since the Mac counts tries per address (and per link-local address).
    case limited(String)
    /// 404 from the Mac itself (it passed the pin): no pairing code is showing on it right now —
    /// none was made, it was used, or its five minutes are over. The Mac answers nothing else then.
    case noCode
    /// An address answered with another key than the QR's: not the Mac that showed the code.
    case wrongMac
    /// Nothing answered.
    case unreachable
    /// 400: the app sent something the server does not accept (a bug, not the user's doing).
    case invalidRequest
}

/// `POST /api/pair` to the first of `hosts` that answers under the pin.
public struct PairClient: Sendable {
    private let transport: Transport

    public init(configuration: URLSessionConfiguration = PinnedTransport.defaultConfiguration) {
        transport = { request, policy in await PinnedTransport.send(request, policy: policy, configuration: configuration) }
    }

    init(transport: @escaping Transport) {
        self.transport = transport
    }

    /// `proof` (the typed code's, `CodeProof`) or `secret`, never both: the one left nil is not
    /// encoded. The code itself never leaves the iPad.
    private struct Body: Encodable {
        let proof: String?
        let secret: String?
        let name: String
        let viewport: Viewport
    }

    private struct Paired: Decodable {
        let token: String
        let deviceId: String
    }

    private struct Refusal: Decodable {
        let error: String
    }

    /// - Parameters:
    ///   - hosts: where to try, in order: the link's `.local` name and address, or a Bonjour
    ///     service's name and resolved addresses.
    ///   - name: this iPad's name, shown on the Mac.
    ///   - macName: the Mac's name for people, stored in the record.
    ///   - code: the normalized code, sent as its proof for `keyHash`: only the Mac holding that
    ///     key can take it.
    ///   - secret: the QR link's secret, sent instead of the code when there is one: the Mac takes
    ///     it even while it refuses codes to someone guessing them.
    public func pair(hosts: [String], port: Int, keyHash: String, code: String, secret: String? = nil, name: String,
                     viewport: Viewport, macName: String) async throws -> PairedMac {
        let hosts = hosts.map(trimmingTrailingDot)
        let policy = PinPolicy(keyHash: keyHash, hosts: Set(hosts))
        var proof: String?
        if secret == nil {
            guard let derived = CodeProof.proof(code: code, keyHash: keyHash) else { throw PairError.invalidRequest }
            proof = derived
        }
        let body = try JSONEncoder().encode(Body(proof: proof, secret: secret, name: name, viewport: viewport))
        var sawWrongMac = false
        // The Mac counts wrong codes per address, so one candidate answering 429 says nothing about
        // the next: someone guessing over link-local IPv6 must not keep the iPad from pairing over
        // the QR's IPv4 address. A right code is never counted as a wrong one, so trying it again
        // elsewhere costs nothing.
        var limited: String?
        for host in hosts {
            guard var request = Endpoint.request(host: host, port: port, path: "/api/pair", token: nil) else { continue }
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            switch await transport(request, policy) {
            case let .response(200, data):
                guard let paired = try? JSONDecoder().decode(Paired.self, from: data) else { throw PairError.unreachable }
                return PairedMac(host: hosts.first(where: isLocalName) ?? host,
                                 address: isIPv4Literal(host) ? host : hosts.first(where: isIPv4Literal) ?? host,
                                 port: port, keyHash: keyHash, token: paired.token, deviceId: paired.deviceId, name: macName)
            case let .response(403, data): throw PairError.rejected(Self.message(data))
            case let .response(429, data):
                limited = limited ?? Self.message(data)
                continue
            case .response(404, _): throw PairError.noCode
            case .response(400, _): throw PairError.invalidRequest
            case .response: continue
            case .pinRejected: sawWrongMac = true
            case .failed: continue
            }
        }
        // Every candidate failed: the Mac's own answer first, then an impostor, then silence.
        if let limited { throw PairError.limited(limited) }
        throw sawWrongMac ? PairError.wrongMac : PairError.unreachable
    }

    private static func message(_ data: Data) -> String {
        (try? JSONDecoder().decode(Refusal.self, from: data))?.error ?? ""
    }
}
