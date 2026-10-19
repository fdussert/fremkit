import CoreGraphics
import Foundation
import FremkitCore

/// What the status menu shows about the kiosk display's brightness.
enum BrightnessMenuState: Equatable {
    case unavailable(L10nKey)
    case level(Int)
}

/// Drives the brightness of the display the kiosk is on.
///
/// The server decides, this applies (see `BrightnessChannel`):
///
/// - **server → helper**: a WebSocket to the server's `/ws`, authorized with the access secret
///   like every other request, subscribed to the `brightness` channel. Each snapshot carries the
///   kiosk screen's `target` and `seq`; a new `seq` is written to the display.
/// - **helper → server**: `POST /api/hooks/brightness`, like the Dock badges: whether DDC works,
///   the level read back, the Mac's built-in display (for "follow the Mac"), and the last `seq`
///   applied. On change, and every ten seconds as a heartbeat.
/// - the status menu's slider sends a `set` command on the same socket, so a level chosen there
///   goes through the same rules as one chosen on the Edge (a manual change holds an automatic
///   mode back). With no socket, it is written directly.
///
/// State lives on the main thread; every DDC transfer runs on `io`, a serial queue, because each
/// one blocks for tens of milliseconds and the monitor wants them one at a time.
final class BrightnessController {
    private let port: Int
    private let access: ServerAccess
    /// The screen the kiosk shows, from its URL; nil lets the server pick the first Edge screen.
    private let screen: String?
    private let io = DispatchQueue(label: "dev.fremkit.helper.ddc")

    // Display
    private var display: CGDirectDisplayID?
    /// Bumped on every display change, so a lookup that finishes late is dropped.
    private var generation = 0
    private var service: DDCService?
    private var maximum = 100
    private var unavailable: BrightnessChannel.Unavailable? = .noDisplay
    private var value: Int?
    private var builtin: Double?

    // Applying
    private var throttle = BrightnessThrottle(interval: 0.1)
    private var throttleTimer: Timer?
    private var writing = false
    /// A value that came due while a transfer was in flight; written as soon as it ends.
    private var queued: (level: Int, seq: Int?)?
    /// The `seq` of the value waiting in the throttle or being written.
    private var pendingSeq: Int?
    private var appliedSeq: Int?
    /// True until the first directive of a connection: an old target is not re-applied on reconnect
    /// when the display is already there.
    private var freshConnection = true

    // Server link
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var reconnectDelay: TimeInterval = 1
    private var commandCounter = 0
    private var running = false

    // Reporting
    private var tickTimer: Timer?
    private var ticks = 0
    private var lastReport: String?
    private var ticksSinceReport = 0
    private static let tick: TimeInterval = 2
    /// A report at least this often, so the server's 30-second staleness never closes on a quiet display.
    private static let heartbeatTicks = 5
    /// The display is read again this often, to notice its own buttons.
    private static let rereadTicks = 30

    var onMenuState: ((BrightnessMenuState) -> Void)?
    private var lastMenuState: BrightnessMenuState?

    init(port: Int, access: ServerAccess, kioskURL: URL?) {
        self.port = port
        self.access = access
        screen = kioskURL.flatMap(BrightnessChannel.screen(fromKioskURL:))
    }

    func start() {
        guard !running else { return }
        running = true
        connect()
        let timer = Timer(timeInterval: Self.tick, repeats: true) { [weak self] _ in self?.onTick() }
        // `.common`, so the slider in an open menu keeps the display and the report moving.
        RunLoop.main.add(timer, forMode: .common)
        tickTimer = timer
        onTick()
    }

    func stop() {
        running = false
        tickTimer?.invalidate()
        tickTimer = nil
        throttleTimer?.invalidate()
        throttleTimer = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
    }

    // MARK: - Display

    /// The kiosk's display changed (or went away): find its DDC service again.
    func displayDidChange(_ id: CGDirectDisplayID?) {
        guard id != display || service == nil else { return }
        display = id
        generation += 1
        let generation = self.generation
        service = nil
        value = nil
        guard let id else {
            unavailable = .noDisplay
            publish()
            return
        }
        io.async { [weak self] in
            let lookup = DDCService.find(for: id)
            var read: DDC.Value?
            if case let .found(service) = lookup { read = service.read() }
            DispatchQueue.main.async {
                guard let self, self.generation == generation else { return }
                switch lookup {
                case let .found(service):
                    // A service that never answers a read is a monitor with DDC/CI switched off.
                    if let read {
                        self.service = service
                        self.maximum = read.maximum
                        self.value = DDC.percent(read)
                        self.unavailable = nil
                    } else {
                        self.unavailable = .noDDC
                    }
                case let .unavailable(reason):
                    self.unavailable = reason
                }
                self.publish()
            }
        }
    }

    private func reread() {
        guard let service, !writing else { return }
        let generation = self.generation
        io.async { [weak self] in
            let read = service.read()
            DispatchQueue.main.async {
                guard let self, self.generation == generation, !self.writing, let read else { return }
                self.maximum = read.maximum
                self.value = DDC.percent(read)
                self.publish()
            }
        }
    }

    // MARK: - Applying

    private func apply(_ directive: BrightnessChannel.Directive) {
        let first = freshConnection
        freshConnection = false
        guard directive.available, let target = directive.target, directive.seq != appliedSeq, directive.seq != pendingSeq else { return }
        if first, target == value {
            appliedSeq = directive.seq
            publish()
            return
        }
        offer(target, seq: directive.seq)
    }

