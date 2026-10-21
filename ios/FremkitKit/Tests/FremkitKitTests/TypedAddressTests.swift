import XCTest
@testable import FremkitKit

final class TypedAddressTests: XCTestCase {
    func testParsesEverySharedAddressAsExpected() {
        let vectors = Vectors.all.typedAddresses
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            let expected = vector.expect.map { TypedAddress(host: $0.host, port: $0.port) }
            XCTAssertEqual(TypedAddress(typed: vector.input), expected, "\(vector.why): \"\(vector.input)\"")
        }
    }

    func testEveryAcceptedHostIsOneTheAppConnectsTo() {
        for vector in Vectors.all.typedAddresses {
            guard let parsed = TypedAddress(typed: vector.input) else { continue }
            XCTAssertTrue(isConnectableHost(parsed.host), vector.why)
        }
    }
}
