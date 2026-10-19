import CoreGraphics
import XCTest
@testable import FremkitKit

/// Records each pairing request and answers from a script.
final class ScriptedPairer: @unchecked Sendable {
    private let lock = NSLock()
    private var answer: Result<PairedMac, PairError>
    private var sent: [PairAttempt] = []

    init(_ answer: Result<PairedMac, PairError>) { self.answer = answer }

    var attempts: [PairAttempt] { lock.withLock { sent } }
    func set(_ answer: Result<PairedMac, PairError>) { lock.withLock { self.answer = answer } }

    func pair(_ attempt: PairAttempt) throws -> PairedMac {
        try lock.withLock {
            sent.append(attempt)
            return try answer.get()
        }
    }
}

private let linkURL = URL(string: "fremkit://pair?h=studio.local&a=192.0.2.10&p=4243&c=abcd-efgh&k=\(SPKIFixture.keyHash)")!
private let otherKey = "Y4nRTFWKfvKwllWID7DQPMgZIF8SqUUvgWkQZsK_ArQ"
private let linkSecret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
private let secretLinkURL = URL(string: "fremkit://pair?h=studio.local&a=192.0.2.10&p=4243&c=abcd-efgh&s=\(linkSecret)&k=\(SPKIFixture.keyHash)")!
private let paired = PairedMac(host: "studio.local", address: "192.0.2.10", port: 4243, keyHash: SPKIFixture.keyHash,
                               token: "t", deviceId: "d1", name: "studio")

@MainActor
final class PairingFlowTests: XCTestCase {
    private func makeFlow(store: MemoryCredentialStore = MemoryCredentialStore(),
                          prober: ScriptedProber = ScriptedProber([:]),
                          pairer: ScriptedPairer = ScriptedPairer(.success(paired)),
                          key: String? = otherKey) -> (PairingFlow, AppModel) {
        let model = AppModel(store: store, connector: Connector(prober: prober))
        model.start()
        let flow = PairingFlow(model: model, deviceName: { "Studio iPad" },
                               viewport: { Viewport(points: CGSize(width: 1408, height: 950)) },
                               pair: { try pairer.pair($0) },
                               readKey: { _, _ in key })
        return (flow, model)
    }

    // MARK: Viewport

    func testTheViewportIsTheMeasuredRegionRounded() {
        XCTAssertEqual(Viewport(points: CGSize(width: 1408, height: 950)), Viewport(width: 1408, height: 950))
        XCTAssertEqual(Viewport(points: CGSize(width: 1407.5, height: 949.4)), Viewport(width: 1408, height: 949))
        XCTAssertEqual(Viewport(points: CGSize(width: 950, height: 1408)), Viewport(width: 950, height: 1408), "portrait stays portrait")
        XCTAssertEqual(Viewport(points: .zero), Viewport(width: 1, height: 1))
        XCTAssertEqual(Viewport(points: CGSize(width: CGFloat.infinity, height: .nan)), Viewport(width: 1, height: 1))
        XCTAssertEqual(Viewport(points: CGSize(width: 20000, height: 720)), Viewport(width: 10000, height: 720))
    }

    // MARK: Links

    func testALinkWhileNotPairedPairsRightAway() async throws {
        let pairer = ScriptedPairer(.success(paired))
        let (flow, model) = makeFlow(pairer: pairer)
        XCTAssertTrue(flow.handle(url: linkURL))
        XCTAssertNil(flow.pendingLink)
        XCTAssertTrue(flow.isWorking)
        await flow.inFlight?.value
        let attempt = try XCTUnwrap(pairer.attempts.first)
        XCTAssertEqual(attempt.hosts, ["studio.local", "192.0.2.10"], "the name first, then the address")
        XCTAssertEqual(attempt.keyHash, SPKIFixture.keyHash)
        XCTAssertEqual(attempt.code, "ABCDEFGH")
        XCTAssertNil(attempt.secret, "a link without a secret pairs with the code")
        XCTAssertEqual(attempt.name, "Studio iPad")
        XCTAssertEqual(attempt.viewport, Viewport(width: 1408, height: 950))
        XCTAssertEqual(attempt.macName, "studio")
        XCTAssertEqual(flow.step, .idle)
        XCTAssertEqual(model.mac, paired)
    }

