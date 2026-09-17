import CoreGraphics
import Foundation

/// One HID touch report already mapped to global display coordinates.
public struct TouchSample: Equatable {
    public let down: Bool
    public let point: CGPoint
    public let time: TimeInterval

    public init(down: Bool, point: CGPoint, time: TimeInterval) {
        self.down = down
        self.point = point
        self.time = time
    }
}

/// A pointer event the helper should post, or a cursor bookkeeping request.
public enum PointerAction: Equatable {
    case move(CGPoint)
    case mouseDown(CGPoint)
    case mouseUp(CGPoint)
    case drag(CGPoint)
    case doubleClick(CGPoint)
    case rightClick(CGPoint)
    /// Raw finger displacement since the previous sample; the poster picks the sign convention.
    case scroll(dx: Double, dy: Double, at: CGPoint)
    /// Emitted once at the end of every completed gesture.
    case restoreCursor
}

/// Tunable limits of the gesture recogniser.
public struct GestureThresholds {
    /// Displacement above which a finger counts as moving, in points.
    public var movePx: Double = 12
    /// Motionless delay after which a press becomes a hold.
    public var holdSeconds: Double = 0.35
    /// Hold duration after which a release is a right click instead of a tap.
    public var longPressSeconds: Double = 0.8
    /// Maximum delay between two taps for them to form a double click.
    public var doubleTapSeconds: Double = 0.3
    /// Maximum distance between two taps for them to form a double click.
    public var doubleTapPx: Double = 20

    public init() {}
}

/// Single-touch gesture recogniser: pure logic, driven by an injected clock.
public final class GestureEngine {
    private enum State {
        case idle
        /// Finger down, still undecided between tap, hold, scroll and drag.
        case pressed(origin: CGPoint, start: TimeInterval, last: CGPoint)
        case scrolling(last: CGPoint)
        case dragging(last: CGPoint)
        /// Finger held still long enough to arm a drag or a right click.
        case holding(origin: CGPoint, start: TimeInterval)
    }

    private let thresholds: GestureThresholds
    private var state: State = .idle
    private var lastTap: (point: CGPoint, time: TimeInterval)?

    public init(thresholds: GestureThresholds = .init()) {
        self.thresholds = thresholds
    }

    /// Feeds one HID report; returns the actions caused by this sample only.
    public func feed(_ s: TouchSample) -> [PointerAction] {
        s.down ? handleDown(s) : handleUp(s)
    }

    /// Advances the clock without a new sample, so a motionless press can become a hold.
    public func tick(now: TimeInterval) -> [PointerAction] {
        if case let .pressed(origin, start, _) = state, now - start >= thresholds.holdSeconds {
            state = .holding(origin: origin, start: start)
        }
        return []
    }

    private func handleDown(_ s: TouchSample) -> [PointerAction] {
        switch state {
        case .idle:
            state = .pressed(origin: s.point, start: s.time, last: s.point)
            return []

        case let .pressed(origin, start, last):
            let moved = Self.distance(s.point, origin) > thresholds.movePx
            if moved && s.time - start < thresholds.holdSeconds {
                state = .scrolling(last: s.point)
                return [.scroll(dx: s.point.x - last.x, dy: s.point.y - last.y, at: s.point)]
            }
            if s.time - start >= thresholds.holdSeconds {
                if moved { return startDrag(origin: origin, to: s.point) }
                state = .holding(origin: origin, start: start)
                return []
            }
            // Jitter below the movement threshold: no action, but keep the scroll reference.
            state = .pressed(origin: origin, start: start, last: s.point)
            return []

        case let .holding(origin, _):
            guard Self.distance(s.point, origin) > thresholds.movePx else { return [] }
            return startDrag(origin: origin, to: s.point)

        case let .scrolling(last):
            state = .scrolling(last: s.point)
            return [.scroll(dx: s.point.x - last.x, dy: s.point.y - last.y, at: s.point)]

        case .dragging:
            state = .dragging(last: s.point)
            return [.drag(s.point)]
        }
    }

    private func handleUp(_ s: TouchSample) -> [PointerAction] {
        defer { state = .idle }
        switch state {
        case .idle:
            return []

        case let .pressed(origin, start, _):
            return endPress(origin: origin, start: start, end: s.time)

        case let .holding(origin, start):
            return endPress(origin: origin, start: start, end: s.time)

        case .dragging:
            return [.mouseUp(s.point), .restoreCursor]

        case .scrolling:
            // A scroll never clicks.
            return [.restoreCursor]
        }
    }

    private func startDrag(origin: CGPoint, to point: CGPoint) -> [PointerAction] {
        state = .dragging(last: point)
        return [.move(origin), .mouseDown(origin), .drag(point)]
    }

    /// Turns a release from `pressed`/`holding` into a tap, a double click or a right click.
    private func endPress(origin: CGPoint, start: TimeInterval, end: TimeInterval) -> [PointerAction] {
        if end - start >= thresholds.longPressSeconds {
            lastTap = nil
            return [.rightClick(origin), .restoreCursor]
        }
        if let previous = lastTap,
           end - previous.time < thresholds.doubleTapSeconds,
           Self.distance(origin, previous.point) < thresholds.doubleTapPx {
            lastTap = nil
            return [.doubleClick(origin), .restoreCursor]
        }
        lastTap = (origin, end)
        return [.move(origin), .mouseDown(origin), .mouseUp(origin), .restoreCursor]
    }

    private static func distance(_ a: CGPoint, _ b: CGPoint) -> Double {
        let dx = a.x - b.x, dy = a.y - b.y
        return (dx * dx + dy * dy).squareRoot()
    }
}
