import Foundation

/// Builds `POST /api/devices/me/brightness { value, applied? }`: the level the iPad's screen is
/// at, and the last `seq` the app applied (so the Mac knows its target landed). Sending it, under
/// the pin, is the caller's job.
public struct BrightnessReporter: Sendable {
    public let mac: PairedMac
    /// The candidate the app is connected through.
    public let host: String

    public init(mac: PairedMac, host: String) {
        self.mac = mac
        self.host = host
    }

    /// `UIScreen.brightness` (0–1) as the server's 0–100 integer.
    public static func value(for brightness: Double) -> Int {
        guard brightness.isFinite else { return 0 }
        return min(max(Int((brightness * 100).rounded()), 0), 100)
    }

    private struct Report: Encodable {
        let value: Int
        let applied: Int?
    }

    public func request(brightness: Double, applied: Int?) -> URLRequest? {
        guard var request = Endpoint.request(host: host, port: mac.port, path: "/api/devices/me/brightness", token: mac.token),
              let body = try? JSONEncoder().encode(Report(value: Self.value(for: brightness), applied: applied)) else { return nil }
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    /// The pin to send the request under.
    public var policy: PinPolicy {
        PinPolicy(keyHash: mac.keyHash, hosts: [host, mac.host, mac.address])
    }
}
