import Foundation
import XCTest
@testable import FremkitCore

final class DDCTests: XCTestCase {
    /// The Xeneon Edge's own answer to "get luminance", captured on the owner's Mac: 95 of 100.
    static let edgeReply: [UInt8] = [0x6E, 0x88, 0x02, 0x00, 0x10, 0x00, 0x00, 0x64, 0x00, 0x5F, 0x9F]
    /// A Dell S3221QS's first answer on the same Mac: a null message, the rest stale.
    static let dellNotReady: [UInt8] = [0x6E, 0x80, 0xBE, 0x00, 0x10, 0x00, 0x00, 0x64, 0x00, 0x4B, 0x8B]

    func testGetRequestMatchesTheProbe() {
        XCTAssertEqual(DDC.getRequest(0x10), [0x82, 0x01, 0x10, 0x6E ^ 0x51 ^ 0x82 ^ 0x01 ^ 0x10])
    }

    func testSetRequestCarriesTheValueBigEndianWithItsChecksum() {
        let packet = DDC.setRequest(0x10, value: 0x0150)
        XCTAssertEqual(Array(packet.prefix(5)), [0x84, 0x03, 0x10, 0x01, 0x50])
        XCTAssertEqual(packet[5], 0x6E ^ 0x51 ^ 0x84 ^ 0x03 ^ 0x10 ^ 0x01 ^ 0x50)
    }

    func testParsesTheEdgeReply() {
        XCTAssertEqual(DDC.parseReply(Self.edgeReply, code: 0x10), .success(DDC.Value(current: 95, maximum: 100)))
    }

    func testANullMessageIsNotReady() {
        XCTAssertEqual(DDC.parseReply(Self.dellNotReady, code: 0x10), .failure(.notReady))
        XCTAssertEqual(DDC.parseReply([0x6E, 0x88], code: 0x10), .failure(.notReady))
    }

    func testRefusesAGarbledOrForeignReply() {
        var garbled = Self.edgeReply
        garbled[9] = 0x60
        XCTAssertEqual(DDC.parseReply(garbled, code: 0x10), .failure(.checksum))
        XCTAssertEqual(DDC.parseReply(Self.edgeReply, code: 0x12), .failure(.mismatched))
    }

    func testAnUnsupportedCodeIsSaidSo() {
        var reply = Self.edgeReply
        reply[3] = 0x01
        reply[10] = reply[0..<10].reduce(UInt8(0x50), ^)
        XCTAssertEqual(DDC.parseReply(reply, code: 0x10), .failure(.unsupported))
    }

    func testConvertsBetweenPercentAndRaw() {
        XCTAssertEqual(DDC.percent(DDC.Value(current: 95, maximum: 100)), 95)
        XCTAssertEqual(DDC.percent(DDC.Value(current: 128, maximum: 255)), 50)
        XCTAssertEqual(DDC.percent(DDC.Value(current: 300, maximum: 255)), 100)
        XCTAssertEqual(DDC.raw(percent: 50, maximum: 255), 128)
        XCTAssertEqual(DDC.raw(percent: 140, maximum: 100), 100)
        XCTAssertEqual(DDC.raw(percent: -5, maximum: 100), 0)
    }
}

final class DDCMatcherTests: XCTestCase {
    // The owner's desk: the Edge and two identical Dells, as the registry described them.
    let edge = DDCMatcher.Candidate(framebuffer: "IOService:/x/dispext0@B0000000/IOMobileFramebufferShim", vendor: 3672, product: 60672, serial: 16843009, name: "XENEON EDGE")
    let dellA = DDCMatcher.Candidate(framebuffer: "IOService:/x/dispext1@90000000/IOMobileFramebufferShim", vendor: 4268, product: 53511, serial: 810963798, name: "DELL S3221QSA")
    let dellB = DDCMatcher.Candidate(framebuffer: "IOService:/x/dispext2@0/IOMobileFramebufferShim", vendor: 4268, product: 53511, serial: 810301270, name: "DELL S3221QSA")

    func testMatchesByFramebufferLocation() {
        let target = DDCMatcher.Target(location: "IOService:/x/dispext2@0/IOMobileFramebufferShim", vendor: 4268, product: 53511, serial: 810301270)
        XCTAssertEqual(DDCMatcher.match(target, among: [edge, dellA, dellB]), .match(2))
    }

    func testTwinsWithoutLocationOrSerialAreAmbiguous() {
        let noSerialA = DDCMatcher.Candidate(framebuffer: nil, vendor: 4268, product: 53511, serial: nil, name: nil)
        let target = DDCMatcher.Target(location: nil, vendor: 4268, product: 53511, serial: 0)
        XCTAssertEqual(DDCMatcher.match(target, among: [noSerialA, noSerialA]), .ambiguous)
    }

    func testFallsBackToTheSerialWhenTheLocationIsUnknown() {
        let target = DDCMatcher.Target(location: nil, vendor: 4268, product: 53511, serial: 810963798)
        XCTAssertEqual(DDCMatcher.match(target, among: [edge, dellA, dellB]), .match(1))
        let edgeTarget = DDCMatcher.Target(location: nil, vendor: 3672, product: 60672, serial: 0)
        XCTAssertEqual(DDCMatcher.match(edgeTarget, among: [edge, dellA, dellB]), .match(0))
    }

