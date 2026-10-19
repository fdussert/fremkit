import XCTest
@testable import FremkitKit

final class BrightnessStateTests: XCTestCase {
    func testAppliesANewSeqOnce() {
        var state = BrightnessState()
        XCTAssertTrue(state.apply(target: 40, seq: 3))
        XCTAssertFalse(state.apply(target: 40, seq: 3))
        XCTAssertFalse(state.apply(target: 80, seq: 3))
        XCTAssertEqual(state.lastApplied, 3)
    }

    func testAcceptsALowerSeqBecauseTheServerRestarted() {
        var state = BrightnessState()
        XCTAssertTrue(state.apply(target: 40, seq: 9))
        XCTAssertTrue(state.apply(target: 60, seq: 0))
        XCTAssertEqual(state.lastApplied, 0)
    }

    func testRefusesATargetThatIsNotANumber() {
        var state = BrightnessState()
        XCTAssertFalse(state.apply(target: .nan, seq: 1))
        XCTAssertNil(state.lastApplied)
    }

    func testLevelRoundsAndClamps() {
        XCTAssertEqual(BrightnessState.level(forTarget: 40), 0.4, accuracy: 1e-9)
        XCTAssertEqual(BrightnessState.level(forTarget: 140), 1)
        XCTAssertEqual(BrightnessState.level(forTarget: -5), 0)
        XCTAssertEqual(BrightnessState.level(forTarget: .infinity), 0)
    }
}

final class BrightnessSendTests: XCTestCase {
    private let reporter = BrightnessReporter(mac: sampleMac, host: "192.0.2.10")

    private func outcome(_ exchange: Exchange) async -> ReportOutcome {
        await reporter.send(brightness: 0.5, applied: nil) { _, _ in exchange }
    }

    func testMapsTheAnswer() async {
        let sent = await outcome(.response(status: 204, body: Data()))
        let unauthorized = await outcome(.response(status: 401, body: Data()))
        let noScreen = await outcome(.response(status: 409, body: Data()))
        let rejected = await outcome(.pinRejected)
        let down = await outcome(.failed)
        XCTAssertEqual(sent, .sent)
        XCTAssertEqual(unauthorized, .unauthorized)
        XCTAssertEqual(noScreen, .failed)
        XCTAssertEqual(rejected, .failed)
        XCTAssertEqual(down, .failed)
    }

    func testSendsUnderThePinOfTheMac() async {
        let seen = Seen()
        _ = await reporter.send(brightness: 0.5, applied: 2) { request, policy in
            seen.set(request, policy)
            return .response(status: 204, body: Data())
        }
        XCTAssertEqual(seen.policy?.keyHash, sampleMac.keyHash)
        XCTAssertEqual(seen.request?.httpMethod, "POST")
    }

    private final class Seen: @unchecked Sendable {
        var request: URLRequest?
        var policy: PinPolicy?
        func set(_ r: URLRequest, _ p: PinPolicy) { request = r; policy = p }
    }
}

/// A clock the test drives: `sleep` suspends until `fire()`, or until the sleeper is cancelled.
final class Sleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]
    var pending: Int { lock.withLock { waiters.count } }
    private(set) var durations: [Duration] = []

    func sleep(_ duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                lock.lock()
                durations.append(duration)
                if Task.isCancelled {
                    lock.unlock()
                    c.resume(throwing: CancellationError())
                } else {
                    waiters[id] = c
                    lock.unlock()
                }
            }
        } onCancel: {
            lock.lock()
            let c = waiters.removeValue(forKey: id)
            lock.unlock()
            c?.resume(throwing: CancellationError())
        }
    }

    func fire() {
        lock.lock()
        let all = waiters
        waiters = [:]
        lock.unlock()
        for c in all.values { c.resume() }
    }
}

@MainActor
final class BrightnessSyncTests: XCTestCase {
    private final class Fake: @unchecked Sendable {
        @MainActor var screen = 0.5
        let lock = NSLock()
        private var _reports: [(Double, Int?)] = []
        private var _answer: ReportOutcome = .sent
        var reports: [(Double, Int?)] { lock.withLock { _reports } }
        var answer: ReportOutcome {
            get { lock.withLock { _answer } }
            set { lock.withLock { _answer = newValue } }
        }
        func record(_ level: Double, _ applied: Int?) -> ReportOutcome {
            lock.withLock { _reports.append((level, applied)); return _answer }
        }
    }

    private let sleeper = Sleeper()

    private func make(_ fake: Fake, unauthorized: @escaping @MainActor () -> Void = {}) -> BrightnessSync {
        BrightnessSync(read: { fake.screen }, write: { fake.screen = $0 },
                       send: { level, applied in fake.record(level, applied) },
                       unauthorized: unauthorized,
                       sleep: { [sleeper] in try await sleeper.sleep($0) })
    }