    func testALinkWithASecretSendsIt() async throws {
        let pairer = ScriptedPairer(.success(paired))
        let (flow, _) = makeFlow(pairer: pairer)
        XCTAssertTrue(flow.handle(url: secretLinkURL))
        await flow.inFlight?.value
        let attempt = try XCTUnwrap(pairer.attempts.first)
        XCTAssertEqual(attempt.secret, linkSecret)
        XCTAssertEqual(attempt.keyHash, SPKIFixture.keyHash, "the pin is checked as before")
    }

    func testALinkWhilePairedAsksFirst() async {
        let pairer = ScriptedPairer(.success(paired))
        let (flow, model) = makeFlow(store: MemoryCredentialStore(sampleMac),
                                     prober: ScriptedProber(["studio.local": .ok(sampleInfo)]), pairer: pairer)
        await model.reconnect().value
        XCTAssertTrue(flow.handle(url: linkURL))
        XCTAssertNotNil(flow.pendingLink)
        XCTAssertEqual(flow.step, .idle, "nothing happens before the user agrees")
        XCTAssertTrue(pairer.attempts.isEmpty)

        flow.declineReplace()
        XCTAssertNil(flow.pendingLink)
        XCTAssertEqual(model.mac, sampleMac)

        flow.handle(url: linkURL)
        flow.confirmReplace()
        XCTAssertNil(flow.pendingLink)
        await flow.inFlight?.value
        XCTAssertEqual(pairer.attempts.count, 1)
        XCTAssertEqual(model.mac, paired)
    }

    func testALinkAfterTheMacRemovedThisIPadDoesNotAsk() async {
        let (flow, model) = makeFlow(store: MemoryCredentialStore(sampleMac),
                                     prober: ScriptedProber(["studio.local": .unauthorized]))
        await model.reconnect().value
        XCTAssertEqual(model.state, .unauthorized)
        flow.handle(url: linkURL)
        XCTAssertNil(flow.pendingLink)
        XCTAssertEqual(flow.step, .link(PairingLink(url: linkURL)!))
    }

    func testAnInvalidLinkIsIgnored() {
        let (flow, _) = makeFlow()
        XCTAssertFalse(flow.handle(url: URL(string: "fremkit://pair?h=studio.local&a=192.0.2.10&p=4243&c=ABCDEFGH")!))
        XCTAssertEqual(flow.step, .idle)
    }

    func testTheFirstValidScanStopsTheScan() async {
        let pairer = ScriptedPairer(.success(paired))
        let (flow, _) = makeFlow(pairer: pairer)
        XCTAssertFalse(flow.scanned(linkURL.absoluteString), "not scanning")
        flow.scan()
        XCTAssertFalse(flow.scanned("https://example.com/"))
        XCTAssertFalse(flow.scanned("fremkit://pair?h=studio.local"))
        XCTAssertEqual(flow.step, .scanning)
        XCTAssertTrue(flow.scanned(linkURL.absoluteString))
        XCTAssertEqual(flow.step, .link(PairingLink(url: linkURL)!))
        XCTAssertFalse(flow.scanned(linkURL.absoluteString), "a second read of the same code does nothing")
        await flow.inFlight?.value
        XCTAssertEqual(pairer.attempts.count, 1)
    }

    func testErrorsStayOnTheLinkScreen() async {
        let cases: [(PairError, PairingProblem)] = [
            (.rejected("Code expiré"), .refused("Code expiré")),
            (.limited("Trop d’essais"), .refused("Trop d’essais")),
            (.unreachable, .unreachable),
            (.wrongMac, .wrongMac),
            (.invalidRequest, .invalidRequest),
            (.noCode, .noCode),
        ]
        for (error, problem) in cases {
            let (flow, model) = makeFlow(pairer: ScriptedPairer(.failure(error)))
            flow.handle(url: linkURL)
            await flow.inFlight?.value
            XCTAssertEqual(flow.problem, problem)
            XCTAssertEqual(flow.step, .link(PairingLink(url: linkURL)!))
            XCTAssertFalse(flow.isWorking)
            XCTAssertNil(model.mac)
        }
    }

    func testRetryClearsTheProblemAndPairs() async {
        let pairer = ScriptedPairer(.failure(.unreachable))
        let (flow, model) = makeFlow(pairer: pairer)
        flow.handle(url: linkURL)
        await flow.inFlight?.value
        XCTAssertEqual(flow.problem, .unreachable)
        pairer.set(.success(paired))
        let task = flow.retry()
        XCTAssertNil(flow.problem)
        await task?.value
        XCTAssertEqual(model.mac, paired)
        XCTAssertEqual(flow.step, .idle)
    }

