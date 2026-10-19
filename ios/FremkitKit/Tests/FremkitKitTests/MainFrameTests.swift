import FremkitKit
import XCTest

final class MainFrameTests: XCTestCase {
    private func allowed(_ string: String, host: String = "studio.local", port: Int = 4243) -> Bool {
        Dashboard.allowsMainFrame(URL(string: string), host: host, port: port)
    }

    func testAllowsTheMacsOwnOrigin() {
        XCTAssertTrue(allowed("https://studio.local:4243/"))
        XCTAssertTrue(allowed("https://STUDIO.local:4243/?screen=tab-a#x"))
        XCTAssertTrue(allowed("https://192.0.2.10:4243/", host: "192.0.2.10"))
        XCTAssertTrue(allowed("https://example.local/", host: "example.local", port: 443))
    }

    func testRefusesAnyOtherOrigin() {
        for url in [
            "https://evil.example:4243/",
            "https://studio.local:4242/",
            "https://studio.local/",
            "http://studio.local:4243/",
            "https://user:pass@studio.local:4243/",
            "https://studio.local.evil.example:4243/",
            "https://192.0.2.11:4243/",
            "about:blank",
            "data:text/html,hi",
            "javascript:alert(1)",
            "fremkit://pair?x",
        ] {
            XCTAssertFalse(allowed(url), url)
        }
        XCTAssertFalse(Dashboard.allowsMainFrame(nil, host: "studio.local", port: 4243))
    }

    func testHearsThePageFromItsOwnOriginOnly() {
        XCTAssertTrue(Dashboard.isPageOrigin(scheme: "https", host: "studio.local", port: 4243, host: "studio.local", port: 4243))
        XCTAssertTrue(Dashboard.isPageOrigin(scheme: "HTTPS", host: "Studio.Local", port: 4243, host: "studio.local", port: 4243))
        XCTAssertTrue(Dashboard.isPageOrigin(scheme: "https", host: "example.local", port: 0, host: "example.local", port: 443))
        XCTAssertFalse(Dashboard.isPageOrigin(scheme: "https", host: "evil.example", port: 4243, host: "studio.local", port: 4243))
        XCTAssertFalse(Dashboard.isPageOrigin(scheme: "https", host: "studio.local", port: 4242, host: "studio.local", port: 4243))
        XCTAssertFalse(Dashboard.isPageOrigin(scheme: "http", host: "studio.local", port: 4243, host: "studio.local", port: 4243))
        XCTAssertFalse(Dashboard.isPageOrigin(scheme: "https", host: "", port: 4243, host: "studio.local", port: 4243))
        // An opaque origin (a sandboxed frame) has no host.
        XCTAssertFalse(Dashboard.isPageOrigin(scheme: "", host: "", port: 0, host: "studio.local", port: 4243))
    }
}
