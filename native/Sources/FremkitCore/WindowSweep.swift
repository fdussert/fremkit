import CoreGraphics
import Foundation

/// One window of another application sitting where the kiosk is.
public struct StrayWindow: Equatable {
    public let id: CGWindowID
    public let pid: pid_t
    public let frame: CGRect

    public init(id: CGWindowID, pid: pid_t, frame: CGRect) {
        self.id = id
        self.pid = pid
        self.frame = frame
    }
}

/// Which windows have to be moved off the Edge display.
///
/// The kiosk covers that display above the status-bar level, so a window that opens there is
/// buried: it is on screen, it holds the focus and the keyboard, and the user sees the dashboard.
/// The mouse fence already keeps the pointer out, but nothing stops an application from *placing*
/// a window there, which is what happens when Safari or the Finder restores a frame it saved
/// before the Edge was set up, or when a display is rearranged under windows that were fine.
///
/// The reading of `CGWindowListCopyWindowInfo` lives here, away from AppKit and the Accessibility
/// API, so the rules can be tested with plain dictionaries.
public enum WindowSweep {
    /// The windows that overlap `edge` and belong to somebody else, in the order they are listed.
    ///
    /// - Parameters:
    ///   - infos: what `CGWindowListCopyWindowInfo` answered, on-screen windows.
    ///   - edge: the Edge display's bounds, in the same space as the window bounds.
    ///   - ownPid: this process, whose own kiosk window covers the whole Edge on purpose.
    public static func strays(in infos: [[String: Any]], edge: CGRect, ownPid: pid_t) -> [StrayWindow] {
        infos.compactMap { info in
            // Layer 0 is an ordinary window. Everything else (the Dock, the menu bar extras, a
            // screen saver, the kiosk itself) is furniture that is meant to be above or below.
            guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { return nil }
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid != ownPid else { return nil }
            guard let id = info[kCGWindowNumber as String] as? CGWindowID else { return nil }
            guard let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
            // Touching the Edge at all counts: a window straddling the boundary has the part the
            // user reads on the display they cannot see.
            guard !frame.isEmpty, frame.intersects(edge) else { return nil }
            return StrayWindow(id: id, pid: pid, frame: frame)
        }
    }

    /// The window numbers of every window in `infos`, whatever it is.
    ///
    /// The caller counts its attempts per window, and a number that is gone from this set belongs
    /// to a window that closed: forgetting it there keeps the count from outliving the window.
    public static func present(in infos: [[String: Any]]) -> Set<CGWindowID> {
        Set(infos.compactMap { $0[kCGWindowNumber as String] as? CGWindowID })
    }
}