    func testAKnownLocationWithNoServiceUnderItMatchesNothing() {
        // The Edge on a port with no DDC service: its twin's service must not be borrowed.
        let target = DDCMatcher.Target(location: "IOService:/x/dispext3@0/IOMobileFramebufferShim", vendor: 4268, product: 53511, serial: 810963798)
        XCTAssertEqual(DDCMatcher.match(target, among: [edge, dellA, dellB]), .none)
        XCTAssertEqual(DDCMatcher.match(DDCMatcher.Target(location: nil, vendor: 1, product: 2, serial: 0), among: [edge]), .none)
    }
}

final class BrightnessThrottleTests: XCTestCase {
    func testFirstValueGoesOutAtOnceAndTheLastOfABurstAfterTheInterval() {
        var throttle = BrightnessThrottle(interval: 0.1)
        XCTAssertEqual(throttle.offer(10, now: 1.0), 10)
        XCTAssertNil(throttle.offer(20, now: 1.02))
        XCTAssertNil(throttle.offer(30, now: 1.05))
        XCTAssertEqual(throttle.deadline ?? 0, 1.1, accuracy: 1e-9)
        XCTAssertNil(throttle.due(now: 1.08))
        XCTAssertEqual(throttle.due(now: 1.1), 30)
        XCTAssertNil(throttle.deadline)
        XCTAssertNil(throttle.due(now: 2))
    }

    func testAValueAfterAQuietSpellGoesOutAtOnce() {
        var throttle = BrightnessThrottle(interval: 0.1)
        _ = throttle.offer(10, now: 1.0)
        XCTAssertEqual(throttle.offer(40, now: 1.5), 40)
    }
}

final class BrightnessChannelTests: XCTestCase {
    func message(_ json: String) -> Data { Data(json.utf8) }

    func testReadsTheKiosksDirective() {
        let json = #"{"type":"data","channel":"brightness","data":{"kiosk":"edge","screens":{"edge":{"available":true,"value":60,"target":55,"seq":4,"mode":"day-night"},"ipad":{"available":false,"seq":0}}}}"#
        XCTAssertEqual(BrightnessChannel.directive(from: message(json)),
                       BrightnessChannel.Directive(screen: "edge", available: true, target: 55, seq: 4, value: 60))
    }

    func testANullTargetMeansLeaveItAlone() {
        let json = #"{"type":"data","channel":"brightness","data":{"kiosk":"edge","screens":{"edge":{"available":true,"value":null,"target":null,"seq":0}}}}"#
        XCTAssertNil(BrightnessChannel.directive(from: message(json))?.target)
    }

    func testIgnoresOtherMessages() {
        XCTAssertNil(BrightnessChannel.directive(from: message(#"{"type":"data","channel":"volume","data":{}}"#)))
        XCTAssertNil(BrightnessChannel.directive(from: message(#"{"type":"result","id":"b1","result":{}}"#)))
        XCTAssertNil(BrightnessChannel.directive(from: message(#"{"type":"data","channel":"brightness","data":{"kiosk":null,"screens":{}}}"#)))
        XCTAssertNil(BrightnessChannel.directive(from: message("not json")))
    }

    func testBuildsAReportTheServerAccepts() {
        let body = BrightnessChannel.report(screen: nil, available: true, reason: nil, value: 120, display: "XENEON EDGE", builtin: 0.62, applied: 3)
        XCTAssertTrue(body["screen"] is NSNull)
        XCTAssertEqual(body["value"] as? Int, 100)
        XCTAssertEqual(body["builtin"] as? Double, 0.62)
        XCTAssertEqual(body["applied"] as? Int, 3)
        XCTAssertNil(body["reason"])
        let off = BrightnessChannel.report(screen: "edge", available: false, reason: .noDDC, value: nil, display: nil, builtin: nil, applied: nil)
        XCTAssertEqual(off["reason"] as? String, "no-ddc")
        XCTAssertTrue(off["value"] is NSNull)
        XCTAssertNil(off["display"])
    }

    func testSetMessageClampsTheLevel() {
        XCTAssertEqual(BrightnessChannel.setMessage(id: "m1", value: 140),
                       #"{"type":"command","id":"m1","channel":"brightness","name":"set","payload":{"value":100}}"#)
    }

    func testReadsTheScreenFromTheKioskURL() {
        XCTAssertEqual(BrightnessChannel.screen(fromKioskURL: URL(string: "http://127.0.0.1:4242/?screen=edge-2&kiosk=1")!), "edge-2")
        XCTAssertNil(BrightnessChannel.screen(fromKioskURL: URL(string: "http://127.0.0.1:4242/")!))
        XCTAssertNil(BrightnessChannel.screen(fromKioskURL: URL(string: "http://127.0.0.1:4242/?screen=Bad%20Id")!))
    }
}
