import Foundation

/// What a touch panel that refuses to open for lack of permission needs from the user.
public enum TouchAccessVerdict: Equatable {
    /// Input Monitoring is not granted: it has to be, in System Settings.
    case missing
    /// Input Monitoring is granted, yet the panel still refuses: macOS applies a new grant to a
    /// process only once it is relaunched, so the helper has to be quit and opened again.
    case relaunchNeeded
}

/// Tells "not granted" apart from "granted, but this process does not know it yet".
///
/// The driver keeps retrying a refused open every few seconds, so it notices a grant on its own;
/// this decides what the menu should say while it does. One refusal after the grant is let
/// through, in case the open raced the grant itself; after `refusalsBeforeRelaunch` the user is
/// told to relaunch.
public struct TouchAccessGate {
    public static let refusalsBeforeRelaunch = 2

    private var refusalsWhileGranted = 0

    public init() {}

    /// Called when opening the panel failed with "not permitted"; `inputMonitoring` is what
    /// `IOHIDCheckAccess` says at that moment.
    public mutating func refused(inputMonitoring: PermissionStatus) -> TouchAccessVerdict {
        guard inputMonitoring == .granted else {
            refusalsWhileGranted = 0
            return .missing
        }
        refusalsWhileGranted += 1
        return refusalsWhileGranted >= Self.refusalsBeforeRelaunch ? .relaunchNeeded : .missing
    }

    /// Called when the panel opened, or failed for another reason than permission. Switching
    /// touch off and on does not call it: a grant that needed a relaunch still needs one.
    public mutating func reset() {
        refusalsWhileGranted = 0
    }
}

/// The command that reopens the helper once the current process has exited.
///
/// `open` on a bundle whose app is still running only brings it forward, so the command waits for
/// the process to be gone first — the quit runs the normal shutdown, which stops the server —
/// and gives up waiting after `maxWait` seconds rather than lingering forever. The pid and the
/// path are passed as positional arguments, never spliced into the script.
public enum Relaunch {
    public static let maxWait: TimeInterval = 30

    public static func command(waitingFor pid: Int32, bundlePath: String) -> (executable: String, arguments: [String]) {
        let polls = Int(maxWait / 0.2)
        let script = "i=0; while /bin/kill -0 \"$1\" 2>/dev/null && [ \"$i\" -lt \(polls) ]; do /bin/sleep 0.2; i=$((i+1)); done; exec /usr/bin/open \"$2\""
        return ("/bin/sh", ["-c", script, "fremkit-relaunch", String(pid), bundlePath])
    }
}
