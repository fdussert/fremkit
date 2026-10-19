import Foundation

/// The helper's half of a diagnostics report, and how it joins the server's.
///
/// The server's `GET /api/diagnostics` already says what the dashboard runs; only the helper
/// knows whether touch reads the panel, which privacy grants it holds, where the kiosk is and
/// whether its display answers DDC. "Copy diagnostics" in the status menu appends this to the
/// server's report, or — the server being down, which is exactly when someone wants to report a
/// bug — sends this part alone and says so.
///
/// Nothing here is personal: states, booleans and a display size. The server has done the
/// redaction of its own part; this part has nothing to redact.
public struct HelperDiagnostics {
    public enum Grant: String {
        case granted
        case denied
        case unknown = "not answered"
    }

    public var version: String
    public var build: String
    /// `app` or `checkout`, as `ServerLaunch` decided.
    public var launch: String
    /// The status menu's own words for each state, in English (see the helper's state enums).
    public var server: String
    public var touch: String
    public var inputMonitoring: Grant
    public var accessibility: Grant
    /// The Edge's size in points, or nil when no display of the configured size is connected.
    public var kioskDisplay: (width: Int, height: Int)?
    public var kioskWindow: Bool
    /// `available`, `level 40 %`, or why not (`no DDC`, …).
    public var brightness: String
    public var fence: String
    public var dock: String
    public var manageServer: Bool

    public init(version: String, build: String, launch: String, server: String, touch: String,
                inputMonitoring: Grant, accessibility: Grant, kioskDisplay: (width: Int, height: Int)?,
                kioskWindow: Bool, brightness: String, fence: String, dock: String, manageServer: Bool) {
        self.version = version
        self.build = build
        self.launch = launch
        self.server = server
        self.touch = touch
        self.inputMonitoring = inputMonitoring
        self.accessibility = accessibility
        self.kioskDisplay = kioskDisplay
        self.kioskWindow = kioskWindow
        self.brightness = brightness
        self.fence = fence
        self.dock = dock
        self.manageServer = manageServer
    }

    /// The helper's section, as Markdown matching the server's.
    public var markdown: String {
        let display = kioskDisplay.map { "connected, \($0.width)×\($0.height)" } ?? "not found"
        let lines = [
            "### Helper",
            "",
            "- Helper: \(version) (build \(build), \(launch))",
            "- Server: \(server)\(manageServer ? "" : " (not managed by the helper)")",
            "- Touch driver: \(touch)",
            "- Input Monitoring: \(inputMonitoring.rawValue)",
            "- Accessibility: \(accessibility.rawValue)",
            "- Kiosk display: \(display)",
            "- Kiosk window: \(kioskWindow ? "open" : "none")",
            "- Brightness (DDC): \(brightness)",
            "- Mouse fence: \(fence)",
            "- Dock badges: \(dock)",
        ]
        return lines.joined(separator: "\n") + "\n"
    }

    /// What came back from the server: its report, or why there is none.
    public enum ServerPart: Equatable {
        case report(String)
        case unavailable(reason: String)
    }

    /// The full text for the pasteboard: the server's report with the helper's section after it,
    /// or a heading, a note that the server did not answer, and the helper's section alone.
    public func report(server part: ServerPart) -> String {
        switch part {
        case let .report(text):
            let trimmed = text.hasSuffix("\n") ? text : text + "\n"
            return trimmed + "\n" + markdown
        case let .unavailable(reason):
            return [
                "## Fremkit diagnostics",
                "",
                "The server did not answer (\(reason)): this report holds the helper's part only.",
                "",
                markdown,
            ].joined(separator: "\n")
        }
    }

    /// A one-word reason for a failed fetch, safe to paste: never the URL, never a header.
    public static func reason(status: Int?, error: Error?) -> String {
        if let status, status != 200 { return "HTTP \(status)" }
        if let error = error as? URLError {
            switch error.code {
            case .timedOut: return "timed out"
            case .cannotConnectToHost, .networkConnectionLost: return "not running"
            default: return "network error \(error.code.rawValue)"
            }
        }
        return error == nil ? "empty answer" : "error"
    }
}
