import CoreGraphics
import Foundation

/// Where the admin window is allowed to sit.
///
/// The kiosk window covers the Edge display at a level above the status bar, so an ordinary
/// window that lands on that display is buried for good: it is on screen, it takes the focus,
/// and the user sees nothing. That is easy to fall into — the admin window remembers its frame
/// across launches (`setFrameAutosaveName`), and one drag onto the Edge, or a display
/// rearrangement, is enough to park it there permanently.
///
/// So the placement is checked on every open rather than only at creation, and the geometry
/// lives here, away from AppKit, so it can be tested with plain rectangles.
public enum AdminPlacement {
    /// Smallest part of the window that has to be visible for a frame to count as reachable.
    public static let minimumVisible = CGSize(width: 240, height: 120)

    /**
     Whether a frame is somewhere the user can actually get at.

     - Parameters:
       - frame: the window's frame, in AppKit screen space.
       - screens: the frames of the available screens, in the same space.
       - kiosk: the frame the kiosk covers, or `nil` when there is no Edge display.

     A frame is usable when it overlaps no part of the kiosk *and* enough of it falls inside some
     screen. Touching the kiosk at all is disqualifying: a window straddling the boundary would
     have its title bar reachable but its content hidden, which is worse than being moved.
     */
    public static func isUsable(frame: CGRect, screens: [CGRect], kiosk: CGRect?) -> Bool {
        if let kiosk, frame.intersects(kiosk) { return false }
        return screens.contains { screen in
            let visible = screen.intersection(frame)
            return !visible.isNull
                && visible.width >= minimumVisible.width
                && visible.height >= minimumVisible.height
        }
    }

    /**
     The frame to move the window to, or `nil` when where it is is fine.

     `size` is the size to give a window that has to move; it is shrunk to fit when the target
     screen is smaller than it.
     */
    public static func rescue(frame: CGRect, size: CGSize, screens: [CGRect], kiosk: CGRect?) -> CGRect? {
        if isUsable(frame: frame, screens: screens, kiosk: kiosk) { return nil }
        guard let screen = target(screens: screens, kiosk: kiosk) else { return nil }
        return centred(size: size, in: screen)
    }

    /**
     The screen to open on: the first that is not the kiosk's.

     `screens` is expected in the order AppKit reports it, which puts the screen the user is
     working on first. When every screen is the kiosk's — a Mac whose only display is the Edge —
     this answers `nil` and the caller leaves the window where it is: there is nowhere better,
     and moving it would not help.
     */
    public static func target(screens: [CGRect], kiosk: CGRect?) -> CGRect? {
        screens.first { screen in
            guard let kiosk else { return true }
            return !screen.intersects(kiosk)
        }
    }

    /// `size` centred in `screen`, shrunk to fit and rounded to whole points.
    public static func centred(size: CGSize, in screen: CGRect) -> CGRect {
        let width = min(size.width, screen.width)
        let height = min(size.height, screen.height)
        return CGRect(x: (screen.midX - width / 2).rounded(),
                      y: (screen.midY - height / 2).rounded(),
                      width: width,
                      height: height)
    }
}
