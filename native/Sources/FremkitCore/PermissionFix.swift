import Foundation

/// A pane of System Settings → Privacy & Security.
public enum PrivacyPane: Equatable {
    case inputMonitoring
    case accessibility

    /// The `x-apple.systempreferences:` URL that opens the pane directly.
    public var url: URL {
        let anchor: String
        switch self {
        case .inputMonitoring: anchor = "Privacy_ListenEvent"
        case .accessibility: anchor = "Privacy_Accessibility"
        }
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
    }
}

/// What clicking a status menu line that reports a missing permission does.
public enum PermissionFix: Equatable {
    /// Open this Privacy & Security pane.
    case openPrivacyPane(PrivacyPane)
    /// Open System Settings → General → Login Items, where the login item waits for approval.
    case openLoginItems
    /// Quit the helper and open it again, so macOS applies a grant it already shows as given.
    case relaunch

    /// The fix behind the line showing `key`, or nil for a line that only informs.
    public static func forLine(_ key: L10nKey) -> PermissionFix? {
        switch key {
        case .touchNotPermitted:
            return .openPrivacyPane(.inputMonitoring)
        case .touchAccessibilityMissing, .dockAccessibilityMissing, .fenceMissingPermission:
            return .openPrivacyPane(.accessibility)
        case .loginNeedsApproval:
            return .openLoginItems
        case .touchNeedsRelaunch:
            return .relaunch
        default:
            return nil
        }
    }
}
