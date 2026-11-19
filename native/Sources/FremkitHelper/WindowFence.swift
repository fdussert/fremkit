import ApplicationServices
import CoreGraphics
import Foundation
import FremkitCore

/// Keeps other applications' windows off the Edge display, which is a dashboard and not a workspace.
///
/// The mouse fence stops a window from being *dragged* there; this one deals with the windows that
/// arrive without the pointer, which is how it actually happens: an application restores a frame it
/// saved before the Edge existed, or a display is rearranged under windows that were fine where
/// they were. The kiosk covers that display above the status-bar level, so such a window is lost
/// for good: focused, taking the keyboard, and invisible under the dashboard.
///
/// A sweep costs one `CGWindowListCopyWindowInfo` call, which needs no permission and no round
/// trip to any application. The Accessibility API is only reached for an application that actually
/// has a window on the Edge, which is almost never.
///
/// Threading: everything this class keeps (the timer, the ledger, the windows being moved) belongs
/// to the main thread, where the timer fires and where `AppDelegate` calls in. The Accessibility
/// calls alone run on `axQueue`, with values copied in and nothing of `self` touched, and report
/// back to the main thread when done. The main run loop also hosts the mouse fence's event tap, so
/// an application that half-hangs while it is asked to move a window must not hold it, or the
/// pointer would freeze for the whole Mac.
final class WindowFence {
    /// How often the window list is read. Slow enough to be free, quick enough that a window
    /// landing there is gone before the user has finished wondering where it went.
    private static let interval: TimeInterval = 2

    /// How long an application is given to answer each Accessibility call, so a hung one holds
    /// `axQueue` for seconds at most rather than forever.
    private static let messagingTimeout: Float = 1

    /// Where the Accessibility calls run: serial, so two moves never talk to applications at
    /// once, and off the main thread, which never waits on it.
    private let axQueue = DispatchQueue(label: "app.fremkit.helper.window-fence", qos: .utility)

    /// Bounds of the Edge display; the fence does nothing while this is nil.
    var edge: CGRect?

    private var timer: Timer?
    /// Three moves per window and per episode; see `RescueLedger`.
    private var ledger = RescueLedger()
    /// Windows whose move was handed to `axQueue` and has not come back yet. A sweep firing in
    /// the meantime leaves them alone rather than queueing the same move twice. Kept across
    /// `stop()`, since the moves already queued run anyway.
    private var inFlight: Set<CGWindowID> = []
    /// Logged once, rather than every two seconds, while Accessibility is missing.
    private var warnedAboutPermission = false

    private(set) var isRunning = false

    init(edge: CGRect?) {
        self.edge = edge
    }

    deinit { stop() }

    // MARK: - Lifecycle

    func start() {
        guard !isRunning else { return }
        // `.common` so the sweep keeps ticking while a menu is being tracked.
        let timer = Timer(timeInterval: Self.interval, repeats: true) { [weak self] _ in self?.sweep() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        isRunning = true
        sweep()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        ledger.reset()
        isRunning = false
    }

    // MARK: - Sweep

    /// Moves every window of another application that overlaps the Edge back onto a display the
    /// user can see. Safe to call at any time; it does nothing when there is nothing to do.
    func sweep() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let edge else { return }
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return }

        let now = ProcessInfo.processInfo.systemUptime
        let strays = WindowSweep.strays(in: infos, edge: edge, ownPid: getpid())
        ledger.observe(onEdge: Set(strays.map(\.id)), present: WindowSweep.present(in: infos), now: now)
        guard !strays.isEmpty else { return }

        // A window being dragged toward the Edge would be yanked from under the pointer, and the
        // move would cost it one of its attempts. The next sweep after the button is released
        // deals with wherever it was dropped.
        guard !Self.aMouseButtonIsDown() else { return }

        guard AXIsProcessTrusted() else {
            if !warnedAboutPermission {
                warnedAboutPermission = true
                NSLog("fremkit: a window sits on the Edge but moving it needs Accessibility access")
            }
            return
        }
        warnedAboutPermission = false

        let screens = Self.screenBounds()
        guard let screen = AdminPlacement.target(screens: screens, kiosk: edge) else { return }
        var moved = 0
        for stray in strays where !inFlight.contains(stray.id) {
            guard let target = AdminPlacement.rescue(frame: stray.frame, size: stray.frame.size,
                                                     screens: screens, kiosk: edge) else { continue }
            switch ledger.decide(stray.id, now: now) {
            case .move:
                // Several windows rescued together would all be centred on the same point.
                let destination = WindowCascade.place(target, index: moved, in: screen)
                moved += 1
                inFlight.insert(stray.id)
                axQueue.async { [weak self] in
                    Self.move(stray, to: destination, edge: edge)
                    DispatchQueue.main.async { self?.inFlight.remove(stray.id) }
                }
            case .giveUp:
                NSLog("fremkit: a window keeps returning to the Edge after %d moves; leaving it there", ledger.maxAttempts)
            case .leaveAlone:
                continue
            }
        }
    }

    /// Whether the left, right or centre button is held, by a mouse, a trackpad or the touch panel.
    private static func aMouseButtonIsDown() -> Bool {
        [CGMouseButton.left, .right, .center].contains {
            CGEventSource.buttonState(.combinedSessionState, button: $0)
        }
    }

    /// Every active display, the main one first, in the space window bounds are reported in.
    private static func screenBounds() -> [CGRect] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        let main = CGMainDisplayID()
        // `AdminPlacement.target` takes the first screen that is not the kiosk's, so the display
        // the user works on has to come first.
        return (ids.filter { $0 == main } + ids.filter { $0 != main }).map(CGDisplayBounds)
    }

    // MARK: - Accessibility, on `axQueue` only

    private static func move(_ stray: StrayWindow, to target: CGRect, edge: CGRect) {
        let app = AXUIElementCreateApplication(stray.pid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return }
        // The timeout belongs to the element it is set on: the window elements copied from the
        // application do not inherit it, and would wait the system's default of several seconds.
        for window in windows { AXUIElementSetMessagingTimeout(window, Self.messagingTimeout) }

        // The window list and the Accessibility API name the same window in two ways that have no
        // identifier in common, so it is matched on its frame, and, if it moved in between, on
        // being the one still overlapping the Edge.
        let window = windows.first { frame(of: $0) == stray.frame }
            ?? windows.first { frame(of: $0)?.intersects(edge) == true }
        guard let window else { return }

        // The size first: a window wider than the display it is moved to is shrunk to fit, and
        // setting the position afterwards is what decides where it lands.
        if target.size != stray.frame.size {
            var size = target.size
            if let value = AXValueCreate(.cgSize, &size) {
                AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value)
            }
        }
        var origin = target.origin
        if let value = AXValueCreate(.cgPoint, &origin) {
            AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value)
        }
    }

    private static func frame(of window: AXUIElement) -> CGRect? {
        guard let positionValue = axValue(window, kAXPositionAttribute),
              let sizeValue = axValue(window, kAXSizeAttribute) else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &origin),
              AXValueGetValue(sizeValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    /// One `AXValue` attribute, or nil when the application answers something else entirely.
    private static func axValue(_ element: AXUIElement, _ attribute: String) -> AXValue? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        // Checked just above: the answer is an AXValue and nothing else.
        return (value as! AXValue)
    }
}
