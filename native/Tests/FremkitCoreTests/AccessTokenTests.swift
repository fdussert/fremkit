import Foundation
import XCTest
@testable import FremkitCore

final class AccessTokenTests: XCTestCase {
    func testGeneratesThirtyTwoByteBase64URLSecrets() {
        let token = AccessToken.generate()
        XCTAssertEqual(token.count, 43)
        XCTAssertTrue(AccessToken.isWellFormed(token))
        XCTAssertNotEqual(AccessToken.generate(), token)
        XCTAssertFalse(token.contains("+") || token.contains("/") || token.contains("="))
    }

    func testWellFormedMatchesTheServer() {
        XCTAssertTrue(AccessToken.isWellFormed(String(repeating: "a", count: 43)))
        XCTAssertFalse(AccessToken.isWellFormed(String(repeating: "a", count: 42)))
        XCTAssertFalse(AccessToken.isWellFormed(String(repeating: "a", count: 42) + "+"))
        XCTAssertFalse(AccessToken.isWellFormed(""))
    }

    func testReadsTheTokenFileForAPort() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("fremkit-token-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = AccessToken.fileURL(port: 4301, supportDirectory: dir)
        XCTAssertEqual(file.lastPathComponent, "access-4301.token")
        XCTAssertNil(AccessToken.read(from: file))
        let token = AccessToken.generate()
        try Data((token + "\n").utf8).write(to: file)
        XCTAssertEqual(AccessToken.read(from: file), token)
        try Data("not a token".utf8).write(to: file)
        XCTAssertNil(AccessToken.read(from: file))
    }

    func testReadsTheCodeOutOfTheServersAnswer() {
        let code = AccessToken.generate()
        XCTAssertEqual(AccessToken.code(fromResponse: Data(#"{"code":"\#(code)","expiresInSeconds":60}"#.utf8)), code)
        XCTAssertNil(AccessToken.code(fromResponse: Data(#"{"code":"short"}"#.utf8)))
        XCTAssertNil(AccessToken.code(fromResponse: nil))
    }

    func testSignInURLStaysOnTheTargetsOrigin() {
        let code = AccessToken.generate()
        let url = AccessToken.signInURL(for: URL(string: "http://127.0.0.1:4242/admin")!, code: code)
        XCTAssertEqual(url?.absoluteString, "http://127.0.0.1:4242/auth?code=\(code)&next=/admin")
        let withQuery = AccessToken.signInURL(for: URL(string: "http://localhost:4301/?screen=a&x=1+2#f")!, code: code)
        XCTAssertEqual(withQuery?.absoluteString, "http://localhost:4301/auth?code=\(code)&next=/%3Fscreen%3Da%26x%3D1%2B2")
        let bare = AccessToken.signInURL(for: URL(string: "http://127.0.0.1:4242")!, code: code)
        XCTAssertEqual(bare?.absoluteString, "http://127.0.0.1:4242/auth?code=\(code)&next=/")
    }
}
