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
