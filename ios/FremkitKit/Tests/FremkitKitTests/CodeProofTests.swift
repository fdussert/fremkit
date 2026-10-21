import FremkitKit
import XCTest

final class CodeProofTests: XCTestCase {
    private let vector = Vectors.all.codeProof

    // The shared vector (test-vectors/devices.json): the server derives the same proof.
    func testDerivesTheServersProof() {
        XCTAssertEqual(Int(CodeProof.iterations), vector.iterations)
        XCTAssertEqual(CodeProof.proof(code: vector.code, keyHash: vector.keyHash), vector.proof)
    }

    func testAnotherKeyGivesAnotherProof() {
        XCTAssertNotEqual(CodeProof.proof(code: vector.code, keyHash: vector.anotherKeyHash),
                          CodeProof.proof(code: vector.code, keyHash: vector.keyHash))
        XCTAssertNotEqual(CodeProof.proof(code: vector.code, keyHash: vector.anotherKeyHash), vector.proof)
    }
}