    func testAPairingTheKeychainRefusesIsAProblem() async {
        let model = AppModel(store: UnreadableStore(), connector: Connector(prober: ScriptedProber([:])))
        model.start()
        let flow = PairingFlow(model: model, deviceName: { "iPad" }, viewport: { Viewport(width: 1, height: 1) },
                               pair: { _ in paired }, readKey: { _, _ in nil })
        flow.handle(url: linkURL)
        await flow.inFlight?.value
        XCTAssertEqual(flow.problem, .notSaved)
        XCTAssertNil(model.mac)
    }

    func testCancelDropsALateAnswer() async {
        let (flow, model) = makeFlow()
        flow.handle(url: linkURL)
        let task = flow.inFlight
        flow.cancel()
        await task?.value
        XCTAssertEqual(flow.step, .idle)
        XCTAssertNil(model.mac, "the answer came for a step the user left")
    }

    // MARK: Manual path

    private let service = MacService(name: "Studio", address: "192.0.2.10", port: 4243)

    func testManualPathShowsTheWordsThenPairsWithTheObservedKey() async throws {
        let pairer = ScriptedPairer(.success(paired))
        let (flow, model) = makeFlow(pairer: pairer)
        flow.enterCode()
        XCTAssertEqual(flow.step, .manualList)
        await flow.choose(service).value
        XCTAssertEqual(flow.step, .manualCode(service, keyHash: otherKey))
        XCTAssertEqual(flow.words, Fingerprint.words(keyHash: otherKey))
        XCTAssertEqual(flow.words.count, 4)

        XCTAssertNil(flow.submit(code: "ABC"), "not 8 characters")
        XCTAssertNil(flow.submit(code: "ABCDEFG0"), "0 is not in the alphabet")
        await flow.submit(code: "abcd efgh")?.value
        let attempt = try XCTUnwrap(pairer.attempts.first)
        XCTAssertEqual(attempt.hosts, ["192.0.2.10"], "the resolved address: the .local name may not resolve")
        XCTAssertEqual(attempt.keyHash, otherKey, "the key the user compared is the pin")
        XCTAssertEqual(attempt.code, "ABCDEFGH")
        XCTAssertNil(attempt.secret, "the manual path has only the code")
        XCTAssertEqual(attempt.macName, "Studio", "the service name is the Mac's name")
        XCTAssertEqual(model.mac, paired)
        XCTAssertEqual(flow.step, .idle)
    }

    func testManualPathBackToTheListWhenTheMacDoesNotAnswer() async {
        let (flow, _) = makeFlow(key: nil)
        flow.enterCode()
        await flow.choose(service).value
        XCTAssertEqual(flow.step, .manualList)
        XCTAssertEqual(flow.problem, .unreachable)
    }

    func testManualPathRefusedCodeStaysOnTheWords() async {
        let (flow, _) = makeFlow(pairer: ScriptedPairer(.failure(.rejected("Code incorrect"))))
        flow.enterCode()
        await flow.choose(service).value
        await flow.submit(code: "ABCDEFGH")?.value
        XCTAssertEqual(flow.step, .manualCode(service, keyHash: otherKey))
        XCTAssertEqual(flow.problem, .refused("Code incorrect"))
    }

    func testAnAttemptNeverPrintsTheCodeOrThePin() {
        let attempt = PairAttempt(hosts: ["192.0.2.10"], port: 4243, keyHash: otherKey, code: "ABCDEFGH",
                                  secret: linkSecret, name: "iPad", viewport: Viewport(width: 1, height: 1), macName: "Studio")
        for text in [String(describing: attempt), String(reflecting: attempt), "\(attempt)"] {
            XCTAssertFalse(text.contains("ABCDEFGH"))
            XCTAssertFalse(text.contains(otherKey))
            XCTAssertFalse(text.contains(linkSecret))
        }
        var dumped = ""
        dump(attempt, to: &dumped)
        XCTAssertFalse(dumped.contains("ABCDEFGH"))
        XCTAssertFalse(dumped.contains(otherKey))
        XCTAssertFalse(dumped.contains(linkSecret))
    }

