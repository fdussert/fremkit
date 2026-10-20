import FremkitKit
import XCTest

/// The shared `subframes` vectors (test-vectors/devices.json), group by group.
final class SubframeTests: XCTestCase {
    private func check(_ whys: String..., file: StaticString = #filePath, line: UInt = #line) {
        let vectors = Vectors.all.subframes.filter { whys.contains($0.why) }
        XCTAssertFalse(vectors.isEmpty, "no shared vector for this test", file: file, line: line)
        for vector in vectors {
            XCTAssertEqual(Dashboard.allowsSubframe(vector.url.flatMap(URL.init(string:)), host: vector.host, port: vector.port),
                           vector.allowed, "\(vector.url ?? "nil") on \(vector.host):\(vector.port)", file: file, line: line)
        }
    }

    func testEverySharedVectorIsInAGroupThisFileChecks() {
        let groups: Set<String> = ["the Mac's widgets", "anything else", "where an earlier rule and the Mac's WidgetFrames disagreed",
                                   "no URL", "WidgetFrames: a widget document on the same origin",
                                   "WidgetFrames: everything else", "WidgetFrames: the page's own origin"]
        XCTAssertEqual(Set(Vectors.all.subframes.map(\.why)), groups)
    }

    func testAllowsTheMacsWidgets() {
        check("the Mac's widgets")
    }

    func testRefusesAnythingElse() {
        // Where the earlier rule and the Mac's `WidgetFrames` disagreed, the Mac's answer wins.
        check("anything else", "where an earlier rule and the Mac's WidgetFrames disagreed", "no URL")
    }

    // `WidgetFramesTests` (native/Tests/FremkitCoreTests), case for case, on the tablet's origin:
    // `http://127.0.0.1:4242` becomes `https://studio.local:4243`, and its other-origin cases
    // (another port, another name for the same host, another scheme) keep their meaning.

    func testWidgetFramesAllowsAWidgetDocumentOnTheSameOrigin() {
        check("WidgetFrames: a widget document on the same origin")
    }

    func testWidgetFramesRefusesEverythingElse() {
        check("WidgetFrames: everything else", "no URL")
    }

    func testWidgetFramesFollowsThePagesOwnOrigin() {
        check("WidgetFrames: the page's own origin")
    }
}
