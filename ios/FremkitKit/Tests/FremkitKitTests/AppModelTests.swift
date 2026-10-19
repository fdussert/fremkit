import XCTest
@testable import FremkitKit

/// Answers each host from a table that a test can change between attempts, and can hold one
/// host's answer until the test lets it go.
final class ScriptedProber: Prober, @unchecked Sendable {
    private let lock = NSLock()
    private var outcomes: [String: ProbeOutcome]
    private var asked: [String] = []
    private var held: String?
    private var waiting: [CheckedContinuation<Void, Never>] = []

    init(_ outcomes: [String: ProbeOutcome]) { self.outcomes = outcomes }

    var hosts: [String] { lock.withLock { asked } }

    func set(_ host: String, _ outcome: ProbeOutcome) { lock.withLock { outcomes[host] = outcome } }

    /// Every probe of `host` waits for `release()`.
    func hold(_ host: String) { lock.withLock { held = host } }

    /// The number of probes waiting.
    var holding: Int { lock.withLock { waiting.count } }

    func release() {
        let continuations = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            held = nil
            defer { waiting = [] }
            return waiting
        }
        continuations.forEach { $0.resume() }
    }

    func probe(host: String, port: Int, mac: PairedMac) async -> ProbeOutcome {
        let mustWait = lock.withLock { () -> Bool in
            asked.append(host)
            return held == host
        }
        if mustWait {
            await withCheckedContinuation { continuation in
                lock.withLock { waiting.append(continuation) }
            }
        }
        return lock.withLock { outcomes[host] ?? .unreachable }
    }
}

/// A keychain that holds `stored` and cannot read or write it until `heal()`.
final class UnreadableStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var cleared = false
    private var broken = true
    private let stored: PairedMac?
    init(_ stored: PairedMac? = nil) { self.stored = stored }
    var wasCleared: Bool { lock.withLock { cleared } }
    func heal() { lock.withLock { broken = false } }
    func load() throws -> PairedMac? {
        try lock.withLock {
            if broken { throw KeychainError(status: -25308) }
            return stored
        }
    }
    func save(_ mac: PairedMac) throws {
        try lock.withLock { if broken { throw KeychainError(status: -25308) } }
    }
    func clear() { lock.withLock { cleared = true } }
}

/// What Bonjour has resolved, changed by a test while the model reads it.
@MainActor
final class Resolved {
    var addresses: [String] = []
}

@MainActor
final class AppModelTests: XCTestCase {
    func testWelcomeWhenNothingIsStored() async {
        let model = AppModel(store: MemoryCredentialStore(), connector: Connector(prober: ScriptedProber([:])))
        XCTAssertNil(model.start())
        XCTAssertEqual(model.state, .welcome)
        XCTAssertFalse(model.credentialsUnreadable)
    }

    func testAnUnreadableKeychainShowsWelcomeAndKeepsThePairing() async {
        let store = UnreadableStore()
        let model = AppModel(store: store, connector: Connector(prober: ScriptedProber([:])))
        model.start()
        XCTAssertEqual(model.state, .welcome)
        XCTAssertTrue(model.credentialsUnreadable)
        XCTAssertFalse(store.wasCleared)
    }

    func testAPairingThatCannotBeSavedIsRefused() async {
        let model = AppModel(store: UnreadableStore(), connector: Connector(prober: ScriptedProber([:])))
        model.start()
        XCTAssertThrowsError(try model.pair(with: sampleMac))
        XCTAssertNil(model.mac)
        XCTAssertEqual(model.state, .welcome)
    }

