import Foundation

/// Ordering the version directories a Node version manager keeps.
public enum NodeVersionOrder {
    /**
     True when `a` is a newer version than `b`.

     Compared number by number, never as text: the text order puts `v9.9.9` after `v20.1.2`,
     which is exactly how a years-old Node gets picked to run the dashboard.
     */
    public static func newer(_ a: String, _ b: String) -> Bool {
        let parts: (String) -> [Int] = { $0.drop(while: { !$0.isNumber }).split(separator: ".").map { Int($0) ?? 0 } }
        let (x, y) = (parts(a), parts(b))
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0
            let r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
    }
}

/// Where the kiosk window is allowed to go.
public enum KioskOrigin {
    /**
     True when two URLs share a scheme, a host and a port.

     The kiosk window has no chrome and no way back, so a main-frame navigation anywhere but the
     dashboard would strand the Edge on that page until the helper is quit.
     */
    public static func sameOrigin(_ candidate: URL?, as origin: URL) -> Bool {
        guard let candidate,
              let scheme = candidate.scheme?.lowercased(),
              let host = candidate.host?.lowercased(),
              let originScheme = origin.scheme?.lowercased(),
              let originHost = origin.host?.lowercased()
        else { return false }
        return scheme == originScheme && host == originHost && candidate.port == origin.port
    }
}

/// Which links the admin window hands to the default browser.
public enum ExternalLink {
    /**
     True when a link belongs in the user's browser rather than in the admin window: an `http`
     or `https` address on another origin than the admin's own.

     The admin window has no address bar and no back button, so another site loaded in it would
     replace the admin with no way back but a reload. Any other scheme — `file:`, `javascript:`,
     an application's own — answers false: it is not handed to whatever claims it. Nor does it
     load in the admin: `AdminOrigin` pins the window's main frame to the admin's own origin.
     */
    public static func opensInBrowser(_ candidate: URL?, from admin: URL) -> Bool {
        guard let candidate,
              let scheme = candidate.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              candidate.host?.isEmpty == false
        else { return false }
        return !KioskOrigin.sameOrigin(candidate, as: admin)
    }
}

/// Where the admin window's main frame may go.
public enum AdminOrigin {
    /**
     True for a URL on the admin's own scheme, host and port, and for `about:blank`, which
     WebKit loads into a fresh view before anything else. Anything else in the main frame would
     replace the admin — and with it the only page in the window that holds a session — with
     something that is not ours.
     */
    public static func allows(_ candidate: URL?, admin: URL) -> Bool {
        if candidate?.absoluteString == "about:blank" { return true }
        return KioskOrigin.sameOrigin(candidate, as: admin)
    }
}
