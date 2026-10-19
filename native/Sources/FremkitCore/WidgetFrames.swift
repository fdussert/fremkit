import Foundation

/// Where a frame inside the dashboard or the admin may go.
public enum WidgetFrames {
    /**
     True when a subframe may load `candidate`: a widget document on the page's own origin, that
     is a path under `/widgets/`.

     Every frame the dashboard and the admin draw is a widget, and a widget is third-party code
     in a sandbox that may still navigate its own frame. Sent anywhere else — `https://…?d=<its
     data>` — the request itself is the leak, whatever the page later does with it. The host
     pages' CSP (`frame-src <origin>/widgets/`) refuses the same thing; this is the web view
     saying it too, so it holds even for a page served without that header.

     `about:blank` and `srcdoc` are refused as well: neither page creates such a frame, and a
     widget's CSP (`frame-src 'none'`) means a widget cannot either.
     */
    public static func allows(_ candidate: URL?, on origin: URL) -> Bool {
        guard let candidate, KioskOrigin.sameOrigin(candidate, as: origin) else { return false }
        // Credentials in the URL are never a widget's: refused like the iPad app does.
        guard candidate.user == nil, candidate.password == nil else { return false }
        // Dot segments are refused rather than resolved: `/widgets/../admin` is not a widget.
        let path = candidate.path
        guard candidate.absoluteString.range(of: "%2e", options: .caseInsensitive) == nil,
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0 == "." })
        else { return false }
        let components = URLComponents(url: candidate, resolvingAgainstBaseURL: false)
        let rawPath = components?.percentEncodedPath ?? path
        return rawPath.hasPrefix("/widgets/") && rawPath.count > "/widgets/".count
    }
}
