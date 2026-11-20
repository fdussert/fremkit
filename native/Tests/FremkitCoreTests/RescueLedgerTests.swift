import CoreGraphics
import XCTest
@testable import FremkitCore

final class RescueLedgerTests: XCTestCase {
    /// One sweep every two seconds, as the window fence runs: the window is on the Edge, the
    /// ledger reads the list, and the fence asks whether it may move it.
    private func sweep(_ ledger: inout RescueLedger, onEdge: Set<CGWindowID>, present: Set<CGWindowID>? = nil,
                       at now: TimeInterval) -> [CGWindowID] {
        ledger.observe(onEdge: onEdge, present: present ?? onEdge, now: now)
        return onEdge.sorted().filter { ledger.decide($0, now: now) == .move }
    }

    func testAWindowPutStraightBackIsMovedThreeTimesThenLeftAlone() {
        var ledger = RescueLedger()
        var moved = 0
        for tick in 0..<10 {
            moved += sweep(&ledger, onEdge: [7], at: TimeInterval(tick * 2)).count
        }
        XCTAssertEqual(moved, 3)
        XCTAssertEqual(ledger.attempts(of: 7), 3)
    }

    func testTheCountIsForgottenOnceTheWindowStaysOffTheEdgeForThirtySeconds() {
        var ledger = RescueLedger()
        for tick in 0..<3 { _ = sweep(&ledger, onEdge: [7], present: [7], at: TimeInterval(tick)) }
        XCTAssertEqual(ledger.decide(7, now: 3), .giveUp)
        // Last seen on the Edge at 3; still there, but elsewhere, for the next 30 seconds.
        _ = sweep(&ledger, onEdge: [], present: [7], at: 20)
        XCTAssertEqual(ledger.attempts(of: 7), 3)
        _ = sweep(&ledger, onEdge: [], present: [7], at: 33)
        XCTAssertEqual(ledger.attempts(of: 7), 0)
        // Weeks later it lands there again, and is rescued again.
        XCTAssertEqual(sweep(&ledger, onEdge: [7], at: 3_000_000), [7])
    }

    func testNoResetWhileTheWindowKeepsComingBackWithinThirtySeconds() {
        var ledger = RescueLedger()
        // The application puts it back every 20 seconds, each time after it was moved.
        var moved = 0
        for episode in 0..<10 {
            let t = TimeInterval(episode * 20)
            moved += sweep(&ledger, onEdge: [7], present: [7], at: t).count
            _ = sweep(&ledger, onEdge: [], present: [7], at: t + 10)
        }
        XCTAssertEqual(moved, 3)
    }

    func testAClosedWindowTakesItsCountWithIt() {
        var ledger = RescueLedger()
        for tick in 0..<3 { _ = sweep(&ledger, onEdge: [7], at: TimeInterval(tick)) }
        _ = sweep(&ledger, onEdge: [], present: [], at: 4)
        XCTAssertEqual(ledger.attempts(of: 7), 0)
        // The number handed to a new window starts from zero.
        XCTAssertEqual(sweep(&ledger, onEdge: [7], at: 5), [7])
    }

    func testWindowsAreCountedSeparately() {
        var ledger = RescueLedger()
        for tick in 0..<3 { _ = sweep(&ledger, onEdge: [7], at: TimeInterval(tick)) }
        XCTAssertEqual(sweep(&ledger, onEdge: [7, 8], at: 4), [8])
    }

    func testGivingUpIsReportedOncePerEpisode() {
        var ledger = RescueLedger()
        var decisions: [RescueLedger.Decision] = []
        for tick in 0..<6 {
            ledger.observe(onEdge: [7], present: [7], now: TimeInterval(tick))
            decisions.append(ledger.decide(7, now: TimeInterval(tick)))
        }
        XCTAssertEqual(decisions, [.move, .move, .move, .giveUp, .leaveAlone, .leaveAlone])
        // A new episode can be given up on, and reported, again.
        ledger.observe(onEdge: [], present: [7], now: 100)
        let again = (0..<5).map { ledger.decide(7, now: TimeInterval(200 + $0)) }
        XCTAssertEqual(again, [.move, .move, .move, .giveUp, .leaveAlone])
    }

    func testResetForgetsEverything() {
        var ledger = RescueLedger()
        for tick in 0..<3 { _ = sweep(&ledger, onEdge: [7], at: TimeInterval(tick)) }
        ledger.reset()
        XCTAssertEqual(ledger.attempts(of: 7), 0)
    }
}
