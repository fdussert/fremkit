import ApplicationServices
import Foundation
import FremkitCore
import IOKit.hid

/// The two privacy grants the helper asks for, as thin calls into IOKit and ApplicationServices.
/// When to ask is decided by `PermissionSequencer`, not here.
enum Permissions {
    /// Input Monitoring, which reading the touch panel in HID needs.
    static var inputMonitoring: PermissionStatus {
        switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
        case kIOHIDAccessTypeGranted: return .granted
        case kIOHIDAccessTypeDenied: return .denied
        default: return .unknown
        }
    }

    /// Raises the Input Monitoring prompt when it has never been answered, and in every case
    /// registers the app in System Settings' Input Monitoring list.
    static func requestInputMonitoring() {
        _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    }

    /// Raises the Accessibility prompt unless it is already granted.
    static func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }
}
