import CoreGraphics
import Foundation
import XCTest
@testable import FremkitCore

/// The Edge as `CGWindowListCopyWindowInfo` reports bounds: top-left origin, y downwards.
private let edge = CGRect(x: -2560, y: 362, width: 2560, height: 720)
private let ownPid: pid_t = 501

/// One entry of the window list, with everything the sweep reads.
private func info(
    id: CGWindowID,
    pid: pid_t,
    frame: CGRect,
    layer: Int = 0
) -> [String: Any] {
    [
        kCGWindowNumber as String: id,
        kCGWindowOwnerPID as String: pid,
        kCGWindowLayer as String: layer,
        kCGWindowBounds as String: frame.dictionaryRepresentation as NSDictionary,
    ]
}

final class WindowSweepTests: XCTestCase {
    func testFindsAWindowLostOnTheEdge() {
        let lost = CGRect(x: -1740, y: 456, width: 920, height: 436)
        let strays = WindowSweep.strays(in: [info(id: 7, pid: 900, frame: lost)], edge: edge, ownPid: ownPid)
        XCTAssertEqual(strays, [StrayWindow(id: 7, pid: 900, frame: lost)])
    }

    func testLeavesWindowsOnTheOtherDisplaysAlone() {
        let onMain = CGRect(x: 200, y: 200, width: 920, height: 436)
        XCTAssertTrue(WindowSweep.strays(in: [info(id: 1, pid: 900, frame: onMain)], edge: edge, ownPid: ownPid).isEmpty)
    }

    func testTakesAWindowThatMerelyStraddlesTheBoundary() {
        // The part the user reads is the part that is hidden, so an overlap of any size counts.
        let straddling = CGRect(x: -358, y: 500, width: 2111, height: 690)
        XCTAssertEqual(WindowSweep.strays(in: [info(id: 2, pid: 900, frame: straddling)], edge: edge, ownPid: ownPid).count, 1)
    }

    func testIgnoresTheHelpersOwnKioskWindow() {
        let kiosk = edge
        XCTAssertTrue(WindowSweep.strays(in: [info(id: 3, pid: ownPid, frame: kiosk)], edge: edge, ownPid: ownPid).isEmpty)
    }

    func testIgnoresEverythingThatIsNotAnOrdinaryWindow() {
        // The Dock, the menu bar and the screen saver live on their own layers and belong there.
        let furniture = CGRect(x: -2560, y: 362, width: 2560, height: 40)
        for layer in [-1, 3, 20, 1000] {
            let strays = WindowSweep.strays(in: [info(id: 4, pid: 900, frame: furniture, layer: layer)], edge: edge, ownPid: ownPid)
            XCTAssertTrue(strays.isEmpty, "layer \(layer)")
        }
    }

    func testSkipsAnEntryMissingWhatItNeeds() {
        let frame = CGRect(x: -1000, y: 400, width: 400, height: 300)
        var noBounds = info(id: 5, pid: 900, frame: frame)
        noBounds.removeValue(forKey: kCGWindowBounds as String)
        var noPid = info(id: 6, pid: 900, frame: frame)
        noPid.removeValue(forKey: kCGWindowOwnerPID as String)
        var noNumber = info(id: 7, pid: 900, frame: frame)
        noNumber.removeValue(forKey: kCGWindowNumber as String)
        let empty = info(id: 8, pid: 900, frame: CGRect(x: -1000, y: 400, width: 0, height: 0))
        XCTAssertTrue(WindowSweep.strays(in: [noBounds, noPid, noNumber, empty], edge: edge, ownPid: ownPid).isEmpty)
    }

    func testKeepsTheOrderOfTheList() {
        let a = CGRect(x: -1000, y: 400, width: 400, height: 300)
        let b = CGRect(x: -500, y: 500, width: 400, height: 300)
        let strays = WindowSweep.strays(in: [info(id: 10, pid: 900, frame: a), info(id: 11, pid: 901, frame: b)],
                                        edge: edge, ownPid: ownPid)
        XCTAssertEqual(strays.map(\.id), [10, 11])
    }

    func testPresentListsEveryWindowWhateverItIs() {
        let frame = CGRect(x: 0, y: 0, width: 10, height: 10)
        let infos = [info(id: 1, pid: 900, frame: frame),
                     info(id: 2, pid: ownPid, frame: frame, layer: 25),
                     [kCGWindowOwnerPID as String: pid_t(900)]]
        XCTAssertEqual(WindowSweep.present(in: infos), [1, 2])
    }

    func testARescuedWindowKeepsItsSizeAndLandsOnTheMainDisplay() {
        // The move itself is `AdminPlacement.rescue`, which the helper hands the stray's own size.
        let main = CGRect(x: 0, y: 0, width: 2560, height: 1440)
        let lost = CGRect(x: -1740, y: 456, width: 920, height: 436)
        let target = AdminPlacement.rescue(frame: lost, size: lost.size, screens: [main, edge], kiosk: edge)
        XCTAssertEqual(target?.size, lost.size)
        XCTAssertEqual(target.map { main.contains($0) }, true)
    }
}
