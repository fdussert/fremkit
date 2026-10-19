import CoreGraphics
import Foundation
import Observation

extension Viewport {
    /// The size the iPad reports when it pairs: the region the dashboard's web view gets, in
    /// points, in the orientation the app is in, each side rounded to the nearest point. The app
    /// measures that region on the container the dashboard is laid out in, so what it reports is
    /// what the page will see (1408 × 950 on an iPad Pro 11" in More Space, landscape).
    public init(points size: CGSize) {
        func side(_ value: CGFloat) -> Int {
            guard value.isFinite else { return 1 }
            return Int(min(max(value.rounded(.toNearestOrAwayFromZero), 1), 10000))
        }
        self.init(width: side(size.width), height: side(size.height))
    }
}

/// The region the dashboard is laid out in, as the app measures it on its root container, and
/// the wait for a measure worth reporting. Pairing never reports a computed guess: it waits for
/// the first measure, then for it to hold still for `settle` (a cold launch from a link may lay
/// out once before the window takes its final orientation), and after at most `cap` reports the
/// latest measure as it is.
@MainActor
public final class ViewportMeter {
    public private(set) var size: CGSize?
    private var changedAt = ContinuousClock.now
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    private let settle: Duration
    private let cap: Duration

    public init(settle: Duration = .milliseconds(300), cap: Duration = .seconds(1)) {
        self.settle = settle
        self.cap = cap
    }

    private func stopWaiting(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume()
    }

    /// A new size of the container.
    public func measured(_ size: CGSize) {
        guard size != self.size else { return }
        self.size = size
        changedAt = .now
        let waiting = waiters.values
        waiters = [:]
        waiting.forEach { $0.resume() }
    }

    /// The size to report: waits for the first measure, then for it to settle (see above). A
    /// cancelled caller stops waiting (and gets whatever is known, which it will drop).
    public func viewport() async -> Viewport {
        if size == nil {
            let id = UUID()
            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    waiters[id] = continuation
                }
            } onCancel: {
                // Runs after the continuation is stored: both are on the main actor, and this hop
                // is queued behind the body, which stores it synchronously.
                Task { @MainActor in self.stopWaiting(id) }
            }
        }
        let start = ContinuousClock.now
        while !Task.isCancelled, ContinuousClock.now - changedAt < settle, ContinuousClock.now - start < cap {
            try? await Task.sleep(for: .milliseconds(20))
        }
        return Viewport(points: size ?? .zero)
    }
}

/// Where pairing is, from the welcome screen's two buttons (or a `fremkit://pair` link) to a
/// stored pairing.
public enum PairingStep: Equatable, Sendable {
    /// Nothing in progress: the app shows whatever `AppModel` says.
    case idle
    /// The camera is looking for the Mac's QR code.
    case scanning
    /// Pairing with a scanned or opened link.
    case link(PairingLink)
    /// The manual path: the Macs Bonjour found, by name.
    case manualList
    /// The manual path: reading the key of the Mac the user picked.
    case manualKey(MacService)
    /// The manual path: the key's words are shown, the user types the code.
    case manualCode(MacService, keyHash: String)
}

/// A Mac found by Bonjour: its service name (the Mac's computer name) and where it answered.
public struct MacService: Equatable, Sendable {
    public let name: String
    public let address: String
    public let port: Int

    public init(name: String, address: String, port: Int) {
        self.name = name
        self.address = address
        self.port = port
    }
}

/// Why the last step failed, for the line under the button.
public enum PairingProblem: Equatable, Sendable {
    /// The Mac refused the code (wrong, expired, or too many tries): its own message, as is. May
    /// be empty when the Mac sent none.
    case refused(String)
    /// Nothing answered.
    case unreachable
    /// Something answered with another key than the code's Mac.
    case wrongMac
    /// The Mac did not accept the request itself (a version mismatch, not the user's doing).
    case invalidRequest
    /// The Mac shows no live code: a new one has to be made there.
    case noCode
    /// The Mac paired this iPad but the keychain refused to keep it.
    case notSaved
}

/// One `POST /api/pair`, as `PairClient.pair` takes it.
public struct PairAttempt: Equatable, Sendable {
    public let hosts: [String]
    public let port: Int
    public let keyHash: String
    public let code: String
    /// The QR link's secret, when it carried one; nil on the manual path.
    public let secret: String?
    public let name: String
    public let viewport: Viewport
    public let macName: String
}

