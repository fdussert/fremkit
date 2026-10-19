import Foundation
import XCTest
@testable import FremkitCore

final class AccessProofTests: XCTestCase {
    private let token = String(repeating: "A", count: 43)
    private let nonce = "abcdefghijklmnop"

    func testMatchesTheServersVector() {
        // The same vector as server/test/access.test.ts: both sides must compute one MAC.
        XCTAssertEqual(AccessProof.expected(token: token, nonce: nonce), "XAkZGHu68HFGxebuJzgT09AtTRQ3rswof7b2of6to_o")
    }

    func testNoncesAreFreshAndWellFormed() {
        let a = AccessProof.newNonce()
        XCTAssertEqual(a.count, 32)
        XCTAssertNotEqual(a, AccessProof.newNonce())
        XCTAssertEqual(AccessProof.url(port: 4242, nonce: a)?.absoluteString, "http://127.0.0.1:4242/auth/proof?nonce=\(a)")
    }

    func testOnlyTheRightProofIsOurs() {
        let good = Data(#"{"proof":"\#(AccessProof.expected(token: token, nonce: nonce))"}"#.utf8)
        XCTAssertEqual(AccessProof.verdict(status: 200, body: good, token: token, nonce: nonce), .ours)
        // Another nonce, another secret, or no secret to check against: not ours.
        XCTAssertEqual(AccessProof.verdict(status: 200, body: good, token: token, nonce: "another-nonce-123"), .foreign)
        XCTAssertEqual(AccessProof.verdict(status: 200, body: good, token: AccessToken.generate(), nonce: nonce), .foreign)
        XCTAssertEqual(AccessProof.verdict(status: 200, body: good, token: nil, nonce: nonce), .foreign)
    }

    func testAnythingElseThatAnswersIsForeign() {
        // What a listener that does not hold the secret can say, including our old challenge,
        // which used to be enough to be taken for an external Fremkit.
        XCTAssertEqual(AccessProof.verdict(status: 401, body: nil, token: token, nonce: nonce), .foreign)
        XCTAssertEqual(AccessProof.verdict(status: 200, body: Data(#"{"version":4,"screens":[]}"#.utf8), token: token, nonce: nonce), .foreign)
        XCTAssertEqual(AccessProof.verdict(status: 200, body: Data("not json".utf8), token: token, nonce: nonce), .foreign)
        XCTAssertEqual(AccessProof.verdict(status: 404, body: nil, token: token, nonce: nonce), .foreign)
        XCTAssertEqual(AccessProof.verdict(status: 200, body: Data(#"{"proof":""}"#.utf8), token: token, nonce: nonce), .foreign)
    }

    func testNothingAnsweringIsAbsent() {
        XCTAssertEqual(AccessProof.verdict(status: nil, body: nil, token: token, nonce: nonce), .absent)
    }
}
