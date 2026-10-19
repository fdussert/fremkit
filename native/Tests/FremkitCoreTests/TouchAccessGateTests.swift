import Foundation
import XCTest
@testable import FremkitCore

final class TouchAccessGateTests: XCTestCase {
    func testNotGrantedIsMissing() {
        var gate = TouchAccessGate()
        for _ in 0..<5 {
            XCTAssertEqual(gate.refused(inputMonitoring: .unknown), .missing)
            XCTAssertEqual(gate.refused(inputMonitoring: .denied), .missing)
        }
    }

    func testGrantedButStillRefusedAsksForARelaunch() {
        var gate = TouchAccessGate()
        XCTAssertEqual(gate.refused(inputMonitoring: .granted), .missing)
        XCTAssertEqual(gate.refused(inputMonitoring: .granted), .relaunchNeeded)
        XCTAssertEqual(gate.refused(inputMonitoring: .granted), .relaunchNeeded)
    }

    func testARevokedGrantOrASuccessfulOpenStartsOver() {
        var gate = TouchAccessGate()
        _ = gate.refused(inputMonitoring: .granted)
        XCTAssertEqual(gate.refused(inputMonitoring: .denied), .missing)
        XCTAssertEqual(gate.refused(inputMonitoring: .granted), .missing)
        gate.reset()
        XCTAssertEqual(gate.refused(inputMonitoring: .granted), .missing)
    }

    func testRelaunchWaitsForThePidThenOpensTheBundle() {
        let command = Relaunch.command(waitingFor: 4242, bundlePath: "/Applications/Fremkit.app")
        XCTAssertEqual(command.executable, "/bin/sh")
        XCTAssertEqual(command.arguments.count, 5)
        XCTAssertEqual(command.arguments[0], "-c")
        XCTAssertEqual(Array(command.arguments[2...]), ["fremkit-relaunch", "4242", "/Applications/Fremkit.app"])
        // The path reaches the script only as "$2", whatever it contains.
        XCTAssertTrue(command.arguments[1].contains("kill -0 \"$1\""))
        XCTAssertTrue(command.arguments[1].hasSuffix("exec /usr/bin/open \"$2\""))
        XCTAssertFalse(command.arguments[1].contains("Fremkit.app"))
    }

    func testRelaunchLineRelaunches() {
        XCTAssertEqual(PermissionFix.forLine(.touchNeedsRelaunch), .relaunch)
    }
}
