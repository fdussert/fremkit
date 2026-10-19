import Foundation
import XCTest
@testable import FremkitCore

final class WidgetFramesTests: XCTestCase {
    private let dashboard = URL(string: "http://127.0.0.1:4242/")!

    func testAllowsAWidgetDocumentOnTheSameOrigin() {
        for candidate in ["http://127.0.0.1:4242/widgets/clock/index.html",
                          "http://127.0.0.1:4242/widgets/clock/",
                          "http://127.0.0.1:4242/widgets/clock/index.html?x=1#y"] {
            XCTAssertTrue(WidgetFrames.allows(URL(string: candidate), on: dashboard), candidate)
        }
    }

    func testRefusesEverythingElse() {
        for candidate in ["https://attacker.example/?d=secret",
                          "http://127.0.0.1:4243/widgets/clock/index.html",
                          "http://localhost:4242/widgets/clock/index.html",
                          "https://127.0.0.1:4242/widgets/clock/index.html",
                          "http://127.0.0.1:4242/admin",
                          "http://127.0.0.1:4242/",
                          "http://127.0.0.1:4242/widgets/",
                          "http://127.0.0.1:4242/widgetsx/clock/index.html",
                          "http://127.0.0.1:4242/widgets/../admin",
                          "http://127.0.0.1:4242/widgets/%2e%2e/admin",
                          "http://127.0.0.1:4242/widgets/./clock",
                          "http://u:p@127.0.0.1:4242/widgets/clock/index.html",
                          "http://u@127.0.0.1:4242/widgets/clock/index.html",
                          "about:blank", "about:srcdoc",
                          "data:text/html,<script>1</script>",
                          "blob:http://127.0.0.1:4242/0f2c",
                          "javascript:alert(1)"] {
            XCTAssertFalse(WidgetFrames.allows(URL(string: candidate), on: dashboard), candidate)
        }
        XCTAssertFalse(WidgetFrames.allows(nil, on: dashboard))
    }

    func testFollowsThePagesOwnOrigin() {
        let ipad = URL(string: "https://mac.local:4243/")!
        XCTAssertTrue(WidgetFrames.allows(URL(string: "https://mac.local:4243/widgets/clock/index.html"), on: ipad))
        XCTAssertFalse(WidgetFrames.allows(URL(string: "http://127.0.0.1:4242/widgets/clock/index.html"), on: ipad))
    }
}
