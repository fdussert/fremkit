import CryptoKit
import XCTest
@testable import FremkitKit

/// A P-256 public key in DER SubjectPublicKeyInfo form (the shared `spki` vector), made with
/// `openssl ecparam -name prime256v1 -genkey | openssl ec -pubout -outform DER`. Its hash was
/// computed by `openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='`.
enum SPKIFixture {
    static let keyHash = Vectors.all.spki.keyHash
    static var der: Data { Data(hex: Vectors.all.spki.derHex) }
}

final class PinTests: XCTestCase {
    func testHashesAnSPKILikeOpenSSL() {
        XCTAssertEqual(Pin.keyHash(spki: SPKIFixture.der), SPKIFixture.keyHash)
    }

    func testRebuildsTheSPKIOfARawP256Key() {
        let raw = SPKIFixture.der.dropFirst(Vectors.all.spki.rawOffset)
        XCTAssertEqual(Pin.spki(p256Raw: Data(raw)), SPKIFixture.der)
    }

    func testRefusesARawKeyThatIsNotAnUncompressedP256Point() {
        for hex in Vectors.all.spki.rejectedRawHex {
            XCTAssertNil(Pin.spki(p256Raw: Data(hex: hex)), hex)
        }
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
        XCTAssertEqual(Fingerprint.listSHA256, Vectors.all.fingerprint.listSha256)
    }

    func testBundledListHashesToTheConstant() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "fingerprint-words", withExtension: "txt"))
        let digest = SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(digest, Fingerprint.listSHA256)
        XCTAssertEqual(Fingerprint.list.count, Vectors.all.fingerprint.listLength)
    }

    func testMapsTheFirstFourBytesToWords() {
        // The shared vectors, which server/test/devices-fingerprint.test.ts reads too.
        for vector in Vectors.all.fingerprint.cases {
            XCTAssertEqual(Data(hex: vector.bytesHex).base64URLEncoded(), vector.keyHash)
            XCTAssertEqual(Fingerprint.words(keyHash: vector.keyHash), vector.words)
        }
    }

    func testGivesNoWordsForAHashShorterThanFourBytes() {
        // Where the server throws, the app shows no words.
        for keyHash in Vectors.all.fingerprint.tooShort {
            XCTAssertEqual(Fingerprint.words(keyHash: keyHash), [], keyHash)
        }
        // Not shared: Node's base64url decoder skips the characters it does not know.
        XCTAssertEqual(Fingerprint.words(keyHash: "not base64!"), [])
    }
}
