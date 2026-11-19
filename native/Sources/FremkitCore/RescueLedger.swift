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
    /// What to do about a window found on the Edge.
    public enum Decision: Equatable {
        /// Move it; this counts as one attempt.
        case move
        /// Its last attempt did not stick: say so once, and leave it there.
        case giveUp
        /// Already given up on in this episode.
        case leaveAlone
    }

    public let maxAttempts: Int
    public let forgetAfter: TimeInterval

    private struct Entry {
        var attempts = 0
        var gaveUp = false
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

    /// What to do about a window found on the Edge now.
    public mutating func decide(_ id: CGWindowID, now: TimeInterval) -> Decision {
        var entry = entries[id] ?? Entry(lastOnEdge: now)
        entry.lastOnEdge = now
        defer { entries[id] = entry }
        guard entry.attempts < maxAttempts else {
            if entry.gaveUp { return .leaveAlone }
            entry.gaveUp = true
            return .giveUp
        }
        entry.attempts += 1
        return .move
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
