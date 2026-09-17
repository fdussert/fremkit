import CoreGraphics
import Foundation
import XCTest
@testable import FremkitCore

/// The real arrangement this was written for: a 1512x982 laptop screen at the AppKit origin and
/// the 2560x720 Edge above and to the right of it, where the kiosk lives.
private let laptop = CGRect(x: 0, y: 0, width: 1512, height: 982)
private let edge = CGRect(x: 1950, y: 1571, width: 2560, height: 720)
private let screens = [laptop, edge]
private let adminSize = CGSize(width: 1280, height: 800)

final class AdminPlacementTests: XCTestCase {
    func testAFrameOnTheLaptopIsLeftAlone() {
        let frame = CGRect(x: 100, y: 100, width: 1280, height: 800)
        XCTAssertTrue(AdminPlacement.isUsable(frame: frame, screens: screens, kiosk: edge))
        XCTAssertNil(AdminPlacement.rescue(frame: frame, size: adminSize, screens: screens, kiosk: edge))
    }

    func testAFrameOnTheKioskDisplayIsMovedToTheLaptop() {
        // What the autosaved frame actually held: the admin parked on the Edge, where the kiosk
        // covers it at a level above the status bar and the user sees nothing at all.
        let buried = CGRect(x: 2101, y: 1571, width: 2201, height: 690)
        let rescued = AdminPlacement.rescue(frame: buried, size: adminSize, screens: screens, kiosk: edge)
        XCTAssertNotNil(rescued)
        XCTAssertTrue(laptop.contains(rescued!))
        XCTAssertFalse(rescued!.intersects(edge))
        XCTAssertEqual(rescued!.width, 1280)
        XCTAssertEqual(rescued!.height, 800)
    }

    func testAFrameOverlappingTheKioskEvenSlightlyIsMoved() {
        // Straddling the boundary is worse than being moved: the title bar is reachable and the
        // content is not.
        let straddling = CGRect(x: 1900, y: 1500, width: 200, height: 200)
        XCTAssertTrue(straddling.intersects(edge))
        XCTAssertFalse(AdminPlacement.isUsable(frame: straddling, screens: screens, kiosk: edge))
        XCTAssertNotNil(AdminPlacement.rescue(frame: straddling, size: adminSize, screens: screens, kiosk: edge))
    }

    func testAFrameOnNoScreenAtAllIsMoved() {
        // The display it was saved on is gone.
        let orphan = CGRect(x: -4000, y: -4000, width: 1280, height: 800)
        XCTAssertFalse(AdminPlacement.isUsable(frame: orphan, screens: screens, kiosk: edge))
        XCTAssertNotNil(AdminPlacement.rescue(frame: orphan, size: adminSize, screens: screens, kiosk: edge))
    }

    func testAFrameBarelyOnScreenIsMoved() {
        // A window nudged almost entirely off the bottom-right corner is not reachable either.
        let sliver = CGRect(x: 1400, y: 900, width: 1280, height: 800)
        XCTAssertFalse(AdminPlacement.isUsable(frame: sliver, screens: screens, kiosk: edge))
    }

    func testWithoutAnEdgeDisplayOnlyTheScreensMatter() {
        let frame = CGRect(x: 100, y: 100, width: 1280, height: 800)
        XCTAssertTrue(AdminPlacement.isUsable(frame: frame, screens: [laptop], kiosk: nil))
        XCTAssertNil(AdminPlacement.rescue(frame: frame, size: adminSize, screens: [laptop], kiosk: nil))
        // The Edge is still a screen when nothing is drawing a kiosk on it.
        XCTAssertTrue(AdminPlacement.isUsable(frame: CGRect(x: 2000, y: 1600, width: 1280, height: 600),
                                              screens: screens, kiosk: nil))
    }

    func testTargetSkipsTheKioskScreenAndKeepsAppKitOrder() {
        XCTAssertEqual(AdminPlacement.target(screens: screens, kiosk: edge), laptop)
        XCTAssertEqual(AdminPlacement.target(screens: [edge, laptop], kiosk: edge), laptop)
        XCTAssertEqual(AdminPlacement.target(screens: screens, kiosk: nil), laptop)
    }

    func testAMacWhoseOnlyScreenIsTheEdgeIsLeftAlone() {
        // Nowhere better to put it: answering nil is how the caller knows not to move anything.
        XCTAssertNil(AdminPlacement.target(screens: [edge], kiosk: edge))
        XCTAssertNil(AdminPlacement.rescue(frame: edge, size: adminSize, screens: [edge], kiosk: edge))
    }

    func testCentringShrinksToFitAndRoundsToWholePoints() {
        let centredOnLaptop = AdminPlacement.centred(size: adminSize, in: laptop)
        XCTAssertEqual(centredOnLaptop, CGRect(x: 116, y: 91, width: 1280, height: 800))
        // A window larger than its screen is shrunk rather than hung off the edge.
        let small = CGRect(x: 0, y: 0, width: 800, height: 600)
        let fitted = AdminPlacement.centred(size: CGSize(width: 1280, height: 800), in: small)
        XCTAssertEqual(fitted, CGRect(x: 0, y: 0, width: 800, height: 600))
    }
}
