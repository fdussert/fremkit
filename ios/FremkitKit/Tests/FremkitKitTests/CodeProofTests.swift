import FremkitKit
import XCTest

final class CodeProofTests: XCTestCase {
    // The same vector as the server's `codeProof` test: both sides must derive the same proof.
    func testDerivesTheServersProof() {
        XCTAssertEqual(CodeProof.iterations, 600_000)
        XCTAssertEqual(CodeProof.proof(code: "ABCDEFGH", keyHash: "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg"),
                       "u0OmzfI4qjz-qNwuSnZEHpye4MAjcTzhT3jg2gJVid0")
    }

    func testAnotherKeyGivesAnotherProof() {
        XCTAssertNotEqual(CodeProof.proof(code: "ABCDEFGH", keyHash: "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgh"),
                          CodeProof.proof(code: "ABCDEFGH", keyHash: "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg"))
    }
}
