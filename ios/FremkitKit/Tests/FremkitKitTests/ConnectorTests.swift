import XCTest
@testable import FremkitKit

/// Answers each host from a table and remembers the order it was asked in.
final class FakeProber: Prober, @unchecked Sendable {
    private let lock = NSLock()
    private let outcomes: [String: ProbeOutcome]
    private var asked: [String] = []

    init(_ outcomes: [String: ProbeOutcome]) { self.outcomes = outcomes }

    var hosts: [String] { lock.withLock { asked } }

    func probe(host: String, port: Int, mac: PairedMac) async -> ProbeOutcome {
        lock.withLock { asked.append(host) }
        return outcomes[host] ?? .unreachable
    }
}

let sampleMac = PairedMac(host: "studio.local", address: "192.0.2.10", port: 4243, keyHash: SPKIFixture.keyHash,
                          token: "device-token", deviceId: "d1", name: "studio")
let sampleInfo = DeviceInfo(id: "d1", name: "iPad", screenId: "s1", brightness: DeviceBrightness(target: 40, seq: 3))

final class ConnectorTests: XCTestCase {
    func testFallsBackToTheStoredAddressWhenTheNameFails() async {
        let prober = FakeProber(["studio.local": .unreachable, "192.0.2.10": .ok(sampleInfo)])
        let result = await Connector(prober: prober).connect(mac: sampleMac, discovered: ["198.51.100.7"])
        XCTAssertEqual(result, .connected(host: "192.0.2.10", info: sampleInfo))
        XCTAssertEqual(prober.hosts, ["studio.local", "192.0.2.10"])
    }

    func testTriesDiscoveredAddressesAfterAWrongMacAndAStaleAddress() async {
        let prober = FakeProber(["studio.local": .pinMismatch, "192.0.2.10": .unreachable, "198.51.100.7": .ok(sampleInfo)])
        let result = await Connector(prober: prober).connect(mac: sampleMac, discovered: ["192.0.2.10", "198.51.100.7", "198.51.100.7"])
        XCTAssertEqual(result, .connected(host: "198.51.100.7", info: sampleInfo))
        XCTAssertEqual(prober.hosts, ["studio.local", "192.0.2.10", "198.51.100.7"])
        XCTAssertEqual(sampleMac.updating(address: "198.51.100.7").address, "198.51.100.7")
    }

    func testStopsAtTheFirstUnauthorized() async {
        let prober = FakeProber(["studio.local": .unreachable, "192.0.2.10": .unauthorized, "198.51.100.7": .ok(sampleInfo)])
        let result = await Connector(prober: prober).connect(mac: sampleMac, discovered: ["198.51.100.7"])
        XCTAssertEqual(result, .unauthorized)
        XCTAssertEqual(prober.hosts, ["studio.local", "192.0.2.10"])
    }

    func testIsUnreachableWhenNothingAnswers() async {
        let prober = FakeProber([:])
        let result = await Connector(prober: prober).connect(mac: sampleMac, discovered: ["198.51.100.7", "198.51.100.8"])
        XCTAssertEqual(result, .unreachable)
        XCTAssertEqual(prober.hosts, ["studio.local", "192.0.2.10", "198.51.100.7", "198.51.100.8"])
    }

    func testIsKeyChangedWhenOnlyAWrongKeyAnswered() async {
        // The Mac's own name or its last address presenting another key: the key changed.
        for host in ["studio.local", "192.0.2.10"] {
            let prober = FakeProber([host: .pinMismatch])
            let result = await Connector(prober: prober).connect(mac: sampleMac, discovered: ["198.51.100.7", "198.51.100.8"])
            XCTAssertEqual(result, .keyChanged, host)
            XCTAssertEqual(prober.hosts, ["studio.local", "192.0.2.10", "198.51.100.7", "198.51.100.8"])
        }
        // So does the host a caller prefers.
        let preferred = FakeProber(["198.51.100.9": .pinMismatch])
        let result = await Connector(prober: preferred).connect(mac: sampleMac, discovered: [], preferring: "198.51.100.9")
        XCTAssertEqual(result, .keyChanged)
    }

