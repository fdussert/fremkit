import Foundation

/// What an incoming `fremkit://` URL asks the helper to do.
public enum HelperURLAction: Equatable {
    /// `fremkit://admin` — bring the admin window forward, as the status menu item does.
    case openAdmin
}

/// Reading of the helper's own URL scheme, kept pure so it can be tested without an NSApplication.
public enum HelperURL {
    /// The scheme registered in the bundle's `CFBundleURLTypes`.
    public static let scheme = "fremkit"

    /// The full URL the dashboard (through the server) asks LaunchServices to open.
    public static let admin = "\(scheme)://admin"

    /// The action a URL names, or `nil` when it is not ours or names nothing we know.
    ///
    /// Only the scheme and the target are read; a path, a query or a fragment is ignored, so a
    /// URL can never carry anything the helper would act on beyond the closed list above.
    /// `fremkit:admin` (no slashes, which is how some senders spell it) has no host, so the
    /// path is used as the target in that case.
    public static func action(for url: URL) -> HelperURLAction? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        let host = url.host ?? ""
        let target = (host.isEmpty ? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) : host).lowercased()
        switch target {
        case "admin": return .openAdmin
        default: return nil
        }
    }
}