    func testAScanThatMustBeConfirmedStopsTheCamera() async {
        let pairer = ScriptedPairer(.success(paired))
        let (flow, model) = makeFlow(store: MemoryCredentialStore(sampleMac),
                                     prober: ScriptedProber(["studio.local": .ok(sampleInfo)]), pairer: pairer)
        await model.reconnect().value
        flow.scan()
        XCTAssertTrue(flow.scanned(linkURL.absoluteString))
        XCTAssertNotNil(flow.pendingLink)
        XCTAssertEqual(flow.step, .idle, "the camera is off while the question is up")
        flow.declineReplace()
        XCTAssertFalse(flow.scanned(linkURL.absoluteString), "the same code in view does not ask again")
        XCTAssertNil(flow.pendingLink)
        XCTAssertTrue(pairer.attempts.isEmpty)
    }

    func testCancellingWhileTheKeyIsReadDropsTheLateAnswer() async {
        let model = AppModel(store: MemoryCredentialStore(), connector: Connector(prober: ScriptedProber([:])))
        model.start()
        let flow = PairingFlow(model: model, deviceName: { "iPad" }, viewport: { Viewport(width: 1, height: 1) },
                               pair: { _ in paired },
                               readKey: { _, _ in
                                   try? await Task.sleep(for: .milliseconds(50))
                                   return otherKey
                               })
        flow.enterCode()
        let reading = flow.choose(service)
        flow.cancel()
        await reading.value
        XCTAssertEqual(flow.step, .idle)
        XCTAssertFalse(flow.isWorking)

        flow.enterCode()
        let again = flow.choose(service)
        flow.enterCode()
        await again.value
        XCTAssertEqual(flow.step, .manualList, "back to the list: the key read for the left step is dropped")
    }

    func testPairingWaitsForTheViewport() async throws {
        let pairer = ScriptedPairer(.success(paired))
        let model = AppModel(store: MemoryCredentialStore(), connector: Connector(prober: ScriptedProber([:])))
        model.start()
        let meter = ViewportMeter(settle: .zero, cap: .zero)
        let flow = PairingFlow(model: model, deviceName: { "iPad" }, viewport: { await meter.viewport() },
                               pair: { try pairer.pair($0) }, readKey: { _, _ in nil })
        flow.handle(url: linkURL)
        let task = flow.inFlight
        for _ in 0..<5 { await Task.yield() }
        XCTAssertTrue(pairer.attempts.isEmpty, "nothing is sent before the screen is measured")
        meter.measured(CGSize(width: 1408, height: 950))
        await task?.value
        XCTAssertEqual(pairer.attempts.first?.viewport, Viewport(width: 1408, height: 950))
    }
}

@MainActor
final class ViewportMeterTests: XCTestCase {
    func testWaitsForTheFirstMeasure() async {
        let meter = ViewportMeter(settle: .zero, cap: .zero)
        let waiting = Task { await meter.viewport() }
        for _ in 0..<5 { await Task.yield() }
        meter.measured(CGSize(width: 1408, height: 950))
        let reported = await waiting.value
        XCTAssertEqual(reported, Viewport(width: 1408, height: 950))
    }

    func testReportsTheMeasureOnceItHoldsStill() async {
        let meter = ViewportMeter(settle: .milliseconds(100), cap: .seconds(5))
        meter.measured(CGSize(width: 950, height: 1408))
        let waiting = Task { await meter.viewport() }
        try? await Task.sleep(for: .milliseconds(30))
        meter.measured(CGSize(width: 1408, height: 950))
        let reported = await waiting.value
        XCTAssertEqual(reported, Viewport(width: 1408, height: 950), "the size after the rotation, not before")
    }

    func testACancelledWaitEnds() async {
        let meter = ViewportMeter(settle: .zero, cap: .zero)
        let waiting = Task { await meter.viewport() }
        for _ in 0..<5 { await Task.yield() }
        waiting.cancel()
        _ = await waiting.value
        // A later measure finds no one left waiting.
        meter.measured(CGSize(width: 1408, height: 950))
    }

    func testGivesUpWaitingAfterTheCapWithTheLatestMeasure() async {
        let meter = ViewportMeter(settle: .seconds(60), cap: .milliseconds(50))
        meter.measured(CGSize(width: 1408, height: 950))
        let reported = await meter.viewport()
        XCTAssertEqual(reported, Viewport(width: 1408, height: 950))
    }
}
