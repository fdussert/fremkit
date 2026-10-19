import XCTest
@testable import FremkitKit

/// The Mac's other LAN addresses: what `/api/devices/me` lists, what the app keeps of it, and how
/// it looks for the Mac there when the address in use goes away.
@MainActor
final class AddressesTests: XCTestCase {
    /// The paired Mac with two other addresses it listed earlier (RFC 1918, generic values).
    private let macWithAddresses = sampleMac.updating(addresses: ["192.168.1.20", "172.16.4.2"])

    private func decode(_ json: String) throws -> DeviceInfo {
        try JSONDecoder().decode(DeviceInfo.self, from: Data(json.utf8))
    }

    // MARK: DeviceInfo

    func testDecodesTheAddresses() throws {
        let info = try decode(#"{"id":"d1","name":"iPad","screenId":"s1","brightness":null,"addresses":["10.20.30.40","192.168.1.20"]}"#)
        XCTAssertEqual(info.addresses, ["10.20.30.40", "192.168.1.20"])
    }

    func testAMacThatSendsNoAddressesGivesNone() throws {
        let info = try decode(#"{"id":"d1","name":"iPad","screenId":"s1","brightness":null}"#)
        XCTAssertEqual(info.addresses, [])
        XCTAssertEqual(try decode(#"{"id":"d1","name":"iPad","screenId":null,"brightness":null,"addresses":"10.20.30.40"}"#).addresses, [])
        XCTAssertEqual(try decode(#"{"id":"d1","name":"iPad","screenId":null,"brightness":null,"addresses":null}"#).addresses, [])
    }

    func testDropsEveryEntryThatIsNotAPrivateIPv4Literal() throws {
        let info = try decode(#"""
        {"id":"d1","name":"iPad","screenId":null,"brightness":null,"addresses":[
          "192.168.1.20", 42, null, "198.51.100.7", "203.0.113.5", "100.100.1.1", "169.254.1.1",
          "127.0.0.1", "fd00::1", "2001:db8::1", "fe80::1%en0", "studio.local", "evil.example.com",
          "172.15.0.1", "172.32.0.1", "10.1.2.3 ", "", "172.31.255.254", "192.168.1.20"
        ]}
        """#)
        XCTAssertEqual(info.addresses, ["192.168.1.20", "172.31.255.254"])
    }

    func testKeepsAtMostEightAddresses() throws {
        let many = (1...20).map { "\"10.9.1.\($0)\"" }.joined(separator: ",")
        let info = try decode(#"{"id":"d1","name":"iPad","screenId":null,"brightness":null,"addresses":["# + many + "]}")
        XCTAssertEqual(info.addresses, (1...8).map { "10.9.1.\($0)" })
    }

    func testIsPrivateIPv4Literal() {
        for a in ["10.20.30.40", "172.16.0.1", "172.31.255.255", "192.168.0.1"] { XCTAssertTrue(isPrivateIPv4Literal(a), a) }
        for a in ["172.15.255.255", "172.32.0.1", "192.169.0.1", "100.64.0.1", "169.254.1.1", "192.0.2.10", "8.8.8.8",
                  "fd00::1", "::ffff:10.20.30.40", "studio.local", ""] {
            XCTAssertFalse(isPrivateIPv4Literal(a), a)
        }
    }

    // MARK: PairedMac

    func testAPairingStoredBeforeAddressesStillLoads() throws {
        let legacy = #"{"host":"studio.local","address":"192.0.2.10","port":4243,"keyHash":"\#(SPKIFixture.keyHash)","token":"device-token","deviceId":"d1","name":"studio"}"#
        let mac = try JSONDecoder().decode(PairedMac.self, from: Data(legacy.utf8))
        XCTAssertEqual(mac, sampleMac)
        XCTAssertEqual(mac.addresses, [])
    }

    func testTheAddressesAreStoredWithThePairing() throws {
        let data = try JSONEncoder().encode(macWithAddresses)
        let back = try JSONDecoder().decode(PairedMac.self, from: data)
        XCTAssertEqual(back.addresses, ["192.168.1.20", "172.16.4.2"])
        XCTAssertEqual(back, macWithAddresses)
    }

    func testUpdatingAddressesCleansDedupesAndCaps() {
        let updated = sampleMac.updating(addresses: ["192.168.1.20", "192.168.1.20", "198.51.100.7", "fd00::1"]
                                         + (1...10).map { "10.9.2.\($0)" })
        XCTAssertEqual(updated.addresses, ["192.168.1.20"] + (1...7).map { "10.9.2.\($0)" })
        XCTAssertEqual(updated.token, sampleMac.token)
        XCTAssertEqual(updated.keyHash, sampleMac.keyHash)
        XCTAssertEqual(updated.address, sampleMac.address)
    }

    // MARK: Connector

    func testCandidatesTryTheStoredAddressesAfterTheNameAndTheLastAddress() {
        XCTAssertEqual(Connector.candidates(mac: macWithAddresses, discovered: ["198.51.100.7", "172.16.4.2"], preferring: "192.0.2.99"),
                       ["192.0.2.99", "studio.local", "192.0.2.10", "192.168.1.20", "172.16.4.2", "198.51.100.7"])
    }

    func testAStoredAddressPresentingAnotherKeyIsNotTheMac() async {
        // Another machine holds a stored address now: it is "not this one", the next one is tried.
        let prober = FakeProber(["192.168.1.20": .pinMismatch, "172.16.4.2": .ok(sampleInfo)])
        let result = await Connector(prober: prober).connect(mac: macWithAddresses, discovered: [])
        XCTAssertEqual(result, .connected(host: "172.16.4.2", info: sampleInfo))

        // Alone, it never connects, and is no proof the key changed: not at launch, nor behind a
        // dashboard. The Mac is simply not found (asleep, say).
        let only = FakeProber(["192.168.1.20": .pinMismatch])
        let connected = await Connector(prober: only).connect(mac: macWithAddresses, discovered: [])
        XCTAssertEqual(connected, .unreachable)
        let relocated = await Connector(prober: only).relocate(mac: macWithAddresses, discovered: [], current: "192.0.2.10")
        XCTAssertEqual(relocated, .unreachable)
    }

    // MARK: Pinning

    func testAProbeToAStoredAddressIsPinnedToThePairedKey() async {
        let policies = Recorder<PinPolicy>()
        let cookies = Recorder<String>()
        let prober = HTTPProber(transport: { request, policy in
            policies.add(policy)
            cookies.add(request.value(forHTTPHeaderField: "Cookie") ?? "")
            return .pinRejected
        })
        let outcome = await prober.probe(host: "192.168.1.20", port: 4243, mac: macWithAddresses)
        XCTAssertEqual(outcome, .pinMismatch)
        let policy = policies.items[0]
        // The pin covers the stored address, and expects the paired key there and nowhere else.
        XCTAssertTrue(policy.hosts.contains("192.168.1.20"))
        XCTAssertEqual(policy.keyHash, SPKIFixture.keyHash)
        XCTAssertEqual(PinnedSession.decide(host: "192.168.1.20", presented: SPKIFixture.keyHash, expected: policy.keyHash, hosts: policy.hosts),
                       .trust)
        XCTAssertEqual(PinnedSession.decide(host: "192.168.1.20", presented: "another-key", expected: policy.keyHash, hosts: policy.hosts),
                       .reject(observed: "another-key"))
        // The token only ever travels in a request handed to the pinned transport.
        XCTAssertEqual(cookies.items, ["fremkit_device=device-token"])
    }

    // MARK: AppModel

    private let infoWithAddresses = DeviceInfo(id: "d1", name: "iPad", screenId: "s1", brightness: DeviceBrightness(target: 40, seq: 3),
                                               addresses: ["192.168.1.20", "172.16.4.2"])

    private func settle(_ model: AppModel) async {
        while model.isConnecting { await Task.yield() }
    }

    func testAConnectionStoresTheAddressesTheMacListed() async throws {
        let store = MemoryCredentialStore(sampleMac)
        let model = AppModel(store: store, connector: Connector(prober: ScriptedProber(["192.0.2.10": .ok(infoWithAddresses)])))
        await model.start()?.value
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: infoWithAddresses))
        XCTAssertEqual(model.mac?.addresses, ["192.168.1.20", "172.16.4.2"])
        XCTAssertEqual(try store.load()?.addresses, ["192.168.1.20", "172.16.4.2"])
    }

    func testACheckStoresTheAddressesTheMacNowLists() async throws {
        let store = MemoryCredentialStore(sampleMac)
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let model = AppModel(store: store, connector: Connector(prober: prober))
        await model.start()?.value
        XCTAssertEqual(try store.load()?.addresses, [])

        prober.set("192.0.2.10", .ok(infoWithAddresses))
        await model.checkAuthorization()?.value
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: infoWithAddresses))
        XCTAssertEqual(try store.load()?.addresses, ["192.168.1.20", "172.16.4.2"])

        // Gone from the Mac's list, gone from the app's.
        let fewer = DeviceInfo(id: "d1", name: "iPad", screenId: "s1", brightness: DeviceBrightness(target: 40, seq: 3), addresses: ["172.16.4.2"])
        prober.set("192.0.2.10", .ok(fewer))
        await model.resume()?.value
        XCTAssertEqual(model.mac?.addresses, ["172.16.4.2"])
        XCTAssertEqual(try store.load()?.addresses, ["172.16.4.2"])
    }

    func testAnUnchangedListWritesNothingToTheKeychain() async throws {
        let store = CountingStore(sampleMac)
        let prober = ScriptedProber(["192.0.2.10": .ok(infoWithAddresses)])
        let model = AppModel(store: store, connector: Connector(prober: prober))
        await model.start()?.value
        XCTAssertEqual(store.saves, 1, "the first answer stores the addresses")
        for _ in 0..<2 {
            await model.checkAuthorization()?.value
            await settle(model)
        }
        await model.resume()?.value
        XCTAssertEqual(store.saves, 1, "the same list again writes nothing")
        XCTAssertEqual(try store.load()?.addresses, ["192.168.1.20", "172.16.4.2"])
    }

    func testTheDashboardMovesToAStoredAddressWhenNothingElseAnswers() async throws {
        // Connected over the Mac's Ethernet address, which also told the app the Mac's Wi-Fi one.
        let store = MemoryCredentialStore(sampleMac)
        let prober = ScriptedProber(["192.0.2.10": .ok(infoWithAddresses)])
        let model = AppModel(store: store, connector: Connector(prober: prober), discovered: { [] })
        await model.start()?.value
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: infoWithAddresses))

        // Ethernet unplugged: the host in use is gone, the `.local` name does not resolve, Bonjour
        // finds nothing, and only the Wi-Fi address answers, with the paired key.
        prober.set("192.0.2.10", .unreachable)
        prober.set("studio.local", .unreachable)
        prober.set("172.16.4.2", .ok(infoWithAddresses))

        await model.checkAuthorization()?.value
        await settle(model)
        await model.checkAuthorization()?.value
        await settle(model)
        XCTAssertEqual(model.state, .dashboard(host: "172.16.4.2", info: infoWithAddresses))
        XCTAssertEqual(Array(prober.hosts.suffix(4)), ["192.0.2.10", "studio.local", "192.168.1.20", "172.16.4.2"])
        XCTAssertEqual(model.mac?.address, "172.16.4.2")
        XCTAssertEqual(try store.load()?.address, "172.16.4.2")
        XCTAssertEqual(try store.load()?.keyHash, SPKIFixture.keyHash, "the pin is the one it always was")
    }

    func testAStoredAddressPresentingAnotherKeyNeverMovesTheDashboardNorForgetsThePin() async throws {
        let store = MemoryCredentialStore(sampleMac)
        let prober = ScriptedProber(["192.0.2.10": .ok(infoWithAddresses)])
        let model = AppModel(store: store, connector: Connector(prober: prober))
        await model.start()?.value

        prober.set("192.0.2.10", .unreachable)
        prober.set("192.168.1.20", .pinMismatch)
        prober.set("172.16.4.2", .pinMismatch)
        for _ in 0..<2 {
            await model.checkAuthorization()?.value
            await settle(model)
        }
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: infoWithAddresses))
        XCTAssertTrue(prober.hosts.contains("192.168.1.20"))
        XCTAssertEqual(try store.load()?.keyHash, SPKIFixture.keyHash)
        XCTAssertEqual(try store.load()?.token, "device-token")
    }
}

/// A store in memory that counts its saves.
final class CountingStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: PairedMac?
    private var count = 0
    init(_ mac: PairedMac?) { stored = mac }
    var saves: Int { lock.withLock { count } }
    func load() throws -> PairedMac? { lock.withLock { stored } }
    func save(_ mac: PairedMac) throws { lock.withLock { stored = mac; count += 1 } }
    func clear() { lock.withLock { stored = nil } }
}
