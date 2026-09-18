import Foundation
import XCTest
@testable import FremkitCore

private func json(_ text: String) -> Data { Data(text.utf8) }

final class ServerProbeTests: XCTestCase {
    func testRecognisesAFremkitConfig() {
        XCTAssertTrue(ServerProbe.looksLikeFremkitConfig(json(#"{"version":2,"pages":[{"id":"home"}]}"#)))
        // An empty dashboard is still a dashboard.
        XCTAssertTrue(ServerProbe.looksLikeFremkitConfig(json(#"{"version":2,"pages":[],"locale":"fr"}"#)))
        // A future version is still recognisably ours.
        XCTAssertTrue(ServerProbe.looksLikeFremkitConfig(json(#"{"version":9,"pages":[]}"#)))
    }

    func testRefusesAnythingElseAnsweringOnThePort() {
        // The case that made the helper stand down for good: something else on 4242.
        XCTAssertFalse(ServerProbe.looksLikeFremkitConfig(json("<!doctype html><title>Vite</title>")))
        XCTAssertFalse(ServerProbe.looksLikeFremkitConfig(json(#"{"status":"ok"}"#)))
        XCTAssertFalse(ServerProbe.looksLikeFremkitConfig(json(#"{"version":2}"#)))
        XCTAssertFalse(ServerProbe.looksLikeFremkitConfig(json(#"{"pages":[]}"#)))
        XCTAssertFalse(ServerProbe.looksLikeFremkitConfig(json(#"{"version":2,"pages":"home"}"#)))
        XCTAssertFalse(ServerProbe.looksLikeFremkitConfig(json("[]")))
    }

    func testRefusesNothingAtAll() {
        XCTAssertFalse(ServerProbe.looksLikeFremkitConfig(nil))
        XCTAssertFalse(ServerProbe.looksLikeFremkitConfig(Data()))
        XCTAssertFalse(ServerProbe.looksLikeFremkitConfig(json("not json")))
    }
}

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
