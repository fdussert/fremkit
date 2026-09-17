import CoreGraphics
import Foundation

/// Maps raw panel coordinates onto the global coordinate space of a display.
public struct DisplayMapper {
    /// Global bounds of the target display, as reported by `CGDisplayBounds`.
    public var bounds: CGRect

    public init(bounds: CGRect) {
        self.bounds = bounds
    }

    /// Converts a touch position into a global point, clamped into `bounds`.
    public func point(x: Int, y: Int) -> CGPoint {
        let clampedX = min(max(x, 0), TouchReport.xMax)
        let clampedY = min(max(y, 0), TouchReport.yMax)
        let ratioX = Double(clampedX) / Double(TouchReport.xMax)
        let ratioY = Double(clampedY) / Double(TouchReport.yMax)
        return CGPoint(x: bounds.origin.x + ratioX * bounds.width,
                       y: bounds.origin.y + ratioY * bounds.height)
    }
}
