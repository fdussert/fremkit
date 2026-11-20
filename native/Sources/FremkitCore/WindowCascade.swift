import CoreGraphics
import Foundation

/// Spreads the windows rescued in one sweep so they do not land exactly on top of each other.
///
/// `AdminPlacement.rescue` centres every window on the same display, so two windows of the same
/// size rescued together (which is what showing the dashboard again after borrowing the Edge
/// produces) would end up one hiding the other. Each further window is stepped down and to the
/// right, as macOS cascades new windows, and the cascade starts over before it leaves the display.
public enum WindowCascade {
    /// The distance between two windows of the cascade, in points, along each axis.
    public static let step: CGFloat = 24

    /**
     Where the `index`-th window of a sweep goes, given where the rescue would put it.

     - Parameters:
       - target: the rescue's frame, inside `screen`.
       - index: 0 for the first window moved in the sweep, 1 for the next, and so on.
       - screen: the display the window is moved to, in the same space as `target`.
     */
    public static func place(_ target: CGRect, index: Int, in screen: CGRect, step: CGFloat = step) -> CGRect {
        guard index > 0, step > 0 else { return target }
        // Room left below and to the right of the window: the cascade has to stay inside it.
        let room = min(screen.maxX - target.maxX, screen.maxY - target.maxY)
        guard room >= step else { return target }
        let positions = Int((room / step).rounded(.down)) + 1
        let offset = CGFloat(index % positions) * step
        return target.offsetBy(dx: offset, dy: offset)
    }
}
