import FremkitKit
import XCTest

final class SubframeTests: XCTestCase {
    private func allowed(_ string: String, host: String = "studio.local", port: Int = 4243) -> Bool {
        Dashboard.allowsSubframe(URL(string: string), host: host, port: port)
    }

    func testAllowsTheMacsWidgets() {
        XCTAssertTrue(allowed("https://studio.local:4243/widgets/clock/index.html"))
        XCTAssertTrue(allowed("https://STUDIO.local:4243/widgets/clock/index.html?x=1#y"))
        XCTAssertTrue(allowed("https://studio.local.:4243/widgets/clock/", host: "studio.local."))
        XCTAssertTrue(allowed("https://192.0.2.10:4243/widgets/clock/index.html", host: "192.0.2.10"))
        XCTAssertTrue(allowed("https://[fe80::1%25en0]:4243/widgets/clock/index.html", host: "fe80::1%en0"))
        XCTAssertTrue(allowed("https://example.local/widgets/clock/index.html", host: "example.local", port: 443))
    }

    func testRefusesAnythingElse() {
        for url in [
            "https://evil.example:4243/widgets/clock/index.html",
            "https://studio.local:4242/widgets/clock/index.html",
            "https://studio.local/widgets/clock/index.html",
            "http://studio.local:4243/widgets/clock/index.html",
            "https://studio.local:4243/",
            "https://studio.local:4243/index.html",
            "https://studio.local:4243/api/config",
            "https://studio.local:4243/widgetsx/clock/index.html",
            "https://studio.local:4243/widgets",
            "https://studio.local:4243/widgets/%2e%2e/admin.html",
            "https://studio.local:4243/widgets/clock/%2E%2E/%2E%2E/api/config",
            "https://studio.local:4243/widgets/clock%5c..%5cadmin.html",
            "https://user:pw@studio.local:4243/widgets/clock/index.html",
            "about:blank",
            "about:srcdoc",
            "data:text/html,hi",
            "javascript:alert(1)",
            "blob:https://studio.local:4243/1234",
            // Where the earlier rule and the Mac's `WidgetFrames` disagreed; the Mac's answer wins.
            "https://studio.local.:4243/widgets/clock/",
            "https://studio.local:4243/%77idgets/clock/index.html",
            "https://studio.local:4243/widgets/clock/a%2Ejs",
        ] {
            XCTAssertFalse(allowed(url), url)
        }
        XCTAssertFalse(Dashboard.allowsSubframe(nil, host: "studio.local", port: 4243))
    }

    // `WidgetFramesTests` (native/Tests/FremkitCoreTests), case for case, on the iPad's origin:
    // `http://127.0.0.1:4242` becomes `https://studio.local:4243`, and its other-origin cases
    // (another port, another name for the same host, another scheme) keep their meaning.

    func testWidgetFramesAllowsAWidgetDocumentOnTheSameOrigin() {
        for candidate in ["https://studio.local:4243/widgets/clock/index.html",
                          "https://studio.local:4243/widgets/clock/",
                          "https://studio.local:4243/widgets/clock/index.html?x=1#y"] {
            XCTAssertTrue(allowed(candidate), candidate)
        }
    }

    func testWidgetFramesRefusesEverythingElse() {
        for candidate in ["https://attacker.example/?d=secret",
                          "https://studio.local:4242/widgets/clock/index.html",
                          "https://192.0.2.10:4243/widgets/clock/index.html",
                          "http://studio.local:4243/widgets/clock/index.html",
                          "https://studio.local:4243/admin",
                          "https://studio.local:4243/",
                          "https://studio.local:4243/widgets/",
                          "https://studio.local:4243/widgetsx/clock/index.html",
                          "https://studio.local:4243/widgets/../admin",
                          "https://studio.local:4243/widgets/%2e%2e/admin",
                          "https://studio.local:4243/widgets/./clock",
                          "about:blank", "about:srcdoc",
                          "data:text/html,<script>1</script>",
                          "blob:https://studio.local:4243/0f2c",
                          "javascript:alert(1)"] {
            XCTAssertFalse(allowed(candidate), candidate)
        }
        XCTAssertFalse(Dashboard.allowsSubframe(nil, host: "studio.local", port: 4243))
    }

    func testWidgetFramesFollowsThePagesOwnOrigin() {
        XCTAssertTrue(allowed("https://mac.local:4243/widgets/clock/index.html", host: "mac.local"))
        XCTAssertFalse(allowed("http://127.0.0.1:4242/widgets/clock/index.html", host: "mac.local"))
        XCTAssertFalse(allowed("https://studio.local:4243/widgets/clock/index.html", host: "mac.local"))
    }
}
