import XCTest
@testable import FremkitKit

final class PairingLinkTests: XCTestCase {
    static let key = "Y4nRTFWKfvKwllWID7DQPMgZIF8SqUUvgWkQZsK_ArQ"

    private func link(_ query: String) -> PairingLink? {
        PairingLink(url: URL(string: "fremkit://pair?\(query)")!)
    }

    private let valid = "h=studio.local&a=192.0.2.10&p=4243&c=ABCDEFGH&k=\(PairingLinkTests.key)"

    func testParsesAValidLink() throws {
        let parsed = try XCTUnwrap(link(valid))
        XCTAssertEqual(parsed, PairingLink(host: "studio.local", address: "192.0.2.10", port: 4243, code: "ABCDEFGH", keyHash: Self.key))
    }

    static let secret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"

    func testALinkWithoutASecretHasNone() throws {
        XCTAssertNil(try XCTUnwrap(link(valid)).secret, "a Mac from before the secret still pairs, with the code")
    }

    func testParsesTheSecret() throws {
        let parsed = try XCTUnwrap(link("h=studio.local&a=192.0.2.10&p=4243&c=ABCDEFGH&s=\(Self.secret)&k=\(Self.key)"))
        XCTAssertEqual(parsed, PairingLink(host: "studio.local", address: "192.0.2.10", port: 4243, code: "ABCDEFGH",
                                           keyHash: Self.key, secret: Self.secret))
    }

    func testRefusesABadSecret() {
        let s = Self.secret
        for secret in ["", String(s.dropLast()), s + "A", String(s.dropLast()) + "=", String(s.dropLast()) + "+",
                       String(s.dropLast()) + "F", "ABCDEFGH"] {
            XCTAssertNil(link("\(valid)&s=\(secret)"), "secret \(secret) parsed")
        }
        XCTAssertNil(link("\(valid)&s=\(s)&s=\(s)"), "a repeated secret parsed")
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
        for address in ["2001:db8::1", "fe80::1%25en0", "%5B2001:db8::1%5D"] {
            XCTAssertNil(link("h=studio.local&a=\(address)&p=4243&c=ABCDEFGH&k=\(Self.key)"), address)
        }
    }

    func testNormalisesALowercaseCodeWithADash() throws {
        let parsed = try XCTUnwrap(link("h=studio.local&a=192.0.2.10&p=4243&c=abcd-efgh&k=\(Self.key)"))
        XCTAssertEqual(parsed.code, "ABCDEFGH")
    }

    func testRefusesALinkMissingAnyField() {
        for name in ["h", "a", "p", "c", "k"] {
            let query = valid.split(separator: "&").filter { !$0.hasPrefix("\(name)=") }.joined(separator: "&")
            XCTAssertNil(link(query), "a link without \(name) parsed")
        }
    }

    func testRefusesABadPort() {
        for port in ["0", "65536", "-1", "abc", "42%2043", ""] {
            XCTAssertNil(link("h=studio.local&a=192.0.2.10&p=\(port)&c=ABCDEFGH&k=\(Self.key)"), "port \(port) parsed")
        }
        XCTAssertNotNil(link("h=studio.local&a=192.0.2.10&p=65535&c=ABCDEFGH&k=\(Self.key)"))
    }

    func testRefusesABadKey() {
        for key in [String(Self.key.dropLast()), Self.key + "A", String(Self.key.dropLast()) + "=", String(Self.key.dropLast()) + "+",
                    String(Self.key.dropLast()) + "R"] {
            XCTAssertNil(link("h=studio.local&a=192.0.2.10&p=4243&c=ABCDEFGH&k=\(key)"), "key \(key) parsed")
        }
    }

    func testRefusesAHostThatIsNotLocal() {
        for host in ["studio.example.com", ".local", "studio", "stu%20dio.local", "studio/x.local"] {
            XCTAssertNil(link("h=\(host)&a=192.0.2.10&p=4243&c=ABCDEFGH&k=\(Self.key)"), "host \(host) parsed")
        }
    }

    func testRefusesAnAddressThatIsNotAnIPLiteral() {
        for address in ["studio.local", "192.0.2", "192.0.2.300", "example.com", ""] {
            XCTAssertNil(link("h=studio.local&a=\(address)&p=4243&c=ABCDEFGH&k=\(Self.key)"), "address \(address) parsed")
        }
    }

    func testRefusesAnotherSchemeOrAction() {
        XCTAssertNil(PairingLink(url: URL(string: "https://pair?\(valid)")!))
        XCTAssertNil(PairingLink(url: URL(string: "fremkit://unpair?\(valid)")!))
    }

    func testDropsATrailingDotFromTheHost() throws {
        let parsed = try XCTUnwrap(link("h=Studio.local.&a=192.0.2.10&p=4243&c=ABCDEFGH&k=\(Self.key)"))
        XCTAssertEqual(parsed.host, "Studio.local")
    }

    func testPrintingNeverShowsTheKeyOrCode() throws {
        let parsed = try XCTUnwrap(link(valid))
        var dumped = ""
        dump(parsed, to: &dumped)
        let text = "\(parsed) \(String(reflecting: parsed)) \(dumped)"
        XCTAssertFalse(text.contains(Self.key))
        XCTAssertFalse(text.contains("ABCDEFGH"))
        XCTAssertTrue(dumped.contains("studio.local"))
    }

    func testRefusesABadCode() {
        XCTAssertNil(link("h=studio.local&a=192.0.2.10&p=4243&c=ABCDEFG0&k=\(Self.key)"))
    }
}

final class NormaliseCodeTests: XCTestCase {
    func testUppercasesAndDropsSpacesAndDashes() {
        XCTAssertEqual(normaliseCode(" abcd-efgh "), "ABCDEFGH")
        XCTAssertEqual(normaliseCode("AB CD EF 23"), "ABCDEF23")
    }

    func testRefusesCharactersOutsideTheAlphabet() {
        XCTAssertNil(normaliseCode("ABCDEFG0"))
        XCTAssertNil(normaliseCode("ABCDEFGI"))
        XCTAssertNil(normaliseCode("ABCDEFG1"))
        XCTAssertNil(normaliseCode("ABCDÉFGH"))
    }

    func testRefusesTheWrongLength() {
        XCTAssertNil(normaliseCode("ABCDEFG"))
        XCTAssertNil(normaliseCode("ABCDEFGHJ"))
        XCTAssertNil(normaliseCode(""))
    }
}
