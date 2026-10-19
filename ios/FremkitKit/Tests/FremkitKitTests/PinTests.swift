import CryptoKit
import XCTest
@testable import FremkitKit

/// A P-256 public key in DER SubjectPublicKeyInfo form, made with
/// `openssl ecparam -name prime256v1 -genkey | openssl ec -pubout -outform DER`. Its hash was
/// computed by `openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='`.
enum SPKIFixture {
    static let hex = "3059301306072a8648ce3d020106082a8648ce3d030107034200042fb1227411d23e4c17c047a472bfec3e71847e5ae51c785951bb4702e560d44aad22e120c9c885e22ea1069d316c6e42f97f2537118e4a5768af6b1c43420bde"
    static let keyHash = "Y4nRTFWKfvKwllWID7DQPMgZIF8SqUUvgWkQZsK_ArQ"

    static var der: Data {
        var bytes = [UInt8]()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return Data(bytes)
    }
}

final class PinTests: XCTestCase {
    func testHashesAnSPKILikeOpenSSL() {
        XCTAssertEqual(Pin.keyHash(spki: SPKIFixture.der), SPKIFixture.keyHash)
    }

    func testRebuildsTheSPKIOfARawP256Key() {
        let raw = SPKIFixture.der.dropFirst(26)
        XCTAssertEqual(Pin.spki(p256Raw: Data(raw)), SPKIFixture.der)
    }

    func testRefusesARawKeyThatIsNotAnUncompressedP256Point() {
        XCTAssertNil(Pin.spki(p256Raw: Data(repeating: 4, count: 64)))
        XCTAssertNil(Pin.spki(p256Raw: Data([0x02]) + Data(repeating: 1, count: 64)))
    }

    func testAgreesWithCryptoKitOnAFreshKey() {
        let key = P256.Signing.PrivateKey().publicKey
        XCTAssertEqual(Pin.spki(p256Raw: key.x963Representation), key.derRepresentation)
    }
}

final class PinDecisionTests: XCTestCase {
    let hosts: Set<String> = ["studio.local", "192.0.2.10"]

    func testTrustsAnAllowedHostPresentingTheExpectedKey() {
        XCTAssertEqual(PinnedSession.decide(host: "studio.local", presented: "abc", expected: "abc", hosts: hosts), .trust)
        XCTAssertEqual(PinnedSession.decide(host: "192.0.2.10", presented: "abc", expected: "abc", hosts: hosts), .trust)
    }

    func testMatchesTheHostWithoutCaseOrTrailingDot() {
        XCTAssertEqual(PinnedSession.decide(host: "Studio.Local.", presented: "abc", expected: "abc", hosts: hosts), .trust)
    }

    func testRejectsAnAllowedHostPresentingAnotherKey() {
        XCTAssertEqual(PinnedSession.decide(host: "studio.local", presented: "xyz", expected: "abc", hosts: hosts), .reject(observed: "xyz"))
        XCTAssertEqual(PinnedSession.decide(host: "studio.local", presented: nil, expected: "abc", hosts: hosts), .reject(observed: nil))
    }

    func testLeavesAnyOtherHostToTheSystem() {
        XCTAssertEqual(PinnedSession.decide(host: "example.com", presented: "abc", expected: "abc", hosts: hosts), .defaultHandling)
        XCTAssertEqual(PinnedSession.decide(host: "example.com", presented: "abc", expected: nil, hosts: hosts), .defaultHandling)
    }

    func testFirstContactRecordsTheKeyAndTrustsNothing() {
        XCTAssertEqual(PinnedSession.decide(host: "studio.local", presented: "abc", expected: nil, hosts: hosts), .reject(observed: "abc"))
    }

    func testIPv6HostsMatchWithOrWithoutBrackets() {
        let v6: Set<String> = ["[2001:db8::1]"]
        XCTAssertEqual(PinnedSession.decide(host: "2001:DB8::1", presented: "abc", expected: "abc", hosts: v6), .trust)
    }

    func testFirstContactSessionRemembersTheObservedKey() {
        let session = PinnedSession(keyHash: nil, hosts: hosts)
        XCTAssertNil(session.observedKeyHash)
        XCTAssertFalse(session.rejectedPin)
        _ = session.apply(host: "studio.local", presented: "abc")
        XCTAssertEqual(session.observedKeyHash, "abc")
        XCTAssertTrue(session.rejectedPin)
    }

    func testAnUnreadableKeyDoesNotEraseARecordedOne() {
        let session = PinnedSession(keyHash: nil, hosts: hosts)
        _ = session.apply(host: "studio.local", presented: "abc")
        _ = session.apply(host: "studio.local", presented: nil)
        XCTAssertEqual(session.observedKeyHash, "abc")
    }

    func testPinnedSessionDoesNotFlagATrustedHost() {
        let session = PinnedSession(keyHash: "abc", hosts: hosts)
        XCTAssertEqual(session.apply(host: "studio.local", presented: "abc"), .trust)
        XCTAssertFalse(session.rejectedPin)
        XCTAssertEqual(session.observedKeyHash, "abc")
    }
}

final class FingerprintTests: XCTestCase {
    func testListHashMatchesTheServerConstant() {
        XCTAssertEqual(Fingerprint.listSHA256, "247bec0519f05acf5f8716f8515af0532676cce180409949d265f5670797c930")
    }

    func testBundledListHashesToTheConstant() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "fingerprint-words", withExtension: "txt"))
        let digest = SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(digest, Fingerprint.listSHA256)
        XCTAssertEqual(Fingerprint.list.count, 256)
    }

    func testMapsTheFirstFourBytesToWords() {
        // The same vector as server/test/devices-fingerprint.test.ts: 00 01 fe ff, then 28 sevens.
        let hash = Data([0x00, 0x01, 0xfe, 0xff] + [UInt8](repeating: 7, count: 28)).base64URLEncoded()
        XCTAssertEqual(hash, "AAH-_wcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc")
        XCTAssertEqual(Fingerprint.words(keyHash: hash), ["aardvark", "absurd", "woodlark", "zulu"])
    }

    func testGivesNoWordsForAHashShorterThanFourBytes() {
        XCTAssertEqual(Fingerprint.words(keyHash: "AAH-"), [])
        XCTAssertEqual(Fingerprint.words(keyHash: "not base64!"), [])
    }
}
