import Foundation

/// The helper's side of the conversation about brightness with the server.
///
/// The server decides (see `server/src/brightness/`); the helper applies and reports. It reads
/// the `brightness` channel of the WebSocket like any widget and writes a report to
/// `POST /api/hooks/brightness`. Both shapes are handled here so they can be tested against the
/// server's schema without a socket.
public enum BrightnessChannel {
    public static let channel = "brightness"
    public static let reportPath = "/api/hooks/brightness"

    /// What the server wants for the kiosk's screen.
    public struct Directive: Equatable {
        /// The screen id the kiosk drives, as the server resolved it.
        public let screen: String
        public let available: Bool
        /// The level to apply, or nil for "leave the display alone".
        public let target: Int?
        /// Bumped by the server whenever a target is decided: apply when it changes, even to the
        /// same value (the monitor's own buttons may have moved it since).
        public let seq: Int
        /// The level the server believes the display is at, for the menu's slider.
        public let value: Int?
        public init(screen: String, available: Bool, target: Int?, seq: Int, value: Int?) {
            self.screen = screen
            self.available = available
            self.target = target
            self.seq = seq
            self.value = value
        }
    }

    /// The subscribe message for the socket.
    public static func subscribeMessage() -> String {
        #"{"type":"subscribe","channel":"brightness"}"#
    }

    /// A `set` command for the kiosk's screen, as the menu's slider sends it.
    public static func setMessage(id: String, value: Int) -> String {
        let level = max(0, min(100, value))
        return #"{"type":"command","id":"\#(id)","channel":"brightness","name":"set","payload":{"value":\#(level)}}"#
    }

    /// The directive for the kiosk's screen in a socket message, or nil when the message is about
    /// something else or does not have the expected shape.
    public static func directive(from message: Data) -> Directive? {
        guard let root = try? JSONSerialization.jsonObject(with: message) as? [String: Any],
              root["type"] as? String == "data", root["channel"] as? String == channel,
              let data = root["data"] as? [String: Any],
              let kiosk = data["kiosk"] as? String,
              let screens = data["screens"] as? [String: Any],
              let screen = screens[kiosk] as? [String: Any],
              let available = screen["available"] as? Bool,
              let seq = screen["seq"] as? Int
        else { return nil }
        return Directive(
            screen: kiosk,
            available: available,
            target: (screen["target"] as? Int).map { max(0, min(100, $0)) },
            seq: seq,
            value: screen["value"] as? Int
        )
    }

    /// Why the kiosk's display cannot be driven, in the server's words.
    public enum Unavailable: String {
        case noDisplay = "no-display"
        case noDDC = "no-ddc"
        case ambiguous
    }

    /// The JSON body of a report. `builtin` is the built-in display's level, 0–1.
    public static func report(
        screen: String?, available: Bool, reason: Unavailable?, value: Int?, display: String?, builtin: Double?, applied: Int?
    ) -> [String: Any] {
        var body: [String: Any] = [
            "screen": screen ?? NSNull(),
            "available": available,
            "value": value.map { max(0, min(100, $0)) } ?? NSNull(),
            "builtin": builtin.map { max(0, min(1, $0)) } ?? NSNull(),
        ]
        if let reason { body["reason"] = reason.rawValue }
        if let display, !display.isEmpty { body["display"] = String(display.prefix(80)) }
        if let applied { body["applied"] = applied }
        return body
    }

    /// The screen a kiosk URL names with `?screen=`, when it is a valid screen id; nil means the
    /// default (the first Edge screen), which the server resolves.
    public static func screen(fromKioskURL url: URL) -> String? {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let value = items.first(where: { $0.name == "screen" })?.value,
              value.range(of: "^[a-z0-9][a-z0-9-]{0,63}$", options: .regularExpression) != nil
        else { return nil }
        return value
    }
}
