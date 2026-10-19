import Foundation
import XCTest
@testable import FremkitCore

final class HelperDiagnosticsTests: XCTestCase {
    private func sample(display: (width: Int, height: Int)? = (2560, 720)) -> HelperDiagnostics {
        HelperDiagnostics(version: "0.4.1", build: "0.4.1", launch: "app", server: "running", touch: "active",
                          inputMonitoring: .granted, accessibility: .denied, kioskDisplay: display,
                          kioskWindow: true, brightness: "level 40 %", fence: "off", dock: "disabled",
                          manageServer: true)
    }

    func testSectionListsEveryFact() {
        let text = sample().markdown
        XCTAssertTrue(text.hasPrefix("### Helper\n"))
        XCTAssertTrue(text.contains("- Helper: 0.4.1 (build 0.4.1, app)"))
        XCTAssertTrue(text.contains("- Touch driver: active"))
        XCTAssertTrue(text.contains("- Input Monitoring: granted"))
        XCTAssertTrue(text.contains("- Accessibility: denied"))
        XCTAssertTrue(text.contains("- Kiosk display: connected, 2560×720"))
        XCTAssertTrue(text.contains("- Brightness (DDC): level 40 %"))
        XCTAssertTrue(sample(display: nil).markdown.contains("- Kiosk display: not found"))
    }

    func testServerReportComesFirstThenTheHelper() {
        let text = sample().report(server: .report("## Fremkit diagnostics\n\n- Fremkit: 0.4.1"))
        XCTAssertTrue(text.hasPrefix("## Fremkit diagnostics\n"))
        XCTAssertTrue(text.contains("- Fremkit: 0.4.1\n\n### Helper\n"))
    }

    func testServerDownStillGivesTheHelperPartAndSaysSo() {
        let text = sample().report(server: .unavailable(reason: "not running"))
        XCTAssertTrue(text.hasPrefix("## Fremkit diagnostics\n"))
        XCTAssertTrue(text.contains("The server did not answer (not running)"))
        XCTAssertTrue(text.contains("### Helper"))
    }

    func testReasonNeverQuotesTheRequest() {
        XCTAssertEqual(HelperDiagnostics.reason(status: 401, error: nil), "HTTP 401")
        XCTAssertEqual(HelperDiagnostics.reason(status: nil, error: URLError(.timedOut)), "timed out")
        XCTAssertEqual(HelperDiagnostics.reason(status: nil, error: URLError(.cannotConnectToHost)), "not running")
        XCTAssertEqual(HelperDiagnostics.reason(status: 200, error: nil), "empty answer")
    }
}
