import XCTest
@testable import FremkitCore

final class TouchDigitizerDecoderTests: XCTestCase {
    func testSelectsILITEKTouchscreenWithoutMatchingItsMouseInterface() {
        XCTAssertEqual(
            TouchHardwareProfile.match(vendorID: 0x27C0, productID: 0x0859, usagePage: 0x01, usage: 0x02),
            .edge
        )
        XCTAssertEqual(
            TouchHardwareProfile.match(vendorID: 0x222A, productID: 0x0001, usagePage: 0x0D, usage: 0x04),
            .ilitek
        )
        XCTAssertNil(TouchHardwareProfile.match(vendorID: 0x222A, productID: 0x0001, usagePage: 0x01, usage: 0x02))
        XCTAssertNil(TouchHardwareProfile.match(vendorID: 0x222B, productID: 0x0001, usagePage: 0x0D, usage: 0x04))
    }

    func testHardwareProfileRequiresItsDeviceAndPrefersReadyEdge() {
        XCTAssertEqual(TouchHardwareProfile.preferred(edgeDevice: true, edgeTarget: true,
                                                      ilitekDevice: true, ilitekTarget: true), .edge)
        XCTAssertEqual(TouchHardwareProfile.preferred(edgeDevice: false, edgeTarget: true,
                                                      ilitekDevice: true, ilitekTarget: true), .ilitek)
        XCTAssertEqual(TouchHardwareProfile.preferred(edgeDevice: true, edgeTarget: false,
                                                      ilitekDevice: true, ilitekTarget: true), .ilitek)
        XCTAssertNil(TouchHardwareProfile.preferred(edgeDevice: false, edgeTarget: true,
                                                     ilitekDevice: false, ilitekTarget: true))
    }

    func testSelectedProfileNeverFallsBackToAnotherDisplaysBounds() {
        XCTAssertNil(TouchHardwareProfile.target(for: .ilitek, edge: "Edge", ilitek: nil) as String?)
        XCTAssertEqual(TouchHardwareProfile.target(for: .ilitek, edge: "Edge", ilitek: "ILITEK"), "ILITEK")
        XCTAssertEqual(TouchHardwareProfile.target(for: .edge, edge: "Edge", ilitek: "ILITEK"), "Edge")
    }

    func testMapsNormalizedTouchToConfiguredDisplayBounds() {
        let bounds = CGRect(x: -2560, y: 1169, width: 2560, height: 733)
        let mapper = DisplayMapper(bounds: bounds)

        XCTAssertEqual(mapper.point(normalizedX: 0, normalizedY: 0), CGPoint(x: -2560, y: 1169))
        XCTAssertEqual(mapper.point(normalizedX: 1, normalizedY: 1), CGPoint(x: 0, y: 1902))
        XCTAssertEqual(mapper.point(normalizedX: 0.5, normalizedY: 0.5), CGPoint(x: -1280, y: 1535.5))
    }

    func testNormalizesILITEKContactCoordinatesAndTip() {
        var decoder = ILITEKTouchDecoder(primaryFingerCookie: 1)
        decoder.consume(.init(usagePage: 0x0D, usage: 0x30, value: 8192, logicalMinimum: 0, logicalMaximum: 16384, fingerCookie: 1))
        decoder.consume(.init(usagePage: 0x0D, usage: 0x31, value: 4800, logicalMinimum: 0, logicalMaximum: 9600, fingerCookie: 1))
        decoder.consume(.init(usagePage: 0x0D, usage: 0x42, value: 1, logicalMinimum: 0, logicalMaximum: 1, fingerCookie: 1))

        XCTAssertEqual(decoder.sample, HIDTouchSample(x: 0.5, y: 0.5, isDown: true, hasValidPosition: true, hasContactElement: true))
    }

    func testIgnoresRelativeMouseAxesAndSecondaryFinger() {
        var decoder = ILITEKTouchDecoder(primaryFingerCookie: 1)
        decoder.consume(.init(usagePage: 0x01, usage: 0x30, value: 7, logicalMinimum: 0, logicalMaximum: 255, isRelative: true))
        decoder.consume(.init(usagePage: 0x0D, usage: 0x30, value: 12000, logicalMinimum: 0, logicalMaximum: 16384, fingerCookie: 2))
        decoder.consume(.init(usagePage: 0x0D, usage: 0x30, value: 4096, logicalMinimum: 0, logicalMaximum: 16384, fingerCookie: 1))
        decoder.consume(.init(usagePage: 0x0D, usage: 0x31, value: 2400, logicalMinimum: 0, logicalMaximum: 9600, fingerCookie: 1))

        XCTAssertEqual(decoder.sample.x, 0.25, accuracy: 0.0001)
        XCTAssertEqual(decoder.sample.y, 0.25, accuracy: 0.0001)
        XCTAssertFalse(decoder.sample.hasContactElement)
    }

