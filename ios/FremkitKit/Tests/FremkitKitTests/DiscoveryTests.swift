import XCTest
@testable import FremkitKit

final class DiscoveryTests: XCTestCase {
    func testReadsTheAddressAndPortOfTheTXTRecord() {
        XCTAssertEqual(FremkitTXT(["a": "192.0.2.10", "p": "4243"]), FremkitTXT(["a": "192.0.2.10"]))
        XCTAssertEqual(FremkitTXT(["a": "192.0.2.10", "p": "4302"])?.port, 4302)
        XCTAssertEqual(FremkitTXT(["a": "192.0.2.10"])?.port, 4243)
    }

    func testRefusesARecordWithoutAUsableAddress() {
        XCTAssertNil(FremkitTXT([:]))
        XCTAssertNil(FremkitTXT(["a": "studio.local"]), "a name is what could not be resolved in the first place")
        XCTAssertNil(FremkitTXT(["a": ""]))
        // The Mac answers on its IPv4 addresses and its `.local` name only: an IPv6 one gets 421.
        XCTAssertNil(FremkitTXT(["a": "fe80::1%en0"]))
        XCTAssertNil(FremkitTXT(["a": "2001:db8::1"]))
        XCTAssertNil(FremkitTXT(["a": "192.0.2.10", "p": "0"]))
        XCTAssertNil(FremkitTXT(["a": "192.0.2.10", "p": "x"]))
    }

    func testTheAdvertisedAddressComesFirstOnceItAnswers() {
        var mac = DiscoveredMac(name: "Studio")
        XCTAssertNil(mac.service, "pending: nothing known yet")
        mac.advertised = FremkitTXT(["a": "192.0.2.10", "p": "4243"])
        XCTAssertNil(mac.service, "advertised but not checked")
        mac.resolved = MacService(name: "Studio", address: "198.51.100.7", port: 4243)
        XCTAssertEqual(mac.service?.address, "198.51.100.7")
        mac.advertisedAnswers = true
        XCTAssertEqual(mac.candidates.map(\.address), ["192.0.2.10", "198.51.100.7"])
        XCTAssertEqual(mac.service, MacService(name: "Studio", address: "192.0.2.10", port: 4243))
        mac.resolved = MacService(name: "Studio", address: "192.0.2.10", port: 4243)
        XCTAssertEqual(mac.candidates.count, 1, "the same address once")
    }

    func testAnIPv6ResolvedEndpointIsNeverACandidate() {
        var mac = DiscoveredMac(name: "Studio")
        mac.resolved = MacService(name: "Studio", address: "fe80::1%en0", port: 4243)
        XCTAssertEqual(mac.candidates, [], "the Mac would refuse it as a Host")
        XCTAssertNil(mac.service, "so manual pairing never sends the code there")
        mac.resolved = MacService(name: "Studio", address: "2001:db8::7", port: 4243)
        XCTAssertEqual(mac.candidates, [])
        mac.resolved = MacService(name: "Studio", address: "Studio.local", port: 4243)
        XCTAssertEqual(mac.candidates.map(\.address), ["Studio.local"])
    }

    func testConnectableHostsAreLocalNamesAndIPv4Only() {
        for host in ["studio.local", "Studio.local.", "192.0.2.10"] { XCTAssertTrue(isConnectableHost(host), host) }
        for host in ["fe80::1%en0", "2001:db8::1", "[2001:db8::1]", "studio.example.com", "studio", ""] {
            XCTAssertFalse(isConnectableHost(host), host)
        }
    }

    func testConnectorCandidatesFromEveryMacOnce() {
        var a = DiscoveredMac(name: "B")
        a.advertised = FremkitTXT(["a": "192.0.2.10"])
        a.advertisedAnswers = true
        a.resolved = MacService(name: "B", address: "192.0.2.11", port: 4243)
        var b = DiscoveredMac(name: "A")
        b.resolved = MacService(name: "A", address: "192.0.2.10", port: 4243)
        let pending = DiscoveredMac(name: "C")
        XCTAssertEqual([a, b, pending].addresses, ["192.0.2.10", "192.0.2.11"])
    }
}
