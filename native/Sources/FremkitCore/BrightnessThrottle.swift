import Foundation

/// Coalesces brightness writes: at most one every `interval`, and the last value asked for wins.
///
/// A slider dragged across the Edge asks for dozens of levels a second; DDC is slow and monitors
/// drop commands sent too close together. The first value goes out at once, the ones that arrive
/// during the interval collapse into the latest, which goes out when the interval is over. Pure:
/// the caller owns the clock and the timer.
public struct BrightnessThrottle {
    public let interval: TimeInterval
    private var lastWrite: TimeInterval?
    /// The value waiting for the interval to end, if any.
    public private(set) var pending: Int?

    public init(interval: TimeInterval = 0.1) {
        self.interval = interval
    }

    /// A new value. Returns it when it may be written now; otherwise it is kept for `due`.
    public mutating func offer(_ value: Int, now: TimeInterval) -> Int? {
        if let last = lastWrite, now - last < interval {
            pending = value
            return nil
        }
        pending = nil
        lastWrite = now
        return value
    }

    /// When the pending value may go out, or nil when nothing waits.
    public var deadline: TimeInterval? {
        guard pending != nil else { return nil }
        return (lastWrite ?? 0) + interval
    }

    /// The pending value, once its time has come.
    public mutating func due(now: TimeInterval) -> Int? {
        guard let value = pending, let deadline, now >= deadline else { return nil }
        pending = nil
        lastWrite = now
        return value
    }
}