    func testClampsOutOfRangeDigitizerValues() {
        var decoder = ILITEKTouchDecoder()
        decoder.consume(.init(usagePage: 0x0D, usage: 0x30, value: 17000, logicalMinimum: 0, logicalMaximum: 16384))
        decoder.consume(.init(usagePage: 0x0D, usage: 0x31, value: -10, logicalMinimum: 0, logicalMaximum: 9600))

        XCTAssertEqual(decoder.sample.x, 1)
        XCTAssertEqual(decoder.sample.y, 0)
        XCTAssertTrue(decoder.sample.hasValidPosition)
    }

    func testDecodesAbsoluteMouseInterfaceCoordinatesAndPrimaryButton() {
        var decoder = ILITEKMouseDecoder()
        decoder.consume(.init(usagePage: 0x01, usage: 0x30, value: 8192,
                              logicalMinimum: 0, logicalMaximum: 16384))
        decoder.consume(.init(usagePage: 0x01, usage: 0x31, value: 4800,
                              logicalMinimum: 0, logicalMaximum: 9600))
        decoder.consume(.init(usagePage: 0x09, usage: 0x01, value: 1,
                              logicalMinimum: 0, logicalMaximum: 1))

        XCTAssertEqual(decoder.sample, HIDTouchSample(x: 0.5, y: 0.5, isDown: true,
                                                       hasValidPosition: true, hasContactElement: true))
        decoder.consume(.init(usagePage: 0x09, usage: 0x01, value: 0,
                              logicalMinimum: 0, logicalMaximum: 1))
        XCTAssertFalse(decoder.sample.isDown)
    }

    func testMouseDecoderIgnoresRelativeAxesAndUnrelatedButtons() {
        var decoder = ILITEKMouseDecoder()
        decoder.consume(.init(usagePage: 0x01, usage: 0x30, value: 12,
                              logicalMinimum: -127, logicalMaximum: 127, isRelative: true))
        decoder.consume(.init(usagePage: 0x01, usage: 0x31, value: 24,
                              logicalMinimum: -127, logicalMaximum: 127, isRelative: true))
        decoder.consume(.init(usagePage: 0x09, usage: 0x02, value: 1,
                              logicalMinimum: 0, logicalMaximum: 1))

        XCTAssertFalse(decoder.sample.hasValidPosition)
        XCTAssertFalse(decoder.sample.hasContactElement)
    }

    func testOneSourceOwnsEachPhysicalContactUntilRelease() {
        func sample(_ down: Bool) -> HIDTouchSample {
            HIDTouchSample(x: 0.5, y: 0.5, isDown: down,
                           hasValidPosition: true, hasContactElement: true)
        }
        var selector = ILITEKContactSourceSelector()

        XCTAssertEqual(selector.select(sample(true), from: .mouse), sample(true))
        XCTAssertNil(selector.select(sample(true), from: .digitizer))
        XCTAssertNil(selector.select(sample(false), from: .digitizer))
        XCTAssertEqual(selector.select(sample(false), from: .mouse), sample(false))
        XCTAssertEqual(selector.select(sample(true), from: .digitizer), sample(true))
        XCTAssertNil(selector.select(sample(false), from: .mouse))
        XCTAssertEqual(selector.select(sample(false), from: .digitizer), sample(false))
    }

    func testSiblingInterfaceRequiresSamePhysicalDeviceLocation() {
        let touchscreen = HIDPhysicalDeviceKey(vendorID: 0x222A, productID: 1, locationID: 0x01110000)
        XCTAssertTrue(touchscreen.isSibling(vendorID: 0x222A, productID: 1, locationID: 0x01110000))
        XCTAssertFalse(touchscreen.isSibling(vendorID: 0x222A, productID: 1, locationID: 0x01120000))
        XCTAssertFalse(touchscreen.isSibling(vendorID: 0x222A, productID: 2, locationID: 0x01110000))
    }
}
