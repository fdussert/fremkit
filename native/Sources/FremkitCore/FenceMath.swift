import CoreGraphics
import Foundation

/// Geometry of the mouse fence that keeps the pointer off the Edge display.
public enum FenceMath {
    /// Returns where the cursor should be pushed back to, or nil when it is already outside `edge`.
    ///
    /// - Parameters:
    ///   - p: the cursor position reported by the event tap.
    ///   - edge: global bounds of the Edge display.
    ///   - last: last known position outside `edge`, if any.
    ///   - safe: a rectangle known to be on a real display (the main display bounds). It is the
    ///     landing zone when `last` is unusable: the Edge is not necessarily adjacent to any
    ///     other display, so a point "just outside" it can belong to no display at all, and
    ///     `CGWarpMouseCursorPosition` would then clamp the cursor straight back onto the Edge.
    public static func clamp(_ p: CGPoint, edge: CGRect, last: CGPoint?, safe: CGRect) -> CGPoint? {
        guard edge.contains(p) else { return nil }
        if let last, !edge.contains(last) { return last }
        return projectOutside(p, edge: edge, safe: safe)
    }

    /// Projects a point one point outside the nearest side of `edge`, or onto the centre of
    /// `safe` when that projection would land on no display.
    private static func projectOutside(_ p: CGPoint, edge: CGRect, safe: CGRect) -> CGPoint {
        let toLeft = p.x - edge.minX
        let toRight = edge.maxX - p.x
        let toTop = p.y - edge.minY
        let toBottom = edge.maxY - p.y
        let nearest = min(toLeft, toRight, toTop, toBottom)
        // Exactly in a corner two distances tie; `switch` takes the first matching case, so the
        // order below is the tie-break: left, then right, then top, then bottom.
        let projected: CGPoint
        switch nearest {
        case toLeft: projected = CGPoint(x: edge.minX - 1, y: p.y)
        case toRight: projected = CGPoint(x: edge.maxX + 1, y: p.y)
        case toTop: projected = CGPoint(x: p.x, y: edge.minY - 1)
        default: projected = CGPoint(x: p.x, y: edge.maxY + 1)
        }
        guard safe.contains(projected) else { return CGPoint(x: safe.midX, y: safe.midY) }
        return projected
    }
}
