import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import FremkitCore

/// Wires the config, the Edge display, the touch driver, the mouse fence, the kiosk window,
/// the server supervisor and the status menu together.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var config = HelperConfig.default
    private let poster = EventPoster()
    private var driver: TouchDriver?
    private var fence: MouseFence?
    private var dockBadges: DockBadges?
    private var watcher: EdgeDisplay.Watcher?
    private var kiosk: KioskWindow?
    private var admin: AdminWindow?
    private var server: ServerProcess?
    private var menu: StatusMenu?
    /// Latest Edge bounds, kept so the kiosk window can be created lazily when it appears.
    private var edge: CGRect?
    /// Polls the Accessibility grant until it lands, so the menu stops claiming it is missing.
    private var accessibilityTimer: Timer?
    /// True once `applicationDidFinishLaunching` has built the windows a URL may want.
    private var ready = false
    /// URL actions that arrived while launching, replayed as soon as everything exists.
    private var pendingActions: [HelperURLAction] = []

    /// Period of the Accessibility re-check, matching the fence's own retry period.
    private static let accessibilityInterval: TimeInterval = 5

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        config = Self.loadConfig()
        poster.scrollInvert = config.scrollInvert

        // Accessibility is needed to post the synthetic events the touch driver generates, not
        // just to create the fence tap, so ask for it once at launch whatever the fence setting is.
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)

        let menu = StatusMenu()
        self.menu = menu
        wireMenu(menu)

        let driver = TouchDriver(poster: poster)
        driver.onState = { [weak self] state in
            self?.menu?.update { $0.touch = state }
        }
        self.driver = driver

        let fence = MouseFence(edge: nil)
        fence.onStateChange = { [weak self] state in
            self?.menu?.update { $0.fence = state }
        }
        self.fence = fence

        let dockBadges = DockBadges(port: config.port)
        dockBadges.onState = { [weak self] state in
            self?.menu?.update { $0.dock = state }
        }
        self.dockBadges = dockBadges

        admin = AdminWindow(url: Self.parseURL(config.adminUrl, what: "adminUrl"))

        let server = ServerProcess(config: config)
        server.onStateChange = { [weak self] state in
            self?.serverDidChange(state)
        }
        self.server = server

        LaunchAtLogin.onFailure = { [weak self] failed in
            self?.menu?.update { $0.loginFailed = failed }
        }

        // Fires immediately, so the first callback sets the initial Edge bounds.
        watcher = EdgeDisplay.Watcher(width: config.display.width, height: config.display.height) { [weak self] edge in
            self?.edgeDidChange(edge)
        }

        if config.touch { driver.start() }
        if config.fence { fence.start() }
        if config.dock { dockBadges.start() }

        // An orphan from a crashed helper still holds the port and would be mistaken for an
        // external dev server, so clear it before anything probes.
        server.reapOrphan()

        if config.manageServer {
            server.start()
        } else {
            // Not managing, but the menu should still say whether something answers the port.
            server.probe { [weak self] alive in
                guard alive else { return }
                self?.menu?.update { $0.server = .external }
            }
        }

        refreshMenu()
        startAccessibilityWatch()

        // A launch triggered by `open fremkit://admin` delivers the URL before this point, when
        // there was no admin window to show it in; those actions run now.
        ready = true
        let queued = pendingActions
        pendingActions = []
        for action in queued { perform(action) }
    }

    // MARK: - URL scheme

    /// `fremkit://…`, sent by the dashboard through the server so a long press on the page dots
    /// can reach the helper. What a URL means is decided by `HelperURL`, which knows a closed
    /// list of actions and ignores everything else.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let action = HelperURL.action(for: url) else { continue }
            if ready { perform(action) } else { pendingActions.append(action) }
        }
    }

    private func perform(_ action: HelperURLAction) {
        switch action {
        case .openAdmin: admin?.show()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        accessibilityTimer?.invalidate()
        accessibilityTimer = nil
        server?.stopAndWait(timeout: 2)
        driver?.stop()
        fence?.stop()
        dockBadges?.stop()
        kiosk?.close()
    }

    // MARK: - Permissions

    /// Re-checks the Accessibility grant every few seconds until it is granted, so the touch line
    /// stops warning about it as soon as the user comes back from System Settings.
    private func startAccessibilityWatch() {
        guard !AXIsProcessTrusted() else { return }
        // `.common` so the check keeps ticking while a menu is being tracked.
        let timer = Timer(timeInterval: Self.accessibilityInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.refreshMenu()
            guard AXIsProcessTrusted() else { return }
            self.accessibilityTimer?.invalidate()
            self.accessibilityTimer = nil
        }
        RunLoop.main.add(timer, forMode: .common)
        accessibilityTimer = timer
    }

    // MARK: - Config

    /// Turns a configured string into a URL, naming the offending value before falling back.
    private static func parseURL(_ string: String, what: String) -> URL {
        if let url = URL(string: string) { return url }
        FileHandle.standardError.write(Data("fremkit: invalid \(what) in config: \(string)\n".utf8))
        return URL(fileURLWithPath: "/")
    }

    private static func loadConfig() -> HelperConfig {
        let url = HelperConfig.defaultURL
        if !FileManager.default.fileExists(atPath: url.path) {
            try? HelperConfig.default.save(to: url)
            return .default
        }
        return HelperConfig.load(from: url)
    }

    private func saveConfig() {
        do {
            try config.save(to: HelperConfig.defaultURL)
        } catch {
            FileHandle.standardError.write(Data("fremkit: cannot save config: \(error)\n".utf8))
        }
    }

    // MARK: - Display

    private func edgeDidChange(_ edge: CGRect?) {
        self.edge = edge
        driver?.displayBounds = edge
        fence?.edge = edge

        if let edge {
            let frame = NSRect.fromCGDisplayBounds(edge, primaryHeight: NSRect.primaryScreenHeight)
            // The admin window must never open where the kiosk is: the kiosk sits above the
            // status-bar level, so a window on that display is focused and invisible.
            admin?.kioskFrame = frame
            if let kiosk {
                kiosk.setEdgeFrame(edge)
            } else {
                let url = Self.parseURL(config.url, what: "url")
                kiosk = KioskWindow(frame: frame, url: url)
            }
        } else {
            admin?.kioskFrame = nil
            kiosk?.setEdgeFrame(nil)
        }
    }

    // MARK: - Server

    private func serverDidChange(_ state: ServerState) {
        menu?.update { $0.server = state }
        // The dashboard may have failed to load while the port was dead; try again now.
        if state == .running || state == .external { kiosk?.reload() }
    }

    // MARK: - Menu

    private func refreshMenu() {
        menu?.update { state in
            state.touchEnabled = config.touch
            state.fenceEnabled = config.fence
            state.dockEnabled = config.dock
            state.manageServer = config.manageServer
            state.launchAtLogin = LaunchAtLogin.isEnabled
            state.loginNeedsApproval = LaunchAtLogin.needsApproval
            state.accessibility = AXIsProcessTrusted()
        }
    }

    private func wireMenu(_ menu: StatusMenu) {
        menu.onOpenAdmin = { [weak self] in self?.admin?.show() }

        menu.onOpenAdminInBrowser = { [weak self] in
            guard let self else { return }
            NSWorkspace.shared.open(Self.parseURL(self.config.adminUrl, what: "adminUrl"))
        }

        menu.onReload = { [weak self] in self?.kiosk?.reload() }

        menu.onToggleTouch = { [weak self] on in
            guard let self else { return }
            self.config.touch = on
            self.saveConfig()
            if on { self.driver?.start() } else { self.driver?.stop() }
            self.refreshMenu()
        }

        menu.onToggleFence = { [weak self] on in
            guard let self else { return }
            self.config.fence = on
            self.saveConfig()
            if on { self.fence?.start() } else { self.fence?.stop() }
            self.refreshMenu()
        }

        menu.onToggleDock = { [weak self] on in
            guard let self else { return }
            self.config.dock = on
            self.saveConfig()
            if on { self.dockBadges?.start() } else { self.dockBadges?.stop() }
            self.refreshMenu()
        }

        menu.onToggleManageServer = { [weak self] on in
            guard let self else { return }
            self.config.manageServer = on
            self.saveConfig()
            self.server?.setManaged(on)
            self.refreshMenu()
        }

        menu.onToggleLaunchAtLogin = { [weak self] on in
            guard let self else { return }
            let reached = LaunchAtLogin.set(on)
            self.config.launchAtLogin = reached
            self.saveConfig()
            self.refreshMenu()
        }

        menu.onOpenLog = {
            NSWorkspace.shared.open(ServerProcess.logURL)
        }

        menu.onQuit = {
            NSApp.terminate(nil)
        }
    }
}
