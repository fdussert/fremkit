import Foundation

/// What the dashboard page posts to the app's `fremkit` message handler
/// (`ui/src/dashboard/native.ts`). Anything else is ignored.
public enum PageMessage: Equatable, Sendable {
    /// The Mac no longer knows this device.
    case unauthorized
    /// The device screen the page shows, or nil while the Mac has given it none.
    case screen(String?)
    /// The brightness the Mac wants, 0–100, once per `seq`.
    case brightness(target: Double, seq: Int)

    /// Reads a `WKScriptMessage` body (a dictionary of `NSString`/`NSNumber`/`NSNull` values).
    public init?(body: Any) {
        guard let fields = body as? [String: Any], let type = fields["type"] as? String else { return nil }
        switch type {
        case "unauthorized":
            self = .unauthorized
        case "screen":
            switch fields["screenId"] {
            case is NSNull: self = .screen(nil)
            case let id as String: self = .screen(id)
            default: return nil
            }
        case "brightness":
            guard let target = (fields["target"] as? NSNumber)?.doubleValue, target.isFinite, (0...100).contains(target),
                  let seq = fields["seq"] as? NSNumber, let whole = Int(exactly: seq.doubleValue) else { return nil }
            self = .brightness(target: target, seq: whole)
        default:
            return nil
        }
    }
}

/// Where the web view loads the dashboard, and the cookie that carries the device token.
public enum Dashboard {
    public static let cookieName = Endpoint.cookie

    /// `https://<host>:<port>/`, with an IPv6 literal in brackets.
    public static func url(host: String, port: Int) -> URL? {
        Endpoint.url(host: host, port: port, path: "/")
    }

    /// The hosts the pin covers while `host` is in use: that host, the Mac's `.local` name and its
    /// last address, normalised as `PinnedSession` compares them. Every other host is left to the
    /// system's trust.
    public static func pinnedHosts(mac: PairedMac, host: String) -> Set<String> {
        Set([host, mac.host, mac.address].filter { !$0.isEmpty }.map(PinnedSession.normalise))
    }
}

extension PairingLink {
    /// The Mac's name for people: its `.local` name without the suffix.
    public var macName: String {
        host.lowercased().hasSuffix(".local") ? String(host.dropLast(".local".count)) : host
    }
}
