import XCTest
@testable import FremkitCore

final class DockBadgeParserTests: XCTestCase {
    private func item(_ title: String?, _ badge: String?, running: Bool = true, bundle: String? = "com.example.app") -> RawDockItem {
        RawDockItem(title: title, statusLabel: badge, isRunning: running, bundleIdentifier: bundle)
    }

    func testKeepsTheDockOrderAndReadsEveryField() {
        let apps = DockBadgeParser.parse([
            item("Mail", "12", running: true, bundle: "com.example.mail"),
            item("Notes", nil, running: false, bundle: "com.example.notes"),
        ])
        XCTAssertEqual(apps.count, 2)
        XCTAssertEqual(apps[0], DockApp(bundleId: "com.example.mail", name: "Mail", badge: "12", running: true))
        XCTAssertEqual(apps[1], DockApp(bundleId: "com.example.notes", name: "Notes", badge: nil, running: false))
    }

    func testDropsAnItemWithoutABundleIdentifier() {
        // Separators, stacks and the Trash have no bundle, and nothing can be done with them.
        let apps = DockBadgeParser.parse([item("Corbeille", nil, bundle: nil), item("Mail", nil, bundle: "com.example.mail")])
        XCTAssertEqual(apps.map(\.bundleId), ["com.example.mail"])
    }

    func testDropsAnItemWithAnEmptyBundleIdentifier() {
        XCTAssertTrue(DockBadgeParser.parse([item("Mail", nil, bundle: "")]).isEmpty)
    }

    func testFallsBackToTheBundleIdentifierWhenThereIsNoTitle() {
        let apps = DockBadgeParser.parse([item(nil, nil, bundle: "com.example.mail")])
        XCTAssertEqual(apps[0].name, "com.example.mail")
    }

    func testTrimsTheBadgeAndTreatsAnEmptyOneAsAbsent() {
        let apps = DockBadgeParser.parse([item("Mail", "  7 "), item("Notes", "   ", bundle: "com.example.notes")])
        XCTAssertEqual(apps[0].badge, "7")
        XCTAssertNil(apps[1].badge)
    }

    func testKeepsANonNumericBadgeAsIs() {
        // Some apps put a dot, a word or an emoji there; the widget decides how to draw it.
        XCTAssertEqual(DockBadgeParser.parse([item("Mail", "•")])[0].badge, "•")
    }

    func testKeepsOnlyTheFirstItemOfADuplicatedBundle() {
        let apps = DockBadgeParser.parse([
            item("Mail", "3", bundle: "com.example.mail"),
            item("Mail", nil, bundle: "com.example.mail"),
        ])
        XCTAssertEqual(apps.count, 1)
        XCTAssertEqual(apps[0].badge, "3")
    }

    func testSignatureChangesWithTheBadgeAndWithTheRunningFlag() {
        let base = DockBadgeParser.parse([item("Mail", "3")])
        XCTAssertEqual(DockBadgeParser.signature(base), DockBadgeParser.signature(DockBadgeParser.parse([item("Mail", "3")])))
        XCTAssertNotEqual(DockBadgeParser.signature(base), DockBadgeParser.signature(DockBadgeParser.parse([item("Mail", "4")])))
        XCTAssertNotEqual(DockBadgeParser.signature(base), DockBadgeParser.signature(DockBadgeParser.parse([item("Mail", "3", running: false)])))
        XCTAssertNotEqual(DockBadgeParser.signature(base), DockBadgeParser.signature([]))
    }

    func testSignatureIgnoresTheDisplayNameOnly() {
        // The Dock renames an item when the app is renamed; that is not worth a POST on its own.
        let a = DockBadgeParser.parse([item("Mail", "3")])
        let b = DockBadgeParser.parse([item("Courrier", "3")])
        XCTAssertEqual(DockBadgeParser.signature(a), DockBadgeParser.signature(b))
    }
}
