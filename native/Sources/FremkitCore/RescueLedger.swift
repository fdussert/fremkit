import CoreGraphics
import Foundation

/// How many times each window found on the Edge has been moved off it, per episode.
///
/// An application that puts its window straight back would otherwise be fought forever, with the
/// window flickering across two displays, so a window is moved at most `maxAttempts` times and
/// then left alone. But a count that lasted as long as the window would leave a long-lived one
/// (a Finder window, a mail viewer) stranded the next time it lands there, weeks later. So the
/// count belongs to an *episode*: it is forgotten once the window has stayed off the Edge for
/// `forgetAfter` seconds, and while it keeps coming back sooner than that, it keeps counting.
///
/// Time is passed in, in seconds on any monotonic clock, so the rules can be tested without one.
public struct RescueLedger {
    public let maxAttempts: Int
    public let forgetAfter: TimeInterval

    private struct Entry {
        var attempts = 0
        /// The last sweep that saw the window on the Edge.
        var lastOnEdge: TimeInterval
    }

    private var entries: [CGWindowID: Entry] = [:]

    public init(maxAttempts: Int = 3, forgetAfter: TimeInterval = 30) {
        self.maxAttempts = maxAttempts
        self.forgetAfter = forgetAfter
    }

    /// Records one reading of the window list.
    ///
    /// - Parameters:
    ///   - onEdge: the windows found on the Edge this time.
    ///   - present: every window that exists. One missing from it closed, and its number may be
    ///     handed to a new window, which has to start from zero.
    ///   - now: the time of the reading.
    public mutating func observe(onEdge: Set<CGWindowID>, present: Set<CGWindowID>, now: TimeInterval) {
        entries = entries.filter { id, entry in
            guard present.contains(id) else { return false }
            return onEdge.contains(id) || now - entry.lastOnEdge < forgetAfter
        }
        for id in onEdge where entries[id] != nil {
            entries[id]?.lastOnEdge = now
        }
    }

    /// Whether the window on the Edge may be moved now; a yes counts as one attempt.
    public mutating func takeAttempt(_ id: CGWindowID, now: TimeInterval) -> Bool {
        var entry = entries[id] ?? Entry(lastOnEdge: now)
        entry.lastOnEdge = now
        guard entry.attempts < maxAttempts else {
            entries[id] = entry
            return false
        }
        entry.attempts += 1
        entries[id] = entry
        return true
    }

    /// The attempts spent on a window in its current episode.
    public func attempts(of id: CGWindowID) -> Int {
        entries[id]?.attempts ?? 0
    }

    /// Forgets everything, as when the fence stops.
    public mutating func reset() {
        entries = [:]
    }
}
