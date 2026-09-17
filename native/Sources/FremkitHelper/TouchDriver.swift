import AppKit
import CoreGraphics
import Foundation
import FremkitCore
import IOKit
import IOKit.hid

/// Why the touch panel could not be opened. Structured rather than a free-form string, so the
/// status menu can phrase it in French without matching on English text.
enum TouchBusyReason: Equatable, CustomStringConvertible {
    /// Another process holds the interface exclusively (e.g. Touchscreen Gestures).
    case exclusiveAccess
    /// `IOHIDManagerOpen` failed for some other reason; carries the raw IOReturn code.
    case openFailed(UInt32)

    var description: String {
        switch self {
        case .exclusiveAccess: return "another driver holds the panel"
        case let .openFailed(code): return String(format: "IOHIDManagerOpen failed (0x%08X)", code)
        }
    }
}

/// What the touch panel is currently doing, as shown in the status menu.
enum TouchState: Equatable, CustomStringConvertible {
    /// The HID interface is open and reports are flowing.
    case active
    /// Input Monitoring has not been granted.
    case notPermitted
    /// The HID interface could not be opened.
    case busy(TouchBusyReason)
    /// The Edge display is not connected, so touches cannot be mapped.
    case noDisplay
    /// The driver is stopped, either by the config or by the menu.
    case disabled

    var description: String {
        switch self {
        case .active: return "active"
        case .notPermitted: return "notPermitted"
        case let .busy(reason): return "busy(\(reason))"
        case .noDisplay: return "noDisplay"
        case .disabled: return "disabled"
        }
    }
}

/// Reads the Edge touch strip in HID, recognises gestures and posts the resulting pointer actions.
///
/// The HID interface is opened in *seize* mode, which takes it away from macOS (and from any
/// third-party driver): nothing else sees the touches while the helper runs.
final class TouchDriver {
    /// IOReturn codes we need, spelled out because the IOKit macros do not import into Swift.
    private enum IOResult {
        static let success: IOReturn = 0
        // From IOKit's IOReturn.h: iokit_common_err(0x2e2) and iokit_common_err(0x2c5).
        static let notPermitted = IOReturn(bitPattern: 0xE000_02E2)
        static let exclusiveAccess = IOReturn(bitPattern: 0xE000_02C5)
    }

    private enum Hardware {
        static let vendorID = 0x27C0
        static let productID = 0x859
        /// Generic Desktop page, Mouse usage: the interface that carries the touch reports.
        static let usagePage = 1
        static let usage = 2
    }

    /// Period of the clock tick that lets a motionless press become a hold.
    private static let tickInterval: TimeInterval = 0.05
    /// Settling delay before the first re-open attempt after a device (re)appears or the Mac wakes.
    private static let reopenDelay: TimeInterval = 0.5
    /// Upper bound of the re-open backoff while the panel stays unavailable.
    private static let reopenDelayCap: TimeInterval = 5

    private let poster: PointerPoster
    /// `GestureEngine` is not thread-safe; this queue is its only owner.
    private let queue = DispatchQueue(label: "dev.fremkit.helper.touch")
    private let engine: GestureEngine

    private var manager: IOHIDManager?
    private var timer: Timer?
    private var wakeObserver: NSObjectProtocol?
    private var running = false
    private var reopenPending = false
    /// Current re-open delay: doubles on every failed open, back to `reopenDelay` on success.
    private var reopenBackoff = TouchDriver.reopenDelay
    /// Guarded by `queue`.
    private var mapper: DisplayMapper?

    /// Called on the main thread whenever the state changes.
    var onState: ((TouchState) -> Void)?
    /// Called on the driver queue once per HID report, with the raw wire bytes, the report id
    /// delivered out of band, and the decode result (nil when it is not a touch report).
    /// Used by `--probe`; the driver itself never prints.
    var onRawReport: ((_ reportID: UInt8, _ bytes: [UInt8], _ parsed: TouchReport?) -> Void)?

    private(set) var state: TouchState = .disabled {
        didSet {
            guard state != oldValue else { return }
            let current = state
            DispatchQueue.main.async { [weak self] in self?.onState?(current) }
        }
    }

    init(poster: PointerPoster, thresholds: GestureThresholds = .init()) {
        self.poster = poster
        self.engine = GestureEngine(thresholds: thresholds)
    }

    deinit {
        closeManager()
        timer?.invalidate()
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
    }

    // MARK: - Display

    /// Bounds of the Edge display; touches are dropped while this is nil.
    var displayBounds: CGRect? {
        didSet {
            let bounds = displayBounds
            queue.async { [weak self] in
                self?.mapper = bounds.map { DisplayMapper(bounds: $0) }
            }
            guard running else { return }
            if bounds == nil {
                state = .noDisplay
            } else if state == .noDisplay {
                state = .active
            }
        }
    }

    // MARK: - Lifecycle

    func start() {
        guard !running else { return }
        running = true
        reopenBackoff = Self.reopenDelay

        // Ask for Input Monitoring before opening, otherwise the open fails silently
        // the first time and the user never sees a prompt.
        _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)