/// Printing an attempt never shows the code, the secret or the pin.
extension PairAttempt: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "PairAttempt(\(hosts), port \(port))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["hosts": hosts, "port": port, "keyHash": redacted, "code": redacted,
                                "secret": secret == nil ? "none" : redacted,
                                "name": name, "viewport": viewport, "macName": macName])
    }
}

/// Reads the key a Mac presents on first contact, trusting nothing and sending nothing.
public enum FirstContact {
    /// Opens TLS to `host:port` with a `PinnedSession` in first-contact mode, which refuses the
    /// handshake after recording the key: no request reaches the Mac. Nil when nothing answered
    /// or the key is not one a Fremkit Mac uses.
    public static func keyHash(host: String, port: Int,
                               configuration: URLSessionConfiguration = PinnedTransport.defaultConfiguration) async -> String? {
        guard let request = Endpoint.request(host: host, port: port, path: "/api/devices/me", token: nil) else { return nil }
        let pinned = PinnedSession(keyHash: nil, hosts: [host])
        let session = URLSession(configuration: configuration, delegate: pinned, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        _ = try? await session.data(for: request)
        return pinned.observedKeyHash
    }
}

/// Pairing from the app: the QR code, a `fremkit://pair` link, or the manual path (a Bonjour Mac,
/// its key's four words compared by eye, then the code). On success the pairing goes to
/// `AppModel.pair(with:)`, which stores it and connects.
@Observable @MainActor
public final class PairingFlow {
    public private(set) var step: PairingStep = .idle
    /// True while a request runs: the button is disabled and a spinner shows.
    public private(set) var isWorking = false
    /// What went wrong with the last request, shown under the button.
    public private(set) var problem: PairingProblem?
    /// A link that arrived while this iPad is paired: it waits for the user to confirm replacing
    /// the pairing.
    public private(set) var pendingLink: PairingLink?

    public typealias Pair = @Sendable (PairAttempt) async throws -> PairedMac
    public typealias ReadKey = @Sendable (_ host: String, _ port: Int) async -> String?

    @ObservationIgnored private let model: AppModel
    @ObservationIgnored private let deviceName: @MainActor () -> String
    @ObservationIgnored private let viewport: @MainActor () async -> Viewport
    @ObservationIgnored private let pair: Pair
    @ObservationIgnored private let readKey: ReadKey
    @ObservationIgnored private var running: Task<Void, Never>?
    /// Bumped by each new step, so a late answer for a step the user left is dropped.
    @ObservationIgnored private var generation = 0

    /// - Parameters:
    ///   - deviceName: this iPad's name, shown on the Mac.
    ///   - viewport: the size to report, awaited just before the request is sent: the app waits
    ///     there for its first real measure (see `ViewportMeter`).
    public init(model: AppModel, deviceName: @escaping @MainActor () -> String,
                viewport: @escaping @MainActor () async -> Viewport,
                pair: @escaping Pair = { attempt in
                    try await PairClient().pair(hosts: attempt.hosts, port: attempt.port, keyHash: attempt.keyHash,
                                                code: attempt.code, secret: attempt.secret, name: attempt.name,
                                                viewport: attempt.viewport,
                                                macName: attempt.macName)
                },
                readKey: @escaping ReadKey = { host, port in await FirstContact.keyHash(host: host, port: port) }) {
        self.model = model
        self.deviceName = deviceName
        self.viewport = viewport
        self.pair = pair
        self.readKey = readKey
    }

    /// The request in flight, for tests to wait on.
    var inFlight: Task<Void, Never>? { running }

    /// The four words of the key on screen in the manual path, empty elsewhere.
    public var words: [String] {
        guard case let .manualCode(_, keyHash) = step else { return [] }
        return Fingerprint.words(keyHash: keyHash)
    }

    /// Opens the camera.
    public func scan() {
        move(to: .scanning)
    }

    /// Starts the manual path.
    public func enterCode() {
        move(to: .manualList)
    }

    /// Back to whatever `AppModel` shows; a request in flight is dropped.
    public func cancel() {
        pendingLink = nil
        move(to: .idle)
    }

    /// A `fremkit://pair` link, from the Camera app or anywhere else. Returns false when it is not
    /// a valid one. While this iPad is paired, it waits in `pendingLink` for `confirmReplace()`.
    @discardableResult
    public func handle(url: URL) -> Bool {
        guard let link = PairingLink(url: url) else { return false }
        if needsConfirmation {
            // The camera stops while the question is up, so a code still in view cannot ask again
            // once the user has said no.
            if step == .scanning { move(to: .idle) }
            pendingLink = link
        } else {
            start(link)
        }
        return true
    }