    func testAWrongKeyOnlyFromBonjourIsNotThisMac() async {
        let prober = FakeProber(["198.51.100.7": .pinMismatch])
        let result = await Connector(prober: prober).connect(mac: sampleMac, discovered: ["198.51.100.7", "198.51.100.8"])
        XCTAssertEqual(result, .unreachable)
        XCTAssertEqual(prober.hosts, ["studio.local", "192.0.2.10", "198.51.100.7", "198.51.100.8"])
    }

    func testCandidatesAreDeduplicatedIgnoringCase() {
        XCTAssertEqual(Connector.candidates(mac: sampleMac, discovered: ["STUDIO.local", "198.51.100.7", "192.0.2.10"]),
                       ["studio.local", "192.0.2.10", "198.51.100.7"])
    }

    func testCandidatesAreLocalNamesAndIPv4Only() {
        XCTAssertEqual(Connector.candidates(mac: sampleMac, discovered: ["fe80::1%en0", "2001:db8::1", "198.51.100.7"],
                                            preferring: "fe80::2%en0"),
                       ["studio.local", "192.0.2.10", "198.51.100.7"])
    }

    func testARelocationIsKeyChangedOnlyWhenTheHostInUsePresentsAnotherKey() async {
        // A stale address another Mac now holds answers with its key: not this one, and not proof
        // that this Mac's key changed while the host in use simply missed a request.
        let stale = FakeProber(["198.51.100.7": .pinMismatch])
        let result = await Connector(prober: stale).relocate(mac: sampleMac, discovered: ["198.51.100.7"], current: "192.0.2.10")
        XCTAssertEqual(result, .unreachable)
        XCTAssertEqual(stale.hosts, ["192.0.2.10", "studio.local", "198.51.100.7"])

        let reset = FakeProber(["192.0.2.10": .pinMismatch, "198.51.100.7": .pinMismatch])
        let changed = await Connector(prober: reset).relocate(mac: sampleMac, discovered: ["198.51.100.7"], current: "192.0.2.10")
        XCTAssertEqual(changed, .keyChanged)

        let moved = FakeProber(["192.0.2.10": .pinMismatch, "198.51.100.7": .ok(sampleInfo)])
        let found = await Connector(prober: moved).relocate(mac: sampleMac, discovered: ["198.51.100.7"], current: "192.0.2.10")
        XCTAssertEqual(found, .connected(host: "198.51.100.7", info: sampleInfo))
    }

    func testAPreferredHostIsTriedFirst() {
        XCTAssertEqual(Connector.candidates(mac: sampleMac, discovered: ["198.51.100.7"], preferring: "198.51.100.7"),
                       ["198.51.100.7", "studio.local", "192.0.2.10"])
        XCTAssertEqual(Connector.candidates(mac: sampleMac, discovered: [], preferring: "192.0.2.10"),
                       ["192.0.2.10", "studio.local"])
    }

    func testUpdatingKeepsTheRecordWhenTheHostIsAName() {
        XCTAssertEqual(sampleMac.updating(address: "studio.local"), sampleMac)
        XCTAssertEqual(sampleMac.updating(address: "2001:db8::2").address, "2001:db8::2")
        XCTAssertEqual(sampleMac.updating(address: "198.51.100.7").token, "device-token")
    }

    func testPrintingNeverShowsTheTokenOrKey() {
        var dumped = ""
        dump(sampleMac, to: &dumped)
        let text = "\(sampleMac) \(String(reflecting: sampleMac)) \(dumped)"
        XCTAssertFalse(text.contains("device-token"))
        XCTAssertFalse(text.contains(SPKIFixture.keyHash))
        XCTAssertTrue(dumped.contains("studio.local"))
    }
}

final class CredentialStoreTests: XCTestCase {
    func testMemoryStoreSavesLoadsAndClears() throws {
        let store = MemoryCredentialStore()
        XCTAssertNil(try store.load())
        try store.save(sampleMac)
        XCTAssertEqual(try store.load(), sampleMac)
        store.clear()
        XCTAssertNil(try store.load())
    }

    func testPairedMacRoundTripsThroughJSON() throws {
        let data = try JSONEncoder().encode(sampleMac)
        XCTAssertEqual(try JSONDecoder().decode(PairedMac.self, from: data), sampleMac)
    }
}
