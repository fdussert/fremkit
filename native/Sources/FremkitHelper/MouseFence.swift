import ApplicationServices
import CoreGraphics
import Foundation
import FremkitCore

/// Whether the fence is really filtering events, and why not when it is not.
///
/// The menu checkmark reflects the config flag; this reflects reality.
enum FenceState: Equatable {
    /// Not requested, or stopped.
    case off
    /// The event tap is installed and filtering.
    case active
    /// The tap could not be created: Accessibility has not been granted yet.
    case missingPermission
}

/// Keeps the mouse pointer out of the Edge display, which is a dashboard and not a workspace.
///
/// A session event tap rewrites every pointer motion that lands inside the Edge bounds, except
/// the helper's own synthetic events (recognised by their source `userData`).
final class MouseFence {
    /// Delay between two attempts to create the tap while Accessibility is missing.
    private static let retryInterval: TimeInterval = 5

    /// Bounds of the Edge display; the fence does nothing while this is nil.
    var edge: CGRect?

    /// Called on the main thread whenever the effective state changes.
    var onStateChange: ((FenceState) -> Void)?

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    /// Latest pointer position seen outside `edge`, where the cursor is pushed back to.
    private var last: CGPoint?
    /// True between `start()` and `stop()`, even while the tap itself is missing.
    private var wantsRunning = false
    private var retryTimer: Timer?

    private(set) var isRunning = false

    private(set) var state: FenceState = .off {
        didSet {
            guard state != oldValue else { return }
            onStateChange?(state)
        }
    }

    init(edge: CGRect?) {
        self.edge = edge
    }

    deinit { stop() }

    // MARK: - Lifecycle

    /// Starts the tap, retrying in the background while Accessibility is not granted yet.
    ///
    /// Returns whether the tap is up right now. `CGEvent.tapCreate` returns nil until the user
    /// has granted Accessibility, which happens long after launch, so a first failure is normal
    /// and not final. The prompt itself is raised once at launch by `AppDelegate`.
    @discardableResult
    func start() -> Bool {
        wantsRunning = true
        guard !isRunning else { return true }

        if createTap() {
            stopRetrying()
            state = .active
            return true
        }

        FileHandle.standardError.write(Data("fremkit: mouse fence needs Accessibility access\n".utf8))
        state = .missingPermission
        startRetrying()
        return false
    }

    func stop() {
        wantsRunning = false
        stopRetrying()

        guard isRunning else {
            state = .off
            return
        }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        source = nil
        tap = nil
        last = nil
        isRunning = false
        state = .off
    }

    // MARK: - Tap creation and retry

    private func createTap() -> Bool {
        let mask: CGEventMask =
            (1 << CGEventType.mouseMoved.rawValue) |
            (1 << CGEventType.leftMouseDragged.rawValue) |
            (1 << CGEventType.rightMouseDragged.rawValue) |
            (1 << CGEventType.otherMouseDragged.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let fence = Unmanaged<MouseFence>.fromOpaque(refcon).takeUnretainedValue()
                return fence.handle(type: type, event: event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else { return false }

        self.tap = tap
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        if let source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
        CGEvent.tapEnable(tap: tap, enable: true)
        isRunning = true
        return true
    }

    private func startRetrying() {
        guard retryTimer == nil else { return }
        // `.common` so the retry keeps ticking while a menu is being tracked.
        let timer = Timer(timeInterval: Self.retryInterval, repeats: true) { [weak self] _ in
            self?.retryTick()
        }
        RunLoop.main.add(timer, forMode: .common)
        retryTimer = timer
    }

    private func stopRetrying() {
        retryTimer?.invalidate()
        retryTimer = nil
    }

    /// One retry attempt: keep trying while the Accessibility grant is missing, and give the tap
    /// one last chance once it lands. A tap that still fails with the grant in place will not
    /// start working on its own, so retrying forever would be pointless.
    private func retryTick() {
        guard wantsRunning, !isRunning else {
            stopRetrying()
            return
        }
        if createTap() {
            stopRetrying()
            state = .active
            return
        }
        if AXIsProcessTrusted() {
            NSLog("fremkit: mouse fence tap still fails although Accessibility is granted; giving up")
            stopRetrying()
        }
    }

    // MARK: - Tap callback

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // The system disables a tap that is too slow, or when the user asks it to.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }

        // Let the helper's own synthetic events through, or the touch panel could not
        // drive the pointer on the Edge display at all.
        if event.getIntegerValueField(.eventSourceUserData) == EventPoster.userData {
            return Unmanaged.passUnretained(event)
        }

        guard let edge else { return Unmanaged.passUnretained(event) }

        let location = event.location
        // The main display is the one rectangle guaranteed to exist and to hold a cursor, so it
        // is where the fence sends the pointer when it has no last-known outside position.
        let safe = CGDisplayBounds(CGMainDisplayID())
        guard let clamped = FenceMath.clamp(location, edge: edge, last: last, safe: safe) else {
            last = location
            return Unmanaged.passUnretained(event)
        }

        // Remember where the pointer was pushed back to, so the next event inside the Edge clamps
        // to this point instead of taking the cold fallback a second time.
        last = clamped
        warpCursor(to: clamped)
        event.location = clamped
        return Unmanaged.passUnretained(event)
    }
}
