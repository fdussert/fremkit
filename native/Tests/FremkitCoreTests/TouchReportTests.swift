import XCTest
@testable import FremkitCore

final class TouchReportTests: XCTestCase {
    func testParsesCapturedDownReport() {
        let bytes: [UInt8] = [0x07, 0x01, 0x75, 0x16, 0x9c, 0x0d, 0x00]
        XCTAssertEqual(TouchReport.parse(bytes), TouchReport(down: true, x: 5749, y: 3484))
    }

    func testParsesUpReportAtMaximumCoordinates() {
        let bytes: [UInt8] = [0x07, 0x00, 0xff, 0x3f, 0x7f, 0x25, 0x00]
        let report = TouchReport.parse(bytes)
        XCTAssertEqual(report?.down, false)
        XCTAssertEqual(report?.x, TouchReport.xMax)
        XCTAssertEqual(report?.y, TouchReport.yMax)
        XCTAssertEqual(report?.x, 16383)
        XCTAssertEqual(report?.y, 9599)
    }

    func testRejectsOtherReportID() {
        XCTAssertNil(TouchReport.parse([0x06, 0x01, 0x75, 0x16, 0x9c, 0x0d, 0x00]))
    }

    func testRejectsShortReport() {
        XCTAssertNil(TouchReport.parse([0x07, 0x01, 0x75, 0x16, 0x9c, 0x0d]))
    }

    func testAcceptsLongerReport() {
        let bytes: [UInt8] = [0x07, 0x01, 0x75, 0x16, 0x9c, 0x0d, 0x00, 0x00]
        XCTAssertEqual(TouchReport.parse(bytes), TouchReport(down: true, x: 5749, y: 3484))
    }

    func testEmptyReportIsRejected() {
        XCTAssertNil(TouchReport.parse([]))
    }

    func testConstants() {
        XCTAssertEqual(TouchReport.reportID, 7)
        XCTAssertEqual(TouchReport.length, 7)
    }
}
