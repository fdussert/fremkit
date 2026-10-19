import Foundation
import XCTest
@testable import FremkitCore

final class HelperURLTests: XCTestCase {
    func testAdminHostOpensTheAdmin() {
        XCTAssertEqual(HelperURL.action(for: URL(string: "fremkit://admin")!), .openAdmin)
        XCTAssertEqual(HelperURL.action(for: URL(string: HelperURL.admin)!), .openAdmin)
    }

    func testRevealHostLetsTheDialogsBeSeen() {
        XCTAssertEqual(HelperURL.action(for: URL(string: "fremkit://reveal")!), .reveal)
        XCTAssertEqual(HelperURL.action(for: URL(string: HelperURL.reveal)!), .reveal)
        XCTAssertEqual(HelperURL.action(for: URL(string: "fremkit:reveal")!), .reveal)
        XCTAssertEqual(HelperURL.action(for: URL(string: "FREMKIT://Reveal?seconds=9999")!), .reveal)
        XCTAssertNil(HelperURL.action(for: URL(string: "fremkit://reveal.example.com")!))
    }

    func testTargetIsCaseInsensitiveAndIgnoresPathAndQuery() {
        XCTAssertEqual(HelperURL.action(for: URL(string: "FREMKIT://Admin")!), .openAdmin)
        XCTAssertEqual(HelperURL.action(for: URL(string: "fremkit://admin/?from=dashboard#x")!), .openAdmin)
    }

    func testHostlessSpellingIsAccepted() {
        XCTAssertEqual(HelperURL.action(for: URL(string: "fremkit:admin")!), .openAdmin)
    }

    func testAnotherSchemeIsIgnored() {
        XCTAssertNil(HelperURL.action(for: URL(string: "https://example.com/admin")!))
        XCTAssertNil(HelperURL.action(for: URL(fileURLWithPath: "/tmp/admin")))
    }

    func testUnknownTargetIsIgnored() {
        XCTAssertNil(HelperURL.action(for: URL(string: "fremkit://quit")!))
        XCTAssertNil(HelperURL.action(for: URL(string: "fremkit://")!))
        XCTAssertNil(HelperURL.action(for: URL(string: "fremkit://admin.example.com")!))
    }
}
