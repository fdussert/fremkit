import Foundation

extension Dashboard {
    /// Whether a frame inside the dashboard, never the page itself, may load `url`.
    ///
    /// The dashboard's only frames are its widgets, each loaded from `/widgets/<id>/…` on the Mac
    /// that serves the page (and a widget's own CSP forbids frames of its own). So a frame may go
    /// to that host and port, over HTTPS, under `/widgets/` and nowhere else: not to another site,
    /// not to the dashboard's own page or API, not to `about:` or `data:`.
    ///
    /// The same rule as the Mac's `WidgetFrames.allows(_:on:)` (FremkitCore), case for case: the
    /// host is the page's own, compared without case but otherwise exactly (a trailing dot is
    /// another origin to WebKit); the path must start with `/widgets/` both as sent and decoded,
    /// with something after it; any `%2e` refuses the URL, and so does a `.` or `..` segment once
    /// decoded. Stricter than the Mac on two counts it cannot meet anyway: credentials in the URL
    /// and a backslash in the decoded path.
    public static func allowsSubframe(_ url: URL?, host: String, port: Int) -> Bool {
        guard let url,
              url.scheme?.lowercased() == "https",
              url.user == nil, url.password == nil,
              let urlHost = url.host(percentEncoded: false), !urlHost.isEmpty,
              sameHost(urlHost, host),
              (url.port ?? 443) == port else { return false }
        // Dot segments are refused rather than resolved, encoded or not: `/widgets/%2e%2e/admin`
        // is not a widget, and neither page ever writes an encoded dot.
        guard url.absoluteString.range(of: "%2e", options: .caseInsensitive) == nil else { return false }
        let prefix = "/widgets/"
        let raw = url.path(percentEncoded: true)
        let path = url.path(percentEncoded: false)
        guard raw.hasPrefix(prefix), raw.count > prefix.count,
              path.hasPrefix(prefix), path.count > prefix.count,
              !path.contains("\\") else { return false }
        return !path.split(separator: "/", omittingEmptySubsequences: false).contains { $0 == "." || $0 == ".." }
    }

    /// Whether the main frame may go to `url`: the Mac's own origin, `https://<host>:<port>`, and
    /// any path on it. The page reloads itself and is served at `/`; nothing it is meant to show
    /// lives on another origin, so a link or a script that would take the whole view elsewhere is
    /// cancelled, as the Mac's kiosk and admin window pin their main frame (`KioskOrigin`).
    public static func allowsMainFrame(_ url: URL?, host: String, port: Int) -> Bool {
        guard let url,
              url.scheme?.lowercased() == "https",
              url.user == nil, url.password == nil,
              let urlHost = url.host(percentEncoded: false), !urlHost.isEmpty else { return false }
        return sameHost(urlHost, host) && (url.port ?? 443) == port
    }

    /// Whether a script message's frame is the Mac's page, by the frame's security origin
    /// (`WKSecurityOrigin`, whose port is 0 for the scheme's default): what the page says to the
    /// app is heard from that origin only, even should the main frame end up somewhere else.
    public static func isPageOrigin(scheme: String, host originHost: String, port originPort: Int, host: String, port: Int) -> Bool {
        guard scheme.lowercased() == "https", !originHost.isEmpty else { return false }
        return sameHost(originHost, host) && (originPort == 0 ? 443 : originPort) == port
    }

    /// Hosts compared as the page's origin is: without case, an IPv6 literal without its brackets
    /// and with its zone unescaped. Unlike `PinnedSession.normalise`, a trailing dot is kept.
    private static func sameHost(_ a: String, _ b: String) -> Bool {
        func origin(_ host: String) -> String {
            var h = host.lowercased()
            if h.hasPrefix("["), h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
            return h.replacingOccurrences(of: "%25", with: "%")
        }
        return origin(a) == origin(b)
    }
}