    /// The menu's slider: through the server when it is there, directly otherwise.
    func setFromMenu(_ level: Int) {
        if let socket, socket.state == .running {
            commandCounter += 1
            socket.send(.string(BrightnessChannel.setMessage(id: "helper-\(commandCounter)", value: level))) { _ in }
        } else if unavailable == nil {
            offer(level, seq: nil)
        }
    }

    private func offer(_ level: Int, seq: Int?) {
        pendingSeq = seq
        if let now = throttle.offer(level, now: ProcessInfo.processInfo.systemUptime) {
            write(now, seq: seq)
        } else {
            armThrottle()
        }
    }

    private func armThrottle() {
        guard throttleTimer == nil, let deadline = throttle.deadline else { return }
        let delay = max(0, deadline - ProcessInfo.processInfo.systemUptime)
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.throttleTimer = nil
            self.drainThrottle()
        }
        RunLoop.main.add(timer, forMode: .common)
        throttleTimer = timer
    }

    private func drainThrottle() {
        // One transfer at a time: a value that comes due while one is in flight waits for it.
        guard !writing else { return }
        if let level = throttle.due(now: ProcessInfo.processInfo.systemUptime) {
            write(level, seq: pendingSeq)
        } else {
            armThrottle()
        }
    }

    private func write(_ level: Int, seq: Int?) {
        guard let service else { return }
        guard !writing else {
            queued = (level, seq)
            return
        }
        writing = true
        value = level
        let raw = DDC.raw(percent: level, maximum: maximum)
        let maximum = self.maximum
        let generation = self.generation
        io.async { [weak self] in
            let read = service.write(raw: raw, maximum: maximum)
            DispatchQueue.main.async {
                guard let self else { return }
                self.writing = false
                guard self.generation == generation else { return }
                if let read { self.value = DDC.percent(read) }
                if let next = self.queued {
                    self.queued = nil
                    self.write(next.level, seq: next.seq)
                } else if self.throttle.pending != nil {
                    self.drainThrottle()
                } else if let seq {
                    self.appliedSeq = seq
                }
                self.publish()
            }
        }
    }

    // MARK: - Reporting

    private func onTick() {
        ticks += 1
        ticksSinceReport += 1
        let now = BuiltinDisplay.brightness()
        // Small moves of the ambient light sensor are not worth a report.
        if (now == nil) != (builtin == nil) || abs((now ?? 0) - (builtin ?? 0)) >= 0.005 { builtin = now }
        if ticks % Self.rereadTicks == 0 { reread() }
        publish(heartbeat: ticksSinceReport >= Self.heartbeatTicks)
    }

    /// Updates the menu, and reports to the server when something changed or a heartbeat is due.
    private func publish(heartbeat: Bool = false) {
        let menu: BrightnessMenuState
        switch unavailable {
        case .none: menu = value.map(BrightnessMenuState.level) ?? .unavailable(.brightnessNoDDC)
        case .noDisplay?: menu = .unavailable(.brightnessUnavailable)
        case .noDDC?: menu = .unavailable(.brightnessNoDDC)
        case .ambiguous?: menu = .unavailable(.brightnessAmbiguous)
        }
        if menu != lastMenuState {
            lastMenuState = menu
            onMenuState?(menu)
        }

        let body = BrightnessChannel.report(
            screen: screen, available: unavailable == nil, reason: unavailable, value: unavailable == nil ? value : nil,
            display: service?.name, builtin: builtin, applied: appliedSeq
        )
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: .sortedKeys) else { return }
        let signature = String(decoding: data, as: UTF8.self)
        guard heartbeat || signature != lastReport else { return }
        lastReport = signature
        ticksSinceReport = 0
        post(data)
    }

    private func post(_ data: Data) {
        guard running, let url = URL(string: "http://127.0.0.1:\(port)\(BrightnessChannel.reportPath)") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        request.timeoutInterval = 5
        access.authorize(&request)
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let ok = ((response as? HTTPURLResponse)?.statusCode).map { (200..<300).contains($0) } ?? false
            // A report the server did not take is sent again on the next tick.
            if !ok { DispatchQueue.main.async { self?.lastReport = nil } }
        }.resume()
    }

    // MARK: - Socket

    private func connect() {
        guard running, let url = URL(string: "ws://127.0.0.1:\(port)/ws") else { return }
        var request = URLRequest(url: url)
        access.authorize(&request)
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        self.session?.invalidateAndCancel()
        self.session = session
        self.socket = socket
        freshConnection = true
        socket.resume()
        socket.send(.string(BrightnessChannel.subscribeMessage())) { _ in }
        receive(on: socket)
        // The server may have restarted with nothing to say yet: tell it everything now.
        lastReport = nil
    }

    private func receive(on socket: URLSessionWebSocketTask) {
        socket.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.socket === socket else { return }
                switch result {
                case let .success(message):
                    self.reconnectDelay = 1
                    let data: Data?
                    switch message {
                    case let .string(text): data = Data(text.utf8)
                    case let .data(bytes): data = bytes
                    @unknown default: data = nil
                    }
                    if let data, let directive = BrightnessChannel.directive(from: data) { self.apply(directive) }
                    self.receive(on: socket)
                case .failure:
                    self.socket = nil
                    // The server is restarting, or not up yet: try again, a little later each time.
                    let delay = self.reconnectDelay
                    self.reconnectDelay = min(self.reconnectDelay * 2, 15)
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
                }
            }
        }
    }
}
