import Foundation
import XCTest
@testable import FremkitCore

final class KioskOriginTests: XCTestCase {
    private let dashboard = URL(string: "http://127.0.0.1:4242/?kiosk=1")!

    func testAllowsTheDashboardsOwnOrigin() {
        XCTAssertTrue(KioskOrigin.sameOrigin(URL(string: "http://127.0.0.1:4242/"), as: dashboard))
        XCTAssertTrue(KioskOrigin.sameOrigin(URL(string: "http://127.0.0.1:4242/admin"), as: dashboard))
        XCTAssertTrue(KioskOrigin.sameOrigin(URL(string: "HTTP://127.0.0.1:4242/x"), as: dashboard))
    }

    func testRefusesAnywhereElse() {
        // The kiosk has no chrome and no way back, so any of these would strand the Edge.
        for candidate in ["https://example.com/", "http://localhost:4242/", "http://127.0.0.1:5173/",
                          "http://127.0.0.1/", "file:///etc/passwd", "about:blank",
                          "javascript:alert(1)", "data:text/html,x"] {
            XCTAssertFalse(KioskOrigin.sameOrigin(URL(string: candidate), as: dashboard), candidate)
        }
    }

    func testRefusesNothingAtAll() {
        XCTAssertFalse(KioskOrigin.sameOrigin(nil, as: dashboard))
    }
}

final class ExternalLinkTests: XCTestCase {
    private let admin = URL(string: "http://127.0.0.1:4242/admin")!

    func testOpensAnotherSiteInTheBrowser() {
        XCTAssertTrue(ExternalLink.opensInBrowser(URL(string: "https://github.com/example/repo"), from: admin))
        XCTAssertTrue(ExternalLink.opensInBrowser(URL(string: "http://example.com/"), from: admin))
    }

    func testKeepsTheAdminsOwnPagesInTheWindow() {
        XCTAssertFalse(ExternalLink.opensInBrowser(URL(string: "http://127.0.0.1:4242/"), from: admin))
        XCTAssertFalse(ExternalLink.opensInBrowser(URL(string: "http://127.0.0.1:4242/api/backup"), from: admin))
    }

    func testRefusesEveryOtherScheme() {
        for candidate in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "about:blank",
                          "mailto:someone@example.com", "fremkit://admin", "ftp://example.com/"] {
            XCTAssertFalse(ExternalLink.opensInBrowser(URL(string: candidate), from: admin), candidate)
        }
        XCTAssertFalse(ExternalLink.opensInBrowser(nil, from: admin))
    }
}

final class NodeVersionOrderTests: XCTestCase {
    /// nvm keeps one directory per version, and the newest is the one to try first.
    func testComparesVersionsNumericallyNotAsText() {
        // The text order puts v9 after v20, which is how a stale Node gets picked.
        XCTAssertTrue(NodeVersionOrder.newer("v20.1.2", "v9.9.9"))
        XCTAssertFalse(NodeVersionOrder.newer("v9.9.9", "v20.1.2"))
        XCTAssertTrue(NodeVersionOrder.newer("v22.0.0", "v20.19.4"))
        XCTAssertTrue(NodeVersionOrder.newer("v20.19.4", "v20.9.0"))
    }

    func testTreatsAMissingPartAsZero() {
        XCTAssertTrue(NodeVersionOrder.newer("v20.1", "v20.0.9"))
        XCTAssertFalse(NodeVersionOrder.newer("v20", "v20.0.1"))
    }

    func testIsFalseForEqualVersions() {
        XCTAssertFalse(NodeVersionOrder.newer("v20.1.2", "v20.1.2"))
    }

    func testSurvivesSomethingThatIsNotAVersion() {
        XCTAssertFalse(NodeVersionOrder.newer("system", "system"))
        XCTAssertTrue(NodeVersionOrder.newer("v1.0.0", "not-a-version"))
    }
}

final class AdminOriginTests: XCTestCase {
    private let admin = URL(string: "http://127.0.0.1:4242/admin")!

    func testAllowsTheAdminsOwnOriginAndTheSignInLink() {
        XCTAssertTrue(AdminOrigin.allows(URL(string: "http://127.0.0.1:4242/admin?tab=screen"), admin: admin))
        XCTAssertTrue(AdminOrigin.allows(URL(string: "http://127.0.0.1:4242/auth?code=x&next=/admin"), admin: admin))
        XCTAssertTrue(AdminOrigin.allows(URL(string: "about:blank"), admin: admin))
    }

    func testRefusesEverythingElseInTheMainFrame() {
        for candidate in ["https://example.com/", "http://127.0.0.1:4243/admin", "http://localhost:4242/admin",
                          "file:///etc/passwd", "javascript:alert(1)", "fremkit://admin", "about:srcdoc"] {
            XCTAssertFalse(AdminOrigin.allows(URL(string: candidate), admin: admin), candidate)
        }
        XCTAssertFalse(AdminOrigin.allows(nil, admin: admin))
    }
}
