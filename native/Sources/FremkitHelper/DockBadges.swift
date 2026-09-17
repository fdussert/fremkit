import AppKit
import ApplicationServices
import Foundation
import FremkitCore

/// What the Dock reader is doing, as shown in the status menu.
enum DockReaderState: Equatable {
    case disabled
    case accessibilityMissing
    case noDock
    case active

    /// Menu label, in the language the helper picked at launch.
    var label: String {
        switch self {
        case .disabled: return L10n.string(.dockDisabled)
        case .accessibilityMissing: return L10n.string(.dockAccessibilityMissing)
        case .noDock: return L10n.string(.dockNoDock)
        case .active: return L10n.string(.dockActive)
        }
    }
}

/// Reads the Dock's badges through the accessibility API and posts them to the local server.
///
/// Everything here runs on the main thread: `AXUIElement` and `NSWorkspace` are not thread safe,
/// and the timer is scheduled on the main run loop on purpose. The only work that leaves the
/// thread is the `URLSession` upload, which carries a value type.
final class DockBadges {
    /// How often the Dock is read, per the spec.
    private static let interval: TimeInterval = 2
    /// A report is sent at least every other tick, so the server's ten-second staleness window
    /// never closes on a Dock that simply has nothing new to say.
    private static let heartbeatTicks = 2
    /// Icons are rendered at this size and sent once per bundle.
    private static let iconSide = 128
    /// Ceiling on a single AX call, so an unresponsive Dock cannot block the main thread.
    private static let axTimeout: Float = 1

    private let port: Int
    private var timer: Timer?
    private var lastSignature: String?
    /// Ticks since the last report left the helper, for the heartbeat above.
    private var ticksSincePost = 0
    /// True once the server has acknowledged a report: icons are pointless before that.
    private var badgesDelivered = false
    /// Bundles whose icon the server already has, so each one is uploaded once per helper run.
    /// An upload that fails takes its bundle back out, so the next tick tries again.
    private var sentIcons = Set<String>()
    private var running = false
    /// Last value handed to `onState`, so an unchanged state does not redraw the menu.
    private var lastState: DockReaderState?

    var onState: ((DockReaderState) -> Void)?

    init(port: Int) {
        self.port = port
    }

    func start() {
        guard !running else { return }
        running = true
        lastSignature = nil
        ticksSincePost = 0
        badgesDelivered = false
        let timer = Timer(timeInterval: Self.interval, repeats: true) { [weak self] _ in self?.tick() }
        // `.common` so the Dock keeps being read while a menu is open.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        tick()
    }

    func stop() {
        running = false
        timer?.invalidate()
        timer = nil
        sentIcons.removeAll()
        badgesDelivered = false
        report(.disabled)
    }

    /// Announces a state, but only when it actually changed.
    private func report(_ state: DockReaderState) {
        guard state != lastState else { return }
        lastState = state
        onState?(state)
    }

    // MARK: - Reading

    private func tick() {
        guard running else { return }
        // The optional chaining yields `Void?`, so the call cannot be the value of a `return`.
        guard AXIsProcessTrusted() else { report(.accessibilityMissing); return }
        guard let items = readDockItems() else { report(.noDock); return }
        report(.active)

        let apps = DockBadgeParser.parse(items)
        let signature = DockBadgeParser.signature(apps)
        ticksSincePost += 1
        // On change, and as a heartbeat every other tick: the server marks the Dock unavailable
        // after ten seconds of silence, and a quiet Dock is not an absent helper.
        if signature != lastSignature || ticksSincePost >= Self.heartbeatTicks {
            lastSignature = signature
            ticksSincePost = 0
            post(path: "/api/hooks/dock", body: ["apps": apps.map(encode)]) { [weak self] ok in
                if ok { self?.badgesDelivered = true }
            }
        }
        // Icons only once the server has taken a report: it may still be starting up.
        guard badgesDelivered else { return }
        for app in apps where !sentIcons.contains(app.bundleId) {
            guard let png = icon(for: app.bundleId) else { continue }
            // Marked before the upload so a slow one is not started twice, and taken back out
            // below when it fails, so nothing is lost to a server that was not listening yet.
            sentIcons.insert(app.bundleId)
            post(path: "/api/hooks/dock/icon", body: ["bundleId": app.bundleId, "png": png.base64EncodedString()]) { [weak self] ok in
                if !ok { self?.sentIcons.remove(app.bundleId) }
            }
        }
    }

    private func encode(_ app: DockApp) -> [String: Any] {
        ["bundleId": app.bundleId, "name": app.name, "badge": app.badge ?? NSNull(), "running": app.running]
    }

    /// The Dock's accessibility children, or nil when the Dock cannot be reached at all.
    private func readDockItems() -> [RawDockItem]? {
        guard let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return nil }
        let application = AXUIElementCreateApplication(dock.processIdentifier)
        // Without this, a wedged Dock would hang the main thread on the default six-second timeout.
        AXUIElementSetMessagingTimeout(application, Self.axTimeout)
        guard let list = firstChild(of: application, role: kAXListRole) else { return nil }
        guard let children = attribute(list, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
        return children.map { child in
            RawDockItem(
                title: attribute(child, kAXTitleAttribute) as? String,
                statusLabel: attribute(child, "AXStatusLabel") as? String,
                isRunning: (attribute(child, "AXIsApplicationRunning") as? Bool) ?? false,
                bundleIdentifier: bundleIdentifier(of: child)
            )
        }
    }

    private func bundleIdentifier(of element: AXUIElement) -> String? {
        guard let url = attribute(element, "AXURL") as? URL else { return nil }
        return Bundle(url: url)?.bundleIdentifier
    }

    private func firstChild(of element: AXUIElement, role: String) -> AXUIElement? {
        guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
        return children.first { (attribute($0, kAXRoleAttribute) as? String) == role }
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> Any? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private func icon(for bundleId: String) -> Data? {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return nil }
        let image = NSWorkspace.shared.icon(forFile: url.path)
        let side = Self.iconSide
        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return nil }
        representation.size = NSSize(width: side, height: side)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: representation)
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
        NSGraphicsContext.restoreGraphicsState()
        return representation.representation(using: .png, properties: [:])
    }

    // MARK: - Posting

    /// Sends one JSON body. `done` runs on the main thread with whether the server took it,
    /// so the caller can retry on the next tick; the server is allowed to be down.
    private func post(path: String, body: [String: Any], done: ((Bool) -> Void)? = nil) {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)"),
              let data = try? JSONSerialization.data(withJSONObject: body)
        else { done?(false); return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let ok = (200..<300).contains(code)
            // Back to the main thread: everything this class holds is read and written there.
            DispatchQueue.main.async { done?(ok) }
        }.resume()
    }
}
