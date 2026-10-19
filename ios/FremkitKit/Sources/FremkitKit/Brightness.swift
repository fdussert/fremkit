import Foundation

/// Which targets from the Mac the app has applied. The Mac bumps `seq` for each new target and
/// restarts it at 0 with the server, so a target is applied when its `seq` differs from the last
/// one applied (not when it is greater). A level the user sets in Control Center is therefore
/// reported, not overwritten at every push.
public struct BrightnessState: Equatable, Sendable {
    public private(set) var lastApplied: Int?

    public init(lastApplied: Int? = nil) {
        self.lastApplied = lastApplied
    }

    /// Edge case (R5): if the server restarts and its first `seq` is 0 while 0 was the last
    /// applied, that one target is skipped; the next `seq` applies.
    ///
    /// True when `seq` is new and the caller should set the screen to `target`; records it.
    public mutating func apply(target: Double, seq: Int) -> Bool {
        guard target.isFinite, seq != lastApplied else { return false }
        lastApplied = seq
        return true
    }

    /// `target` (0–100) as a `UIScreen.brightness` (0–1).
    public static func level(forTarget target: Double) -> Double {
        guard target.isFinite else { return 0 }
        return min(max(target / 100, 0), 1)
    }
}

/// How a brightness report ended.
public enum ReportOutcome: Equatable, Sendable {
    case sent
    /// The Mac does not know this iPad any more.
    case unauthorized
    /// Anything else: the next heartbeat retries.
    case failed
}

extension BrightnessReporter {
    /// Sends one report under the pin. Only a 401 is told apart; a pin refusal, a 409 (no device
    /// screen) or a network failure is `failed`.
    public func send(brightness: Double, applied: Int?, transport: Transport) async -> ReportOutcome {
        guard let request = request(brightness: brightness, applied: applied) else { return .failed }
        switch await transport(request, policy) {
        case let .response(status, _) where (200..<300).contains(status): return .sent
        case .response(401, _): return .unauthorized
        case .response, .pinRejected, .failed: return .failed
        }
    }

    /// The transport the app uses: a fresh pinned session per report.
    public static func pinnedTransport(configuration: URLSessionConfiguration = PinnedTransport.defaultConfiguration) -> Transport {
        { request, policy in await PinnedTransport.send(request, policy: policy, configuration: configuration) }
    }
}

/// Applies the Mac's brightness target and reports the screen's level: on a new target, shortly
/// after the level changes (the user in Control Center), and every `interval` while `run()` is
/// running, which is what keeps the Mac from marking the device as gone. The screen and the
/// network are closures, so it is tested with neither.
@MainActor
public final class BrightnessSync {
    public static let debounce: Duration = .milliseconds(500)
    public static let heartbeat: Duration = .seconds(10)

    private var state = BrightnessState()
    /// The `seq` the Mac has not yet been told about: sent with each report until one succeeds.
    private var unreportedApplied: Int?
    private var debounced: Task<Void, Never>?
    /// Reports on their way, cancelled by `stop()`.
    private var inFlight: [UUID: Task<Void, Never>] = [:]

    private let read: @MainActor () -> Double
    private let write: @MainActor (Double) -> Void
    private let send: @Sendable (Double, Int?) async -> ReportOutcome
    private let unauthorized: @MainActor () -> Void
    private let debounceDelay: Duration
    private let interval: Duration
    private let sleep: @Sendable (Duration) async throws -> Void

    /// - Parameters:
    ///   - read: the screen's brightness, 0–1.
    ///   - write: sets the screen's brightness, 0–1.
    ///   - send: reports a brightness (0–1) and the `seq` applied, if any.
    ///   - unauthorized: called when a report is answered 401.
    public init(read: @escaping @MainActor () -> Double,
                write: @escaping @MainActor (Double) -> Void,
                send: @escaping @Sendable (Double, Int?) async -> ReportOutcome,
                unauthorized: @escaping @MainActor () -> Void,
                debounce: Duration = BrightnessSync.debounce,
                interval: Duration = BrightnessSync.heartbeat,
                sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.sleep = sleep
        self.read = read
        self.write = write
        self.send = send
        self.unauthorized = unauthorized
        self.debounceDelay = debounce
        self.interval = interval
    }

    /// A `brightness` message from the page. Applies it when its `seq` is new, then reports.
    @discardableResult
    public func receive(target: Double, seq: Int) -> Task<Void, Never>? {
        guard state.apply(target: target, seq: seq) else { return nil }
        write(BrightnessState.level(forTarget: target))
        unreportedApplied = seq
        return report()
    }

    /// The screen's brightness changed: reports once it has stopped changing.
    public func levelChanged() {
        debounced?.cancel()
        debounced = Task { [debounceDelay, sleep] in
            try? await sleep(debounceDelay)
            if Task.isCancelled { return }
            await report().value
        }
    }

    /// Reports now, and then every `interval`, until cancelled. Run it while the dashboard is
    /// shown and the app active.
    public func run() async {
        while !Task.isCancelled {
            await report().value
            try? await sleep(interval)
        }
    }

    /// Drops a pending debounced report and cancels the ones in flight (the dashboard went away or
    /// the app went to the background).
    public func stop() {
        debounced?.cancel()
        debounced = nil
        for task in inFlight.values { task.cancel() }
        inFlight = [:]
    }

    /// Forgets what was applied and reported: for a new pairing, whose Mac numbers its targets
    /// on its own.
    public func reset() {
        stop()
        state = BrightnessState()
        unreportedApplied = nil
    }

    /// For tests: the last `seq` applied.
    public var lastApplied: Int? { state.lastApplied }

    private func report() -> Task<Void, Never> {
        let level = read()
        let applied = unreportedApplied
        let id = UUID()
        let task = Task { [send] in
            let outcome = await send(level, applied)
            self.inFlight[id] = nil
            if Task.isCancelled { return }
            switch outcome {
            case .sent:
                if let applied, self.unreportedApplied == applied { self.unreportedApplied = nil }
            case .unauthorized:
                self.unauthorized()
            case .failed:
                break
            }
        }
        inFlight[id] = task
        return task
    }
}
