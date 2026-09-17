import CoreGraphics
import XCTest
@testable import FremkitCore

final class GestureEngineTests: XCTestCase {
    private let p0 = CGPoint(x: 100, y: 100)

    private func down(_ point: CGPoint, _ time: TimeInterval) -> TouchSample {
        TouchSample(down: true, point: point, time: time)
    }

    private func up(_ point: CGPoint, _ time: TimeInterval) -> TouchSample {
        TouchSample(down: false, point: point, time: time)
    }

    func testTap() {
        let engine = GestureEngine()
        XCTAssertEqual(engine.feed(down(p0, 0)), [])
        XCTAssertEqual(engine.feed(up(p0, 0.08)),
                       [.move(p0), .mouseDown(p0), .mouseUp(p0), .restoreCursor])
    }

    func testDoubleTap() {
        let engine = GestureEngine()
        _ = engine.feed(down(p0, 0))
        _ = engine.feed(up(p0, 0.08))
        _ = engine.feed(down(p0, 0.15))
        XCTAssertEqual(engine.feed(up(p0, 0.2)), [.doubleClick(p0), .restoreCursor])
    }

    func testTwoTapsFarApartInTimeAreTwoSingleTaps() {
        let engine = GestureEngine()
        _ = engine.feed(down(p0, 0))
        let first = engine.feed(up(p0, 0.08))
        _ = engine.feed(down(p0, 0.5))
        let second = engine.feed(up(p0, 0.58))
        XCTAssertEqual(first, [.move(p0), .mouseDown(p0), .mouseUp(p0), .restoreCursor])
        XCTAssertEqual(second, [.move(p0), .mouseDown(p0), .mouseUp(p0), .restoreCursor])
    }

    func testScroll() {
        let engine = GestureEngine()
        XCTAssertEqual(engine.feed(down(p0, 0)), [])
        let moved = CGPoint(x: p0.x + 30, y: p0.y)
        XCTAssertEqual(engine.feed(down(moved, 0.1)), [.scroll(dx: 30, dy: 0, at: moved)])
        // A scroll never clicks.
        XCTAssertEqual(engine.feed(up(moved, 0.2)), [.restoreCursor])
    }

    func testScrollGestureEndsWithRestoreCursor() {
        // The poster warps the cursor onto the Edge to aim the scroll at the kiosk window, so the
        // gesture must always end with the action that puts the pointer back.
        let engine = GestureEngine()
        _ = engine.feed(down(p0, 0))
        var actions: [PointerAction] = []
        for step in 1...4 {
            let point = CGPoint(x: p0.x, y: p0.y + Double(step) * 20)
            actions += engine.feed(down(point, 0.02 * Double(step)))
        }
        let last = CGPoint(x: p0.x, y: p0.y + 80)
        actions += engine.feed(up(last, 0.2))
        XCTAssertEqual(actions.last, .restoreCursor)
        XCTAssertEqual(actions.filter { $0 == .restoreCursor }.count, 1)
    }

    func testScrollEmitsDeltaSincePreviousSample() {
        let engine = GestureEngine()
        _ = engine.feed(down(p0, 0))
        let first = CGPoint(x: p0.x + 30, y: p0.y)
        _ = engine.feed(down(first, 0.1))
        let second = CGPoint(x: p0.x + 45, y: p0.y + 5)
        XCTAssertEqual(engine.feed(down(second, 0.15)), [.scroll(dx: 15, dy: 5, at: second)])
    }

    func testDragAfterHold() {
        let engine = GestureEngine()
        XCTAssertEqual(engine.feed(down(p0, 0)), [])
        XCTAssertEqual(engine.tick(now: 0.4), [])
        let moved = CGPoint(x: p0.x + 30, y: p0.y)
        XCTAssertEqual(engine.feed(down(moved, 0.45)),
                       [.move(p0), .mouseDown(p0), .drag(moved)])
        let further = CGPoint(x: p0.x + 50, y: p0.y)
        XCTAssertEqual(engine.feed(down(further, 0.5)), [.drag(further)])
        XCTAssertEqual(engine.feed(up(further, 0.6)), [.mouseUp(further), .restoreCursor])
    }

    func testLongPress() {
        let engine = GestureEngine()
        XCTAssertEqual(engine.feed(down(p0, 0)), [])
        XCTAssertEqual(engine.tick(now: 0.9), [])
        XCTAssertEqual(engine.feed(up(p0, 0.95)), [.rightClick(p0), .restoreCursor])
    }

    func testHoldReleasedBeforeLongPressIsATap() {
        let engine = GestureEngine()
        _ = engine.feed(down(p0, 0))
        _ = engine.tick(now: 0.4)
        XCTAssertEqual(engine.feed(up(p0, 0.5)),
                       [.move(p0), .mouseDown(p0), .mouseUp(p0), .restoreCursor])
    }

    func testJitterBelowThresholdEmitsNothing() {
        let engine = GestureEngine()
        XCTAssertEqual(engine.feed(down(p0, 0)), [])
        XCTAssertEqual(engine.feed(down(CGPoint(x: p0.x + 5, y: p0.y + 3), 0.05)), [])
        XCTAssertEqual(engine.feed(down(CGPoint(x: p0.x + 2, y: p0.y - 4), 0.1)), [])
    }

    func testTwoTapsFarApartInSpaceAreTwoSingleTaps() {
        let engine = GestureEngine()
        _ = engine.feed(down(p0, 0))
        _ = engine.feed(up(p0, 0.05))
        let elsewhere = CGPoint(x: p0.x + 200, y: p0.y)
        _ = engine.feed(down(elsewhere, 0.1))
        XCTAssertEqual(engine.feed(up(elsewhere, 0.15)),
                       [.move(elsewhere), .mouseDown(elsewhere), .mouseUp(elsewhere), .restoreCursor])
    }
}
