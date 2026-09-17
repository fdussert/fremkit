import XCTest
@testable import FremkitCore

final class L10nTests: XCTestCase {
    func testPicksFrenchForAFrenchSystem() {
        XCTAssertEqual(L10n.language(preferred: ["fr"]), .fr)
        XCTAssertEqual(L10n.language(preferred: ["fr-FR", "en-US"]), .fr)
        XCTAssertEqual(L10n.language(preferred: ["FR-ca"]), .fr)
    }

    func testPicksEnglishForEverythingElse() {
        XCTAssertEqual(L10n.language(preferred: ["en-GB"]), .en)
        XCTAssertEqual(L10n.language(preferred: ["de-DE", "fr-FR"]), .en)
        XCTAssertEqual(L10n.language(preferred: []), .en)
    }

    func testEveryKeyIsWrittenInBothLanguages() {
        for key in L10nKey.allCases {
            XCTAssertFalse(L10n.string(key, language: .fr).isEmpty)
            XCTAssertFalse(L10n.string(key, language: .en).isEmpty)
            // A key missing from a table falls back to its own name; none should.
            XCTAssertNotEqual(L10n.string(key, language: .fr), key.rawValue)
            XCTAssertNotEqual(L10n.string(key, language: .en), key.rawValue)
        }
    }

    func testFormatsTheValuesThatCarryOne() {
        XCTAssertEqual(L10n.string(.serverRestarting, 8, language: .fr), "Serveur : redémarrage dans 8 s")
        XCTAssertEqual(L10n.string(.serverRestarting, 8, language: .en), "Server: restarting in 8 s")
        XCTAssertEqual(L10n.string(.touchOpenFailed, 0xE00002C5 as UInt32, language: .en), "Touch: could not open it (0xE00002C5)")
    }
}
