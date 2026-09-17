import Foundation
import ServiceManagement

/// Thin wrapper over `SMAppService.mainApp`, which registers the app as a login item.
///
/// Registration only works from a signed app bundle; from a bare executable it throws, so every
/// failure is reported through `onFailure` and shown as a disabled line in the status menu rather
/// than being swallowed.
enum LaunchAtLogin {
    /// Called with `true` when register/unregister fails, `false` on success. The reason itself is
    /// only ever English, so it goes to the log rather than to the French menu.
    static var onFailure: ((Bool) -> Void)?

    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    /// True when the registration succeeded but macOS is waiting for the user to approve the
    /// login item in System Settings. Nothing happens at login until they do.
    static var needsApproval: Bool {
        SMAppService.mainApp.status == .requiresApproval
    }

    /// Registers or unregisters the login item; returns the state actually reached.
    @discardableResult
    static func set(_ enabled: Bool) -> Bool {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            onFailure?(false)
        } catch {
            NSLog("fremkit: login item %@ failed: %@",
                  enabled ? "registration" : "removal",
                  error.localizedDescription)
            onFailure?(true)
        }
        return isEnabled
    }
}
