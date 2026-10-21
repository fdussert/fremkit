import XCTest
@testable import FremkitKit

final class PairingLinkTests: XCTestCase {
    static let key = Vectors.all.spki.keyHash
    static let secret = Vectors.all.pairingLinks.compactMap(\.expect?.secret).first!

    private func link(_ query: String) -> PairingLink? {
        PairingLink(url: URL(string: "fremkit://pair?\(query)")!)
    }

    /// The query of the shared vectors' first link, a valid one without a secret.
    private var valid: String {
        String(Vectors.all.pairingLinks[0].url.dropFirst("fremkit://pair?".count))
    }

    /// Checks the shared links whose `why` passes `filter`, and that there is at least one.
    private func checkLinks(_ filter: (String) -> Bool, file: StaticString = #filePath, line: UInt = #line) {
        let vectors = Vectors.all.pairingLinks.filter { filter($0.why) }
        XCTAssertFalse(vectors.isEmpty, "no shared link for this test", file: file, line: line)
        for vector in vectors {
            guard let url = URL(string: vector.url) else {
                XCTFail("not a URL: \(vector.url)", file: file, line: line)
                continue
            }
            let parsed = PairingLink(url: url)
            if let e = vector.expect {
                XCTAssertEqual(parsed, PairingLink(host: e.host, address: e.address, port: e.port, code: e.code, keyHash: e.keyHash,
                                                   secret: e.secret), "\(vector.why): \(vector.url)", file: file, line: line)
            } else {
                XCTAssertNil(parsed, "\(vector.why): \(vector.url) parsed", file: file, line: line)
            }
        }
    }

    private func checkLinks(_ whys: String..., file: StaticString = #filePath, line: UInt = #line) {
        checkLinks({ whys.contains($0) }, file: file, line: line)
    }

    func testParsesEverySharedLinkAsExpected() {
        checkLinks { _ in true }
    }

    func testParsesAValidLink() {
        checkLinks("a valid link")
    }

    func testALinkWithoutASecretHasNone() throws {
        let first = try XCTUnwrap(Vectors.all.pairingLinks.first)
        XCTAssertEqual(first.why, "a valid link")
        XCTAssertNil(try XCTUnwrap(link(valid)).secret, "a Mac from before the secret still pairs, with the code")
    }

    func testParsesTheSecret() {
        checkLinks("a link with the secret")
    }

    func testRefusesABadSecret() {
        checkLinks("a bad secret", "a repeated secret")
    }

    func testPrintingALinkNeverShowsTheSecret() throws {
        let parsed = try XCTUnwrap(link("\(valid)&s=\(Self.secret)"))
        var dumped = ""
        dump(parsed, to: &dumped)
        for text in [String(describing: parsed), String(reflecting: parsed), dumped] {
            XCTAssertFalse(text.contains(Self.secret))
        }
    }

    func testRefusesAnIPv6AddressTheMacWouldAnswer421To() {
        checkLinks("an IPv6 address, which the Mac would answer 421 to")
    }

    func testNormalisesALowercaseCodeWithADash() {
        checkLinks("a lowercase code with a dash")
    }

    func testRefusesALinkMissingAnyField() {
        checkLinks { $0.hasPrefix("no ") }
        XCTAssertEqual(Vectors.all.pairingLinks.filter { $0.why.hasPrefix("no ") }.count, 5, "one per required field")
    }

    func testRefusesABadPort() {
        checkLinks("a bad port", "the highest port")
    }

    func testRefusesABadKey() {
        checkLinks("a bad key hash")
    }

    func testRefusesAHostThatIsNotLocal() {
        checkLinks("a host that is not a .local name")
    }

    func testRefusesAnAddressThatIsNotAnIPLiteral() {
        checkLinks("an address that is not an IP literal")
    }

    func testRefusesAnotherSchemeOrAction() {
        checkLinks("another scheme", "another action")
    }

    func testDropsATrailingDotFromTheHost() {
        checkLinks("a trailing dot on the host, dropped")
    }

    func testPrintingNeverShowsTheKeyOrCode() throws {
        let parsed = try XCTUnwrap(link(valid))
        var dumped = ""
        dump(parsed, to: &dumped)
        let text = "\(parsed) \(String(reflecting: parsed)) \(dumped)"
        XCTAssertFalse(text.contains(Self.key))
        XCTAssertFalse(text.contains(parsed.code))
        XCTAssertTrue(dumped.contains("studio.local"))
    }

    func testRefusesABadCode() {
        checkLinks("a code with a character outside the alphabet")
    }
}

final class NormaliseCodeTests: XCTestCase {
    private func checkCodes(_ why: String, file: StaticString = #filePath, line: UInt = #line) {
        let vectors = Vectors.all.codes.normalise.filter { $0.why == why }
        XCTAssertFalse(vectors.isEmpty, "no shared code for this test", file: file, line: line)
        for vector in vectors {
            XCTAssertEqual(normaliseCode(vector.input), vector.output, "\(vector.input)", file: file, line: line)
        }
    }

    func testTheAlphabetAndLengthAreTheServers() {
        XCTAssertEqual(pairingCodeAlphabet, Set(Vectors.all.codes.alphabet))
        XCTAssertEqual(pairingCodeAlphabet.count, Vectors.all.codes.alphabet.count)
        for vector in Vectors.all.codes.normalise {
            if let output = vector.output { XCTAssertEqual(output.count, Vectors.all.codes.length) }
        }
    }

    func testUppercasesAndDropsSpacesAndDashes() {
        checkCodes("any case, spaces and a dash")
    }

    func testRefusesCharactersOutsideTheAlphabet() {
        checkCodes("outside the alphabet")
    }

    func testRefusesTheWrongLength() {
        checkCodes("the wrong length")
    }
}
