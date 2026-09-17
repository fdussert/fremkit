import CoreGraphics
import XCTest
@testable import FremkitCore

final class DisplayMapperTests: XCTestCase {
    // Bounds of the Xeneon Edge as reported by CGDisplayBounds on the test machine.
    private let bounds = CGRect(x: 1950, y: -1309, width: 2560, height: 720)

    func testMapsOriginCorner() {
        let mapper = DisplayMapper(bounds: bounds)
        XCTAssertEqual(mapper.point(x: 0, y: 0), CGPoint(x: 1950, y: -1309))
    }

    func testMapsOppositeCorner() {
        let mapper = DisplayMapper(bounds: bounds)
        XCTAssertEqual(mapper.point(x: TouchReport.xMax, y: TouchReport.yMax),
                       CGPoint(x: 4510, y: -589))
    }

    func testMapsCentreWithinOnePoint() {
        let mapper = DisplayMapper(bounds: bounds)
        let p = mapper.point(x: 8191, y: 4799)
        XCTAssertEqual(p.x, bounds.midX, accuracy: 1)
        XCTAssertEqual(p.y, bounds.midY, accuracy: 1)
    }

    func testClampsOutOfRangeInput() {
        let mapper = DisplayMapper(bounds: bounds)
        XCTAssertEqual(mapper.point(x: -500, y: -500), CGPoint(x: 1950, y: -1309))
        XCTAssertEqual(mapper.point(x: 99_999, y: 99_999), CGPoint(x: 4510, y: -589))
    }

    func testBoundsAreExposed() {
        XCTAssertEqual(DisplayMapper(bounds: bounds).bounds, bounds)
    }
}
