import Foundation
import XCTest
@testable import FremkitCore

final class PermissionFixTests: XCTestCase {
    func testPanesOpenTheirPrivacyAnchor() {
        XCTAssertEqual(PrivacyPane.inputMonitoring.url.absoluteString,
                       "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        XCTAssertEqual(PrivacyPane.accessibility.url.absoluteString,
                       "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    func testTouchWithoutInputMonitoringOpensInputMonitoring() {
        XCTAssertEqual(PermissionFix.forLine(.touchNotPermitted), .openPrivacyPane(.inputMonitoring))
    }

    func testEveryAccessibilityLineOpensAccessibility() {
        for key in [L10nKey.touchAccessibilityMissing, .dockAccessibilityMissing, .fenceMissingPermission] {
            XCTAssertEqual(PermissionFix.forLine(key), .openPrivacyPane(.accessibility), key.rawValue)
        }
    }

    func testLoginApprovalOpensLoginItems() {
        XCTAssertEqual(PermissionFix.forLine(.loginNeedsApproval), .openLoginItems)
    }

    func testInformativeLinesDoNothing() {
        for key in [L10nKey.touchActive, .touchBusy, .touchOpenFailed, .touchNoDisplay, .touchDisabled, .dockActive, .dockNoDock, .dockDisabled, .serverRunning, .serverRestarting, .loginFailed] {
            XCTAssertNil(PermissionFix.forLine(key), key.rawValue)
        }
    }
}
