#if FREMKIT_SPARKLE
import AppKit
import Sparkle

/// Sparkle, in the app only: `scripts/build-app.sh` compiles this file with `-D FREMKIT_SPARKLE`
/// and embeds the framework. The developer helper built by `build-helper.sh` has neither, so it
/// never replaces itself with a release over a checkout.
///
/// The feed and the public EdDSA key are in the app's Info.plist (`SUFeedURL`, `SUPublicEDKey`).
/// Installing an update quits the app the normal way, so `applicationWillTerminate` stops the
/// server; the relaunched app starts it again from the new bundle.
final class Updater: NSObject, SPUStandardUserDriverDelegate {
    private var controller: SPUStandardUpdaterController!

    override init() {
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: true,
                                                  updaterDelegate: nil,
                                                  userDriverDelegate: self)
    }

    /// "Check for Updates…": the user asked, so the window comes to the front.
    func checkForUpdates() {
        NSApp.activate(ignoringOtherApps: true)
        controller.checkForUpdates(nil)
    }

    // A menu bar app has no window to come back to, and a scheduled check that pulled the app to
    // the front would take the focus from whatever the user is typing in. Gentle reminders let
    // Sparkle show a found update without activating the app.
    var supportsGentleScheduledUpdateReminders: Bool { true }
}
#endif