    /// Lets the main actor run until `condition` holds.
    private func until(_ condition: @autoclosure () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<5000 where !condition() { await Task.yield() }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    /// Lets everything that can run, run.
    private func settle() async { for _ in 0..<200 { await Task.yield() } }

    func testAppliesANewTargetAndReportsTheScreenLevelWithTheSeq() async {
        let fake = Fake()
        let sync = make(fake)
        await sync.receive(target: 30, seq: 4)?.value
        XCTAssertEqual(fake.screen, 0.3, accuracy: 1e-9)
        XCTAssertEqual(fake.reports.count, 1)
        XCTAssertEqual(fake.reports[0].0, fake.screen, accuracy: 1e-9)
        XCTAssertEqual(BrightnessReporter.value(for: fake.reports[0].0), 30)
        XCTAssertEqual(fake.reports[0].1, 4)
    }

    func testTheSameSeqLeavesTheScreenAloneSoControlCenterWins() async {
        let fake = Fake()
        let sync = make(fake)
        await sync.receive(target: 30, seq: 4)?.value
        fake.screen = 0.9
        XCTAssertNil(sync.receive(target: 30, seq: 4))
        XCTAssertEqual(fake.screen, 0.9)
        XCTAssertEqual(fake.reports.count, 1)
    }

    func testASyncThatOutlivesTheDashboardStillRefusesTheSeqItApplied() async {
        // The dashboard is rebuilt around the same sync: the new page pushes seq 4 again.
        let fake = Fake()
        let sync = make(fake)
        await sync.receive(target: 30, seq: 4)?.value
        sync.stop()  // the old dashboard went away
        fake.screen = 0.8
        XCTAssertNil(sync.receive(target: 30, seq: 4))
        XCTAssertEqual(fake.screen, 0.8)
        XCTAssertEqual(sync.lastApplied, 4)
    }

    func testResetForgetsWhatWasApplied() async {
        let fake = Fake()
        let sync = make(fake)
        await sync.receive(target: 30, seq: 4)?.value
        sync.reset()
        XCTAssertNotNil(sync.receive(target: 30, seq: 4))
    }

    func testAppliedIsSentAgainUntilAReportLands() async {
        let fake = Fake()
        fake.answer = .failed
        let sync = make(fake)
        await sync.receive(target: 30, seq: 4)?.value
        fake.answer = .sent
        sync.levelChanged()
        await until(sleeper.pending == 1)
        sleeper.fire()
        await until(fake.reports.count == 2)
        sync.levelChanged()
        await until(sleeper.pending == 1)
        sleeper.fire()
        await until(fake.reports.count == 3)
        XCTAssertEqual(fake.reports.map { $0.1 }, [4, 4, nil])
    }

    func testLevelChangesAreDebounced() async {
        let fake = Fake()
        let sync = make(fake)
        sync.levelChanged()
        sync.levelChanged()
        sync.levelChanged()
        await until(sleeper.pending >= 1)
        await settle()
        XCTAssertEqual(fake.reports.count, 0)
        sleeper.fire()
        await until(fake.reports.count == 1)
        await settle()
        XCTAssertEqual(fake.reports.count, 1)
        XCTAssertEqual(sleeper.durations.first, BrightnessSync.debounce)
    }

    func testStopPreventsAPendingDebouncedReport() async {
        let fake = Fake()
        let sync = make(fake)
        sync.levelChanged()
        await until(sleeper.pending == 1)
        sync.stop()
        sleeper.fire()
        await settle()
        XCTAssertEqual(fake.reports.count, 0)
    }

    func testHeartbeatReportsEveryIntervalUntilCancelled() async {
        let fake = Fake()
        let sync = make(fake)
        let task = Task { await sync.run() }
        await until(fake.reports.count == 1 && sleeper.pending == 1)
        sleeper.fire()
        await until(fake.reports.count == 2 && sleeper.pending == 1)
        XCTAssertEqual(sleeper.durations.last, BrightnessSync.heartbeat)
        task.cancel()
        await task.value
        sleeper.fire()
        await settle()
        XCTAssertEqual(fake.reports.count, 2)
    }

    func testA401FeedsTheUnauthorizedPath() async {
        let fake = Fake()
        fake.answer = .unauthorized
        var called = 0
        let sync = make(fake, unauthorized: { called += 1 })
        await sync.receive(target: 30, seq: 1)?.value
        XCTAssertEqual(called, 1)
    }

    func testA401OnAHeartbeatFeedsTheUnauthorizedPath() async {
        let fake = Fake()
        fake.answer = .unauthorized
        var called = 0
        let sync = make(fake, unauthorized: { called += 1 })
        let task = Task { await sync.run() }
        await until(called == 1)
        task.cancel()
        await task.value
    }

    func testOtherFailuresAreSilent() async {
        let fake = Fake()
        fake.answer = .failed
        var called = 0
        let sync = make(fake, unauthorized: { called += 1 })
        await sync.receive(target: 30, seq: 1)?.value
        XCTAssertEqual(called, 0)
    }

    func testStopCancelsAReportInFlight() async {
        let cancelled = expectation(description: "the send was cancelled")
        let started = expectation(description: "the send started")
        let sync = BrightnessSync(read: { 0.5 }, write: { _ in },
                                  send: { _, _ in
                                      started.fulfill()
                                      do { try await Task.sleep(for: .seconds(60)) } catch { cancelled.fulfill() }
                                      return .failed
                                  },
                                  unauthorized: {})
        sync.receive(target: 30, seq: 1)
        await fulfillment(of: [started], timeout: 5)
        sync.stop()
        await fulfillment(of: [cancelled], timeout: 5)
    }
}
