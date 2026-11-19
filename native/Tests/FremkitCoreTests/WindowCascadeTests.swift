import CoreGraphics
import XCTest
@testable import FremkitCore

final class WindowCascadeTests: XCTestCase {
    private let main = CGRect(x: 0, y: 0, width: 1512, height: 982)

    func testTheFirstWindowStaysWhereTheRescuePutIt() {
        let target = AdminPlacement.centred(size: CGSize(width: 800, height: 500), in: main)
        XCTAssertEqual(WindowCascade.place(target, index: 0, in: main), target)
    }

    func testEachFurtherWindowIsSteppedDownAndRight() {
        // Same-sized windows rescued in one sweep would otherwise all land at the same centre.
        let target = AdminPlacement.centred(size: CGSize(width: 800, height: 500), in: main)
        let placed = (0..<3).map { WindowCascade.place(target, index: $0, in: main) }
        XCTAssertEqual(placed.map(\.origin), [target.origin,
                                              CGPoint(x: target.minX + 24, y: target.minY + 24),
                                              CGPoint(x: target.minX + 48, y: target.minY + 48)])
        XCTAssertTrue(placed.allSatisfy { $0.size == target.size })
    }

    func testTheCascadeWrapsSoEveryWindowStaysOnTheDisplay() {
        let target = AdminPlacement.centred(size: CGSize(width: 800, height: 500), in: main)
        // 241 pt of room below the window: ten steps fit, so the twelfth window starts over.
        for index in 0..<40 {
            let placed = WindowCascade.place(target, index: index, in: main)
            XCTAssertTrue(main.contains(placed), "index \(index): \(placed)")
        }
        XCTAssertEqual(WindowCascade.place(target, index: 11, in: main), target)
    }

    func testAWindowAsLargeAsTheDisplayIsNotOffset() {
        let target = AdminPlacement.centred(size: CGSize(width: 4000, height: 4000), in: main)
        XCTAssertEqual(WindowCascade.place(target, index: 3, in: main), target)
    }

    func testWorksOnADisplayAwayFromTheOrigin() {
        let left = CGRect(x: -1920, y: -200, width: 1920, height: 1080)
        let target = AdminPlacement.centred(size: CGSize(width: 600, height: 400), in: left)
        let placed = WindowCascade.place(target, index: 2, in: left)
        XCTAssertEqual(placed.origin, CGPoint(x: target.minX + 48, y: target.minY + 48))
        XCTAssertTrue(left.contains(placed))
    }
}