    /// What the camera decoded. Only while scanning, and only a valid pairing link counts: the
    /// first one stops the scan. Returns whether it did.
    @discardableResult
    public func scanned(_ text: String) -> Bool {
        guard step == .scanning, let url = URL(string: text), PairingLink(url: url) != nil else { return false }
        return handle(url: url)
    }

    /// The user agreed to replace the current pairing with `pendingLink`'s Mac.
    public func confirmReplace() {
        guard let link = pendingLink else { return }
        pendingLink = nil
        start(link)
    }

    /// The user kept the current pairing.
    public func declineReplace() {
        pendingLink = nil
    }

    /// Pairs with the link on screen again, after a failure.
    @discardableResult
    public func retry() -> Task<Void, Never>? {
        guard case let .link(link) = step, !isWorking else { return nil }
        return send(hosts: [link.host, link.address], port: link.port, keyHash: link.keyHash, code: link.code,
                    secret: link.secret, macName: link.macName)
    }

    /// The manual path: the user picked a Mac in the list. Reads its key, to show its words.
    @discardableResult
    public func choose(_ service: MacService) -> Task<Void, Never> {
        move(to: .manualKey(service))
        isWorking = true
        let generation = generation
        let task = Task { [readKey] in
            let keyHash = await readKey(service.address, service.port)
            self.finishReading(keyHash, for: service, generation: generation)
        }
        running = task
        return task
    }

    /// The manual path: the user typed the code under the words and pressed **Pair**. The key
    /// they compared is the pin from now on. Nil when the code is not 8 valid characters.
    @discardableResult
    public func submit(code text: String) -> Task<Void, Never>? {
        guard case let .manualCode(service, keyHash) = step, !isWorking, let code = normaliseCode(text) else { return nil }
        return send(hosts: [service.address], port: service.port, keyHash: keyHash, code: code, secret: nil,
                    macName: service.name)
    }

    /// Whether a link must be confirmed first: this iPad has a pairing that still works. One the
    /// Mac removed, or one the keychain could not read, is not worth asking about.
    private var needsConfirmation: Bool {
        model.mac != nil && model.state != .unauthorized
    }

    private func start(_ link: PairingLink) {
        move(to: .link(link))
        retry()
    }

    private func move(to step: PairingStep) {
        generation += 1
        running?.cancel()
        running = nil
        isWorking = false
        problem = nil
        self.step = step
    }

    private func send(hosts: [String], port: Int, keyHash: String, code: String, secret: String?,
                      macName: String) -> Task<Void, Never> {
        generation += 1
        let generation = generation
        isWorking = true
        problem = nil
        let name = deviceName()
        let task = Task { [pair] in
            let viewport = await self.viewport()
            guard generation == self.generation else { return }
            let attempt = PairAttempt(hosts: hosts, port: port, keyHash: keyHash, code: code, secret: secret, name: name,
                                      viewport: viewport, macName: macName)
            let result: Result<PairedMac, PairError>
            do {
                result = .success(try await pair(attempt))
            } catch let error as PairError {
                result = .failure(error)
            } catch {
                result = .failure(.unreachable)
            }
            self.finishPairing(result, generation: generation)
        }
        running = task
        return task
    }

    private func finishReading(_ keyHash: String?, for service: MacService, generation: Int) {
        guard generation == self.generation else { return }
        running = nil
        isWorking = false
        // A key that has no words cannot be compared, and is not a Fremkit Mac's anyway.
        guard let keyHash, !Fingerprint.words(keyHash: keyHash).isEmpty else {
            step = .manualList
            problem = .unreachable
            return
        }
        step = .manualCode(service, keyHash: keyHash)
    }

    private func finishPairing(_ result: Result<PairedMac, PairError>, generation: Int) {
        guard generation == self.generation else { return }
        running = nil
        isWorking = false
        switch result {
        case let .success(mac):
            do {
                try model.pair(with: mac)
                move(to: .idle)
            } catch {
                problem = .notSaved
            }
        case let .failure(error):
            problem = switch error {
            case let .rejected(message), let .limited(message): .refused(message)
            case .unreachable: .unreachable
            case .wrongMac: .wrongMac
            case .invalidRequest: .invalidRequest
            case .noCode: .noCode
            }
        }
    }
}
