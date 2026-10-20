import FremkitKit
import XCTest

/// The shared `mainFrames` vectors (test-vectors/devices.json).
final class MainFrameTests: XCTestCase {
    private func check(_ whys: String..., file: StaticString = #filePath, line: UInt = #line) {
        let vectors = Vectors.all.mainFrames.navigations.filter { whys.contains($0.why) }
        XCTAssertFalse(vectors.isEmpty, "no shared vector for this test", file: file, line: line)
        for vector in vectors {
            XCTAssertEqual(Dashboard.allowsMainFrame(vector.url.flatMap(URL.init(string:)), host: vector.host, port: vector.port),
                           vector.allowed, "\(vector.url ?? "nil") on \(vector.host):\(vector.port)", file: file, line: line)
        }
    }

    func testAllowsTheMacsOwnOrigin() {
        check("the Mac's own origin")
    }

    func testRefusesAnyOtherOrigin() {
        check("any other origin", "no URL")
        XCTAssertEqual(Set(Vectors.all.mainFrames.navigations.map(\.why)), ["the Mac's own origin", "any other origin", "no URL"])
    }

    func testHearsThePageFromItsOwnOriginOnly() {
        let vectors = Vectors.all.mainFrames.pageOrigins
        XCTAssertFalse(vectors.isEmpty)
        for v in vectors {
            XCTAssertEqual(Dashboard.isPageOrigin(scheme: v.scheme, host: v.originHost, port: v.originPort, host: v.host, port: v.port),
                           v.heard, "\(v.scheme)://\(v.originHost):\(v.originPort) for \(v.host):\(v.port)")
        }
    }
}
