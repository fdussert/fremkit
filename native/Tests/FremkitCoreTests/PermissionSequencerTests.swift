import XCTest
@testable import FremkitCore

final class PermissionSequencerTests: XCTestCase {
    func testAsksInputMonitoringAloneWhenTouchNeedsIt() {
        var sequencer = PermissionSequencer(touch: true, fence: true, dock: true)
        XCTAssertEqual(sequencer.begin(inputMonitoring: .unknown, now: 0), [.requestInputMonitoring])
        XCTAssertTrue(sequencer.isWaiting)
    }

    func testAsksAccessibilityOnceInputMonitoringIsAnswered() {
        var sequencer = PermissionSequencer(touch: true, fence: false, dock: false)
        _ = sequencer.begin(inputMonitoring: .unknown, now: 0)
        XCTAssertEqual(sequencer.poll(inputMonitoring: .unknown, now: 5), [])
        XCTAssertEqual(sequencer.poll(inputMonitoring: .denied, now: 6), [.startTouch, .requestAccessibility])
        XCTAssertFalse(sequencer.isWaiting)
        // Nothing more once done.
        XCTAssertEqual(sequencer.poll(inputMonitoring: .granted, now: 7), [])
    }

    func testAsksAccessibilityAnywayAfterTheTimeout() {
        var sequencer = PermissionSequencer(touch: true, fence: false, dock: false, timeout: 30)
        _ = sequencer.begin(inputMonitoring: .unknown, now: 100)
        XCTAssertEqual(sequencer.poll(inputMonitoring: .unknown, now: 129.9), [])
        XCTAssertEqual(sequencer.poll(inputMonitoring: .unknown, now: 130), [.startTouch, .requestAccessibility])
    }

    func testAsksAccessibilityAtOnceWhenInputMonitoringIsAlreadyAnswered() {
        var granted = PermissionSequencer(touch: true, fence: false, dock: false)
        XCTAssertEqual(granted.begin(inputMonitoring: .granted, now: 0), [.startTouch, .requestAccessibility])
        XCTAssertFalse(granted.isWaiting)

        var denied = PermissionSequencer(touch: true, fence: false, dock: false)
        XCTAssertEqual(denied.begin(inputMonitoring: .denied, now: 0), [.startTouch, .requestAccessibility])
    }

    func testTouchOffNeverAsksInputMonitoring() {
        var sequencer = PermissionSequencer(touch: false, fence: true, dock: false)
        XCTAssertEqual(sequencer.begin(inputMonitoring: .unknown, now: 0), [.requestAccessibility])
    }

    func testEverythingOffAsksNothing() {
        var sequencer = PermissionSequencer(touch: false, fence: false, dock: false)
        XCTAssertEqual(sequencer.begin(inputMonitoring: .unknown, now: 0), [])
        XCTAssertFalse(sequencer.isWaiting)
    }

    func testBeginOnlyActsOnce() {
        var sequencer = PermissionSequencer(touch: true, fence: false, dock: false)
        _ = sequencer.begin(inputMonitoring: .granted, now: 0)
        XCTAssertEqual(sequencer.begin(inputMonitoring: .granted, now: 1), [])
    }
}
