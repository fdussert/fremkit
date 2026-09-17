import Foundation

/// Telling this project's server from anything else that answers on the port.
public enum ServerProbe {
    /// Largest `/api/config` body worth parsing to answer the question.
    public static let maxProbeBytes = 8 * 1024 * 1024

    /**
     Whether an `/api/config` body is one of ours.

     The helper stands down and stops supervising when it finds a server already on its port —
     that is what lets `pnpm dev` take over — and it used to decide that on the status code
     alone, so any program answering anything between 200 and 499 made it give up, with no way
     back but a relaunch.

     Only the shape is checked: a JSON object carrying the two keys every Fremkit config has.
     Enough to tell our server from something else, and nothing a future config version breaks.
     */
    public static func looksLikeFremkitConfig(_ data: Data?) -> Bool {
        guard let data, !data.isEmpty, data.count < maxProbeBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return object["version"] != nil && object["pages"] is [Any]
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
