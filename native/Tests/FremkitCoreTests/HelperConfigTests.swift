import Foundation
import XCTest
@testable import FremkitCore

final class HelperConfigTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("FremkitConfigTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func write(_ json: String) throws -> URL {
        let url = directory.appendingPathComponent("helper.json")
        try json.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func testDefaults() {
        let config = HelperConfig.default
        XCTAssertEqual(config.repoPath, NSHomeDirectory() + "/fremkit")
        XCTAssertEqual(config.url, "http://127.0.0.1:4242/?kiosk=1")
        XCTAssertEqual(config.adminUrl, "http://127.0.0.1:4242/admin")
        XCTAssertEqual(config.port, 4242)
        XCTAssertEqual(config.display, HelperConfig.DisplaySize(width: 2560, height: 720))
        XCTAssertTrue(config.touch)
        XCTAssertTrue(config.fence)
        XCTAssertTrue(config.manageServer)
        XCTAssertFalse(config.launchAtLogin)
        XCTAssertFalse(config.scrollInvert)
        XCTAssertTrue(config.dock)
    }

    func testScrollInvertDecodesAndDefaultsToFalseWhenAbsent() throws {
        let absent = try write("{\"touch\":true}")
        XCTAssertFalse(HelperConfig.load(from: absent).scrollInvert)

        let present = try write("{\"scrollInvert\":true}")
        XCTAssertTrue(HelperConfig.load(from: present).scrollInvert)
    }

    func testDockDecodesAndDefaultsToTrueWhenAbsent() throws {
        let absent = try write("{\"touch\":true}")
        XCTAssertTrue(HelperConfig.load(from: absent).dock)

        let off = try write("{\"dock\":false}")
        XCTAssertFalse(HelperConfig.load(from: off).dock)
    }

    func testMissingFileFallsBackToDefaults() {
        let url = directory.appendingPathComponent("absent.json")
        XCTAssertEqual(HelperConfig.load(from: url), .default)
    }

    func testPartialJSONKeepsDefaultsForMissingFields() throws {
        let url = try write("{\"touch\":false}")
        let config = HelperConfig.load(from: url)
        XCTAssertFalse(config.touch)
        XCTAssertEqual(config.port, HelperConfig.default.port)
        XCTAssertEqual(config.url, HelperConfig.default.url)
        XCTAssertEqual(config.display, HelperConfig.default.display)
        XCTAssertTrue(config.fence)
    }

    func testPartialDisplayKeepsTheOtherDimension() throws {
        let url = try write("{\"display\":{\"width\":1920}}")
        let config = HelperConfig.load(from: url)
        XCTAssertEqual(config.display.width, 1920)
        XCTAssertEqual(config.display.height, HelperConfig.default.display.height)
    }

    func testCorruptFileFallsBackToDefaults() throws {
        let url = try write("{not json at all")
        XCTAssertEqual(HelperConfig.load(from: url), .default)
    }

    func testSaveThenLoadRoundTrips() throws {
        let url = directory.appendingPathComponent("nested/helper.json")
        var config = HelperConfig.default
        config.port = 5151
        config.touch = false
        config.display = HelperConfig.DisplaySize(width: 1920, height: 515)
        try config.save(to: url)
        XCTAssertEqual(HelperConfig.load(from: url), config)
    }

    func testSaveOverwritesAnExistingFile() throws {
        let url = directory.appendingPathComponent("helper.json")
        try HelperConfig.default.save(to: url)
        var config = HelperConfig.default
        config.launchAtLogin = true
        try config.save(to: url)
        XCTAssertEqual(HelperConfig.load(from: url), config)
        // No temporary leftovers next to the file.
        let siblings = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(siblings.filter { $0.hasSuffix(".tmp") }, [])
    }

    func testDefaultURL() {
        let url = HelperConfig.defaultURL
        XCTAssertEqual(url.lastPathComponent, "helper.json")
        XCTAssertEqual(url.deletingLastPathComponent().lastPathComponent, "Fremkit")
        XCTAssertTrue(url.path.contains("Application Support"))
    }
}
