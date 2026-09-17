import CoreGraphics
import XCTest
@testable import FremkitCore

final class FenceMathTests: XCTestCase {
    // Global bounds of the Edge display: y runs from -1309 (top) to -589 (bottom).
    private let edge = CGRect(x: 1950, y: -1309, width: 2560, height: 720)
    // The real primary display. It touches none of the Edge's sides.
    private let primary = CGRect(x: 0, y: 0, width: 1512, height: 982)
    // A fictional display wrapping the Edge on every side, used to exercise the side projection.
    private let around = CGRect(x: 1000, y: -2000, width: 4000, height: 2500)

    func testPointOutsideEdgeIsLeftAlone() {
        XCTAssertNil(FenceMath.clamp(CGPoint(x: 100, y: 100), edge: edge, last: nil, safe: primary))
        XCTAssertNil(FenceMath.clamp(CGPoint(x: 5000, y: -700), edge: edge,
                                     last: CGPoint(x: 100, y: 100), safe: primary))
    }

    func testPointInsideEdgeReturnsLastKnownOutsidePosition() {
        let last = CGPoint(x: 800, y: 400)
        XCTAssertEqual(FenceMath.clamp(CGPoint(x: 3000, y: -700), edge: edge, last: last, safe: primary),
                       last)
    }

    func testLastPositionInsideEdgeIsIgnoredAndTheEdgeIsProjected() {
        let last = CGPoint(x: 2000, y: -1000)
        XCTAssertEqual(FenceMath.clamp(CGPoint(x: 3000, y: -700), edge: edge, last: last, safe: around),
                       CGPoint(x: 3000, y: -588))
    }

    func testProjectionOnNearestEdgeWithoutLastPosition() {
        // Nearest side of (3000, -700) is the bottom edge at maxY = -589.
        XCTAssertEqual(FenceMath.clamp(CGPoint(x: 3000, y: -700), edge: edge, last: nil, safe: around),
                       CGPoint(x: 3000, y: -588))
        // Close to the left side.
        XCTAssertEqual(FenceMath.clamp(CGPoint(x: 1960, y: -950), edge: edge, last: nil, safe: around),
                       CGPoint(x: 1949, y: -950))
        // Close to the right side.
        XCTAssertEqual(FenceMath.clamp(CGPoint(x: 4500, y: -950), edge: edge, last: nil, safe: around),
                       CGPoint(x: 4511, y: -950))
        // Close to the top side.
        XCTAssertEqual(FenceMath.clamp(CGPoint(x: 3000, y: -1300), edge: edge, last: nil, safe: around),
                       CGPoint(x: 3000, y: -1310))
    }

    func testFallbackLandsInsideTheSafeRectangleWithTheRealLayout() {
        // With the real layout the Edge touches no other display, so every side projection lands
        // on no display at all and the cursor must go to the centre of the primary instead.
        let centre = CGPoint(x: 756, y: 491)
        for point in [CGPoint(x: 3000, y: -700),
                      CGPoint(x: 1960, y: -950),
                      CGPoint(x: 4500, y: -950),
                      CGPoint(x: 3000, y: -1300)] {
            let clamped = FenceMath.clamp(point, edge: edge, last: nil, safe: primary)
            XCTAssertEqual(clamped, centre)
            XCTAssertTrue(primary.contains(clamped ?? .zero))
        }
    }

    func testCornerTieBreakPrefersTheLeftSide() {
        // Exactly in the top-left corner the left and top distances tie; left wins.
        XCTAssertEqual(FenceMath.clamp(CGPoint(x: 1950, y: -1309), edge: edge, last: nil, safe: around),
                       CGPoint(x: 1949, y: -1309))
    }
}
