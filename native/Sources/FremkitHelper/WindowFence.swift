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
final class WindowFence {
    /// How often the window list is read. Slow enough to be free, quick enough that a window
    /// landing there is gone before the user has finished wondering where it went.
    private static let interval: TimeInterval = 2

    /// How many times one window is moved before it is left alone.
    ///
    /// An application that puts its window straight back would otherwise be fought forever, at
    /// two rounds a second between the two of us, with the window flickering across two displays.
    private static let maxAttempts = 3

    /// How long an application is given to answer the Accessibility API, so a hung one cannot
    /// stall the helper's main thread.
    private static let messagingTimeout: Float = 1

    /// Bounds of the Edge display; the fence does nothing while this is nil.
    var edge: CGRect?

    private var timer: Timer?
    private var attempts: [CGWindowID: Int] = [:]
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
        attempts = [:]
        isRunning = false
    }

    // MARK: - Sweep

    /// Moves every window of another application that overlaps the Edge back onto a display the
    /// user can see. Safe to call at any time; it does nothing when there is nothing to do.
    func sweep() {
        guard let edge else { return }
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return }

        // A window that closed takes its attempt count with it, so the same number handed to a
        // new window starts from zero.
        let present = WindowSweep.present(in: infos)
        attempts = attempts.filter { present.contains($0.key) }

        let strays = WindowSweep.strays(in: infos, edge: edge, ownPid: getpid())
        guard !strays.isEmpty else { return }

        guard AXIsProcessTrusted() else {
            if !warnedAboutPermission {
                warnedAboutPermission = true
                NSLog("fremkit: a window sits on the Edge but moving it needs Accessibility access")
            }
            return
        }
        warnedAboutPermission = false

        let screens = Self.screenBounds()
        for stray in strays {
            let count = attempts[stray.id] ?? 0
            guard count < Self.maxAttempts else { continue }
            guard let target = AdminPlacement.rescue(frame: stray.frame, size: stray.frame.size,
                                                     screens: screens, kiosk: edge) else { continue }
            attempts[stray.id] = count + 1
            move(stray, to: target, edge: edge)
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

    // MARK: - Accessibility

    private func move(_ stray: StrayWindow, to target: CGRect, edge: CGRect) {
        let app = AXUIElementCreateApplication(stray.pid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return }

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

    private func frame(of window: AXUIElement) -> CGRect? {
        guard let positionValue = axValue(window, kAXPositionAttribute),
              let sizeValue = axValue(window, kAXSizeAttribute) else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &origin),
              AXValueGetValue(sizeValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    /// One `AXValue` attribute, or nil when the application answers something else entirely.
    private func axValue(_ element: AXUIElement, _ attribute: String) -> AXValue? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        // Checked just above: the answer is an AXValue and nothing else.
        return (value as! AXValue)
    }
}
