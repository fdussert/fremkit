import Foundation
import XCTest
@testable import FremkitCore

final class HelperPathsTests: XCTestCase {
    func testDefaultsAreUnderLibrary() {
        XCTAssertEqual(HelperPaths.supportDirectory(environment: [:], home: "/Users/u").path,
                       "/Users/u/Library/Application Support/Fremkit")
        XCTAssertEqual(HelperPaths.logDirectory(environment: [:], home: "/Users/u").path,
                       "/Users/u/Library/Logs/Fremkit")
    }

    func testOverrideMovesEverything() {
        let env = ["FREMKIT_SUPPORT_DIR": "/tmp/fremkit-test"]
        XCTAssertEqual(HelperPaths.supportDirectory(environment: env, home: "/Users/u").path, "/tmp/fremkit-test")
        XCTAssertEqual(HelperPaths.logDirectory(environment: env, home: "/Users/u").path, "/tmp/fremkit-test/Logs")
    }

    func testRelativeOrEmptyOverrideIsIgnored() {
        for value in ["", "relative/dir"] {
            let env = ["FREMKIT_SUPPORT_DIR": value]
            XCTAssertEqual(HelperPaths.supportDirectory(environment: env, home: "/Users/u").path,
                           "/Users/u/Library/Application Support/Fremkit")
        }
    }
}