    func testConnectsAtLaunchAndKeepsTheAddressThatWorked() async {
        let store = MemoryCredentialStore(sampleMac)
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let model = AppModel(store: store, connector: Connector(prober: prober))
        await model.start()?.value
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo))
        XCTAssertEqual(try store.load(), sampleMac)
    }

    func testStoresTheBonjourAddressWhenTheMacMoved() async {
        let store = MemoryCredentialStore(sampleMac)
        let prober = ScriptedProber(["198.51.100.7": .ok(sampleInfo)])
        let model = AppModel(store: store, connector: Connector(prober: prober), discovered: { ["198.51.100.7"] })
        await model.start()?.value
        XCTAssertEqual(model.state, .dashboard(host: "198.51.100.7", info: sampleInfo))
        XCTAssertEqual(try store.load()?.address, "198.51.100.7")
        XCTAssertEqual(model.mac?.address, "198.51.100.7")
    }

    func testUnreachableNamesTheMacAndRecoversWithoutLeavingTheScreen() async {
        let prober = ScriptedProber([:])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        XCTAssertEqual(model.state, .unreachable(name: "studio"))

        prober.set("studio.local", .ok(sampleInfo))
        let retry = model.reconnect()
        XCTAssertEqual(model.state, .unreachable(name: "studio"), "the screen stays up while it retries")
        XCTAssertTrue(model.isConnecting)
        await retry.value
        XCTAssertFalse(model.isConnecting)
        XCTAssertEqual(model.state, .dashboard(host: "studio.local", info: sampleInfo))
    }

    func testKeyChangedKeepsThePairingAndRecoversOnALaterOk() async {
        let store = MemoryCredentialStore(sampleMac)
        let prober = ScriptedProber(["studio.local": .pinMismatch])
        let model = AppModel(store: store, connector: Connector(prober: prober))
        await model.start()?.value
        XCTAssertEqual(model.state, .keyChanged(name: "studio"))
        XCTAssertEqual(try store.load(), sampleMac, "a wrong key never forgets the pairing")

        let retry = model.reconnect()
        XCTAssertEqual(model.state, .keyChanged(name: "studio"), "the screen stays up while it retries")
        await retry.value
        XCTAssertEqual(model.state, .keyChanged(name: "studio"))

        prober.set("studio.local", .ok(sampleInfo))
        await model.reconnect().value
        XCTAssertEqual(model.state, .dashboard(host: "studio.local", info: sampleInfo))
    }

    func testAResumeOnTheDashboardLandsInKeyChanged() async {
        let prober = ScriptedProber(["studio.local": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        prober.set("studio.local", .pinMismatch)
        await model.resume()?.value
        // The check ends in a reconnect, which is its own task.
        await model.reconnect().value
        XCTAssertEqual(model.state, .keyChanged(name: "studio"))
    }

    func testOneAttemptAtATime() async {
        let prober = ScriptedProber([:])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        let asked = prober.hosts.count
        let first = model.reconnect()
        let second = model.reconnect()
        await first.value
        await second.value
        XCTAssertEqual(prober.hosts.count - asked, 2, "studio.local and 192.0.2.10, once")
    }

    func testUnauthorizedThenForgetGoesBackToWelcome() async {
        let store = MemoryCredentialStore(sampleMac)
        let model = AppModel(store: store, connector: Connector(prober: ScriptedProber(["studio.local": .unauthorized])))
        await model.start()?.value
        XCTAssertEqual(model.state, .unauthorized)
        model.forget()
        XCTAssertEqual(model.state, .welcome)
        XCTAssertNil(model.mac)
        XCTAssertNil(try store.load())
    }

    func testThePageSayingUnauthorizedLeavesTheDashboard() async {
        let model = AppModel(store: MemoryCredentialStore(sampleMac),
                             connector: Connector(prober: ScriptedProber(["studio.local": .ok(sampleInfo)])))
        await model.start()?.value
        model.pageSaidUnauthorized()
        XCTAssertEqual(model.state, .unauthorized)
    }

    func testAWebViewFailureReconnects() async {
        let prober = ScriptedProber(["studio.local": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        prober.set("studio.local", .unreachable)
        model.dashboardFailed()
        XCTAssertEqual(model.state, .connecting)
        await model.reconnect().value
        XCTAssertEqual(model.state, .unreachable(name: "studio"))
    }

    func testAWebViewFailureDuringACheckRebuildsTheDashboard() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        prober.hold("192.0.2.10")
        let check = model.resume()
        model.dashboardFailed()
        XCTAssertEqual(model.state, .connecting, "the dead web view goes away instead of joining the check")
        let attempt = model.reconnect()
        while prober.holding < 2 { await Task.yield() }
        prober.release()
        await check?.value
        await attempt.value
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo))
    }

    func testResumeOnTheDashboardChecksTheHostInUse() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        let asked = prober.hosts.count
        let moved = DeviceInfo(id: "d1", name: "iPad", screenId: "s2", brightness: nil)
        prober.set("192.0.2.10", .ok(moved))
        await model.resume()?.value
        XCTAssertEqual(Array(prober.hosts.dropFirst(asked)), ["192.0.2.10"])
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: moved))

        prober.set("192.0.2.10", .unauthorized)
        await model.resume()?.value
        XCTAssertEqual(model.state, .unauthorized)
    }

    func testResumeOnTheDashboardReconnectsWhenTheHostIsGone() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober),
                             discovered: { ["198.51.100.7"] })
        await model.start()?.value
        prober.set("192.0.2.10", .unreachable)
        prober.set("198.51.100.7", .ok(sampleInfo))
        await model.resume()?.value
        XCTAssertEqual(model.state, .connecting)
        await model.reconnect().value
        XCTAssertEqual(model.state, .dashboard(host: "198.51.100.7", info: sampleInfo))
    }

    func testResumeReadsAnUnreadableKeychainAgain() async {
        let store = UnreadableStore(sampleMac)
        let model = AppModel(store: store, connector: Connector(prober: ScriptedProber(["studio.local": .ok(sampleInfo)])))
        model.start()
        XCTAssertEqual(model.state, .welcome)
        store.heal()
        await model.resume()?.value
        XCTAssertFalse(model.credentialsUnreadable)
        XCTAssertEqual(model.state, .dashboard(host: "studio.local", info: sampleInfo))
    }

    func testResumeOnWelcomeDoesNothingWhenNothingIsStored() async {
        let store = MemoryCredentialStore()
        let model = AppModel(store: store, connector: Connector(prober: ScriptedProber([:])))
        model.start()
        try? store.save(sampleMac)
        XCTAssertNil(model.resume(), "a keychain that read fine and was empty is not read again")
        XCTAssertEqual(model.state, .welcome)
    }

    func testAnAttemptForAForgottenPairingIsDropped() async {
        let prober = ScriptedProber(["studio.local": .ok(sampleInfo)])
        prober.hold("studio.local")
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        let attempt = model.start()
        model.forget()
        prober.release()
        await attempt?.value
        XCTAssertEqual(model.state, .welcome)
        XCTAssertNil(model.mac)
    }

    func testTheDashboardCheckShowsUnauthorizedOnly() async {
        let prober = ScriptedProber(["studio.local": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        XCTAssertEqual(model.state, .dashboard(host: "studio.local", info: sampleInfo))

        prober.set("studio.local", .unreachable)
        await model.checkAuthorization()?.value
        XCTAssertEqual(model.state, .dashboard(host: "studio.local", info: sampleInfo), "an unanswered check leaves the page alone")
        XCTAssertEqual(prober.hosts.filter { $0 != "studio.local" }, [], "an unanswered check does not reconnect to other hosts")

        prober.set("studio.local", .unauthorized)
        await model.checkAuthorization()?.value
        XCTAssertEqual(model.state, .unauthorized)
        XCTAssertNil(model.checkAuthorization(), "only on the dashboard")
    }

    /// The dashboard on the Mac's last address (its `.local` name does not resolve here), and
    /// what Bonjour resolves, which a test can change.
    private func dashboardOnAnAddress(_ prober: ScriptedProber, discovered: @escaping @MainActor () -> [String])
        async -> (AppModel, MemoryCredentialStore) {
        let store = MemoryCredentialStore(sampleMac)
        let model = AppModel(store: store, connector: Connector(prober: prober), discovered: discovered)
        await model.start()?.value
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo))
        return (model, store)
    }

    private func settle(_ model: AppModel) async {
        while model.isConnecting { await Task.yield() }
    }

    func testTwoUnansweredChecksFollowTheMacToItsNewAddressWithoutLeavingTheDashboard() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let bonjour = Resolved()
        let (model, store) = await dashboardOnAnAddress(prober, discovered: { bonjour.addresses })
        // The Mac moved: its old address is dead, Bonjour now resolves the new one.
        prober.set("192.0.2.10", .unreachable)
        prober.set("198.51.100.7", .ok(sampleInfo))
        bonjour.addresses = ["198.51.100.7"]

        await model.checkAuthorization()?.value
        await settle(model)
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo), "one unanswered check moves nothing")
        XCTAssertFalse(prober.hosts.contains("198.51.100.7"))

        await model.checkAuthorization()?.value
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo), "the page stays up while the app looks")
        await settle(model)
        XCTAssertEqual(model.state, .dashboard(host: "198.51.100.7", info: sampleInfo))
        XCTAssertEqual(model.mac?.address, "198.51.100.7")
        XCTAssertEqual(try store.load()?.address, "198.51.100.7", "remembered for the next launch")
    }

    func testAMacThatAnswersNowhereLeavesTheDashboardAlone() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let (model, _) = await dashboardOnAnAddress(prober, discovered: { ["198.51.100.7"] })
        // Asleep: nothing answers anywhere. The page waits; no flicker through `.connecting`.
        prober.set("192.0.2.10", .unreachable)
        for _ in 0..<3 {
            await model.checkAuthorization()?.value
            XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo))
            await settle(model)
            XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo))
        }
        XCTAssertTrue(prober.hosts.contains("198.51.100.7"), "it did look elsewhere")
    }

    func testAnAnswerBetweenUnansweredChecksStartsTheCountAgain() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let (model, _) = await dashboardOnAnAddress(prober, discovered: { ["198.51.100.7"] })
        prober.set("192.0.2.10", .unreachable)
        await model.checkAuthorization()?.value
        prober.set("192.0.2.10", .ok(sampleInfo))
        await model.checkAuthorization()?.value
        prober.set("192.0.2.10", .unreachable)
        await model.checkAuthorization()?.value
        await settle(model)
        XCTAssertFalse(prober.hosts.contains("198.51.100.7"), "two transient failures a minute apart are not a move")
    }

    func testARelocationThatMeetsARevocationShowsUnauthorized() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let (model, _) = await dashboardOnAnAddress(prober, discovered: { ["198.51.100.7"] })
        prober.set("192.0.2.10", .unreachable)
        prober.set("198.51.100.7", .unauthorized)
        await model.checkAuthorization()?.value
        await model.checkAuthorization()?.value
        await settle(model)
        XCTAssertEqual(model.state, .unauthorized)
    }

    func testANewAddressMovesTheDashboardOnlyWhenTheHostInUseIsGone() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo), "198.51.100.7": .ok(sampleInfo)])
        let (model, _) = await dashboardOnAnAddress(prober, discovered: { ["198.51.100.7"] })
        let before = prober.hosts.count

        // The page's host still answers: it stays, and nothing else is asked.
        await model.addressesChanged()?.value
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo))
        XCTAssertEqual(Array(prober.hosts.dropFirst(before)), ["192.0.2.10"])

        // The Mac left that address: the new one takes over at once, no periodic check needed.
        prober.set("192.0.2.10", .unreachable)
        await model.addressesChanged()?.value
        XCTAssertEqual(model.state, .dashboard(host: "198.51.100.7", info: sampleInfo))
    }

    func testANewAddressDoesNothingAwayFromTheDashboard() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let (model, _) = await dashboardOnAnAddress(prober, discovered: { [] })
        model.pageSaidUnauthorized()
        XCTAssertNil(model.addressesChanged())
    }

    func testAnAddressAnnouncedDuringACheckIsActedOnWhenTheCheckEnds() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo), "198.51.100.7": .ok(sampleInfo)])
        let bonjour = Resolved()
        let (model, _) = await dashboardOnAnAddress(prober, discovered: { bonjour.addresses })
        prober.hold("192.0.2.10")
        let check = model.checkAuthorization()
        while prober.holding == 0 { await Task.yield() }
        // The Mac moves while the check waits on its old address.
        bonjour.addresses = ["198.51.100.7"]
        XCTAssertNil(model.addressesChanged(), "never two at once: remembered instead")
        prober.set("192.0.2.10", .unreachable)
        prober.release()
        await check?.value
        await settle(model)
        XCTAssertEqual(model.state, .dashboard(host: "198.51.100.7", info: sampleInfo),
                       "followed after a single unanswered check, because an address was announced")
    }

    func testAStaleAddressWithAnotherKeyNeverReplacesTheDashboard() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let (model, _) = await dashboardOnAnAddress(prober, discovered: { ["198.51.100.7"] })
        // The host in use misses a request; another Fremkit Mac holds an address this one once had.
        prober.set("192.0.2.10", .unreachable)
        prober.set("198.51.100.7", .pinMismatch)
        await model.addressesChanged()?.value
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo))
        await model.checkAuthorization()?.value
        await model.checkAuthorization()?.value
        await settle(model)
        XCTAssertEqual(model.state, .dashboard(host: "192.0.2.10", info: sampleInfo), "nor does the periodic path")

        // The host in use itself presents another key: that is a changed key.
        prober.set("192.0.2.10", .pinMismatch)
        await model.addressesChanged()?.value
        XCTAssertEqual(model.state, .keyChanged(name: "studio"))
    }

    func testAReconnectDoesNotJoinARelocation() async {
        let prober = ScriptedProber(["192.0.2.10": .ok(sampleInfo)])
        let (model, _) = await dashboardOnAnAddress(prober, discovered: { [] })
        prober.hold("192.0.2.10")
        let relocation = model.addressesChanged()
        while prober.holding == 0 { await Task.yield() }
        prober.set("192.0.2.10", .unreachable)
        let attempt = model.reconnect()
        prober.release()
        await relocation?.value
        await attempt.value
        XCTAssertEqual(model.state, .unreachable(name: "studio"), "a joined relocation would have left the dashboard up")
    }

    func testAPeriodicCheckThatMeetsAWrongKeyReconnectsAndLandsInKeyChanged() async {
        let prober = ScriptedProber(["studio.local": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        prober.set("studio.local", .pinMismatch)
        await model.checkAuthorization()?.value
        // A reset certificate must not leave a dead dashboard up: the check reconnects.
        XCTAssertEqual(model.state, .connecting)
        await model.reconnect().value
        XCTAssertEqual(model.state, .keyChanged(name: "studio"))
    }

    func testTheDashboardCheckNeverOverlaps() async {
        let prober = ScriptedProber(["studio.local": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        prober.hold("studio.local")
        let first = model.checkAuthorization()
        XCTAssertNotNil(first)
        XCTAssertNil(model.checkAuthorization())
        while prober.holding == 0 { await Task.yield() }
        prober.release()
        await first?.value
        XCTAssertNotNil(model.checkAuthorization())
    }

    func testAReconnectDoesNotJoinAPeriodicCheck() async {
        let prober = ScriptedProber(["studio.local": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        prober.hold("studio.local")
        let periodic = model.checkAuthorization()
        while prober.holding == 0 { await Task.yield() }
        prober.set("studio.local", .unreachable)
        let attempt = model.reconnect()
        prober.release()
        await periodic?.value
        await attempt.value
        XCTAssertEqual(model.state, .unreachable(name: "studio"), "a joined periodic check would have ignored it")
    }

    func testAResumeDoesNotJoinAPeriodicCheck() async {
        let prober = ScriptedProber(["studio.local": .ok(sampleInfo)])
        let model = AppModel(store: MemoryCredentialStore(sampleMac), connector: Connector(prober: prober))
        await model.start()?.value
        prober.hold("studio.local")
        let periodic = model.checkAuthorization()
        while prober.holding == 0 { await Task.yield() }
        prober.set("studio.local", .unreachable)
        let resumed = model.resume()
        prober.release()
        await periodic?.value
        await resumed?.value
        // The resume's own check found nothing at the host in use and reconnected.
        while model.isConnecting { await model.reconnect().value }
        XCTAssertEqual(model.state, .unreachable(name: "studio"))
    }

    func testPairingReplacesThePairingAndConnects() async {
        let other = PairedMac(host: "other.local", address: "198.51.100.20", port: 4243, keyHash: SPKIFixture.keyHash,
                              token: "other-token", deviceId: "d2", name: "other")
        let store = MemoryCredentialStore(sampleMac)
        let prober = ScriptedProber(["other.local": .ok(sampleInfo)])
        let model = AppModel(store: store, connector: Connector(prober: prober))
        await model.start()?.value
        await (try? model.pair(with: other))?.value
        XCTAssertEqual(try store.load(), other)
        XCTAssertEqual(model.state, .dashboard(host: "other.local", info: sampleInfo))
    }
}

final class PageMessageTests: XCTestCase {
    func testReadsWhatThePagePosts() {
        XCTAssertEqual(PageMessage(body: ["type": "unauthorized"]), .unauthorized)
        XCTAssertEqual(PageMessage(body: ["type": "screen", "screenId": "s1"]), .screen("s1"))
        XCTAssertEqual(PageMessage(body: ["type": "screen", "screenId": NSNull()]), .screen(nil))
        XCTAssertEqual(PageMessage(body: ["type": "brightness", "target": NSNumber(value: 42.5), "seq": NSNumber(value: 3)]),
                       .brightness(target: 42.5, seq: 3))
    }

    func testIgnoresAnythingElse() {
        XCTAssertNil(PageMessage(body: "unauthorized"))
        XCTAssertNil(PageMessage(body: ["type": "reload"]))
        XCTAssertNil(PageMessage(body: ["type": "screen"]))
        XCTAssertNil(PageMessage(body: ["type": "screen", "screenId": NSNumber(value: 1)]))
        XCTAssertNil(PageMessage(body: ["type": "brightness", "target": NSNumber(value: 140), "seq": NSNumber(value: 1)]))
        XCTAssertNil(PageMessage(body: ["type": "brightness", "target": NSNumber(value: 40), "seq": NSNumber(value: 1.5)]))
        XCTAssertNil(PageMessage(body: ["type": "brightness", "target": "40", "seq": NSNumber(value: 1)]))
    }

    func testTheDashboardURLAndTheMacName() {
        XCTAssertEqual(Dashboard.url(host: "192.0.2.10", port: 4243)?.absoluteString, "https://192.0.2.10:4243/")
        XCTAssertEqual(Dashboard.url(host: "fe80::1%en0", port: 4243)?.absoluteString, "https://[fe80::1%25en0]:4243/")
        XCTAssertEqual(Dashboard.cookieName, "fremkit_device")
        let link = PairingLink(host: "studio.local", address: "192.0.2.10", port: 4243, code: "ABCDEFGH", keyHash: SPKIFixture.keyHash)
        XCTAssertEqual(link.macName, "studio")
    }

    func testThePinCoversTheHostInUseTheNameAndTheAddressOnly() {
        let mac = PairedMac(host: "Studio.local.", address: "192.0.2.10", port: 4243, keyHash: SPKIFixture.keyHash,
                            token: "t", deviceId: "d1", name: "studio")
        XCTAssertEqual(Dashboard.pinnedHosts(mac: mac, host: "[FE80::1%25en0]"), ["fe80::1%en0", "studio.local", "192.0.2.10"])
        XCTAssertEqual(Dashboard.pinnedHosts(mac: mac, host: "192.0.2.10"), ["studio.local", "192.0.2.10"])
    }
}