        openManager()

        // `.common` so a menu tracking loop cannot stall the gesture clock.
        let timer = Timer(timeInterval: Self.tickInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer

        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // Waking is a fresh situation too, and the user is there to see it recover quickly.
            self?.scheduleReopen(resetBackoff: true)
        }
    }

    func stop() {
        guard running else { return }
        running = false

        timer?.invalidate()
        timer = nil
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
            self.wakeObserver = nil
        }
        closeManager()
        state = .disabled
    }

    private func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        queue.async { [weak self] in
            guard let self else { return }
            for action in self.engine.tick(now: now) { self.poster.perform(action) }
        }
    }

    // MARK: - HID

    private func openManager() {
        closeManager()

        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        self.manager = manager

        let matching: [String: Any] = [
            kIOHIDVendorIDKey: Hardware.vendorID,
            kIOHIDProductIDKey: Hardware.productID,
            kIOHIDPrimaryUsagePageKey: Hardware.usagePage,
            kIOHIDPrimaryUsageKey: Hardware.usage,
        ]
        IOHIDManagerSetDeviceMatching(manager, matching as CFDictionary)

        let context = Unmanaged.passUnretained(self).toOpaque()

        IOHIDManagerRegisterDeviceMatchingCallback(manager, { context, _, _, _ in
            guard let context else { return }
            let driver = Unmanaged<TouchDriver>.fromOpaque(context).takeUnretainedValue()
            // Only re-open when we are not already reading: the manager fires this for the
            // devices it enrols during our own open, which would otherwise loop forever.
            if driver.state != .active { driver.scheduleReopen() }
        }, context)

        IOHIDManagerRegisterDeviceRemovalCallback(manager, { context, _, _, _ in
            guard let context else { return }
            // A real unplug: the next open is a fresh situation, so start the backoff over.
            Unmanaged<TouchDriver>.fromOpaque(context).takeUnretainedValue().scheduleReopen(resetBackoff: true)
        }, context)

        IOHIDManagerRegisterInputReportCallback(manager, { context, _, _, _, reportID, report, length in
            guard let context, length > 0 else { return }
            let driver = Unmanaged<TouchDriver>.fromOpaque(context).takeUnretainedValue()
            let bytes = Array(UnsafeBufferPointer(start: report, count: Int(length)))
            driver.handle(bytes, reportID: UInt8(truncatingIfNeeded: reportID))
        }, context)

        // `.commonModes`, like the fence tap: touches keep flowing while a menu is tracking.
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)

        let result = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
        switch result {
        case IOResult.success:
            state = displayBounds == nil ? .noDisplay : .active
            reopenBackoff = Self.reopenDelay
        case IOResult.notPermitted:
            state = .notPermitted
            failedToOpen()
        case IOResult.exclusiveAccess:
            state = .busy(.exclusiveAccess)
            failedToOpen()
        default:
            state = .busy(.openFailed(UInt32(bitPattern: result)))
            failedToOpen()
        }
    }

    /// Backs off before the next attempt.
    ///
    /// While Input Monitoring is missing or another driver holds the panel, every open fails and
    /// the matching callback fires again for the device the failed manager still enrolled, so a
    /// fixed delay would rebuild an `IOHIDManager` twice a second forever.
    private func failedToOpen() {
        // Schedule first, so the first retry uses the initial 0.5 s and only the next one doubles.
        scheduleReopen()
        reopenBackoff = min(reopenBackoff * 2, Self.reopenDelayCap)
    }

    private func closeManager() {
        guard let manager else { return }
        IOHIDManagerUnscheduleFromRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
        IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        self.manager = nil
    }

    /// Coalesces the reconnect triggers (wake, matching, removal, failed open) into a single
    /// re-open, after the current backoff delay.
    private func scheduleReopen(resetBackoff: Bool = false) {
        guard running, !reopenPending else { return }
        if resetBackoff { reopenBackoff = Self.reopenDelay }
        reopenPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + reopenBackoff) { [weak self] in
            guard let self else { return }
            self.reopenPending = false
            guard self.running else { return }
            self.openManager()
        }
    }

    private func handle(_ bytes: [UInt8], reportID: UInt8) {
        let now = ProcessInfo.processInfo.systemUptime
        queue.async { [weak self] in
            guard let self else { return }

            // Some transports deliver the payload without its leading report id, which
            // `TouchReport.parse` expects. Decide on the length rather than on the first byte,
            // which could legitimately equal the id.
            var frame = bytes
            if bytes.count == TouchReport.length - 1 { frame.insert(reportID, at: 0) }

            let report = TouchReport.parse(frame)
            self.onRawReport?(reportID, bytes, report)

            guard let report, let mapper = self.mapper else { return }
            let point = mapper.point(x: report.x, y: report.y)
            let sample = TouchSample(down: report.down, point: point, time: now)
            for action in self.engine.feed(sample) { self.poster.perform(action) }
        }
    }
}
