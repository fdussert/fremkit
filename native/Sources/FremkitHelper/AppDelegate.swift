import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import FremkitCore
import ServiceManagement

/// Wires the config, the Edge display, the touch driver, the mouse fence, the kiosk window,
/// the server supervisor and the status menu together.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var config = HelperConfig.default
    private let poster = EventPoster()
    private var driver: TouchDriver?
    private var fence: MouseFence?
    /// A future window fence can register here and share the dashboard visibility rule.
    private var fenceUpdates: [(Bool) -> Void] = []
    private var dockBadges: DockBadges?
    private var brightness: BrightnessController?
    private var watcher: EdgeDisplay.Watcher?
    private var kiosk: KioskWindow?
    /// The server's access secret: made at launch, presented by everything that talks to the server.
    private var access: ServerAccess?
    private var admin: AdminWindow?
    private var server: ServerProcess?
    private var menu: StatusMenu?
    #if FREMKIT_SPARKLE
    private var updater: Updater?
    #endif
    /// Latest dashboard target bounds (Edge when connected, otherwise the selected ILITEK screen).
    private var dashboardBounds: CGRect?
    /// Polls the Accessibility grant until it lands, so the menu stops claiming it is missing.
    private var accessibilityTimer: Timer?
    /// True once `applicationDidFinishLaunching` has built the windows a URL may want.
    private var ready = false
    /// URL actions that arrived while launching, replayed as soon as everything exists.
    private var pendingActions: [HelperURLAction] = []

    /// Orders the launch prompts: Input Monitoring first when touch needs it, then Accessibility.
    private var permissions = PermissionSequencer(touch: false, fence: false, dock: false)
    /// Polls the Input Monitoring answer while Accessibility waits for it.
    private var permissionTimer: Timer?

    /// Period of the Accessibility re-check, matching the fence's own retry period.
    private static let accessibilityInterval: TimeInterval = 5
    /// Period of the Input Monitoring check while the launch prompts wait on it.
    private static let permissionInterval: TimeInterval = 1

    /// How long `fremkit://reveal` keeps the dashboard behind the other windows.
    private static let revealDuration: TimeInterval = 45

    private static var uptime: TimeInterval { ProcessInfo.processInfo.systemUptime }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        config = Self.loadConfig()
        poster.scrollInvert = config.scrollInvert

        let menu = StatusMenu()
        self.menu = menu
        wireMenu(menu)

        #if FREMKIT_SPARKLE
        // A build without Sparkle's public key (a local build before the owner generated one)
        // could never accept an update, and Sparkle would complain at every launch: no updater.
        if let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String, !key.isEmpty {
            let updater = Updater()
            self.updater = updater
            menu.onCheckForUpdates = { [weak updater] in updater?.checkForUpdates() }
            menu.update { $0.updates = true }
        }
        #endif

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
        fenceUpdates.append { [weak fence] active in
            if active { _ = fence?.start() }
            else { fence?.stop() }
        }

        // Made first: the server, the Dock reader and both web windows present this secret.
        let access = ServerAccess(port: config.port)
        self.access = access

        let dockBadges = DockBadges(port: config.port, access: access)
        dockBadges.onState = { [weak self] state in
            self?.menu?.update { $0.dock = state }
        }
        self.dockBadges = dockBadges

        let brightness = BrightnessController(port: config.port, access: access, kioskURL: URL(string: config.url))
        brightness.onMenuState = { [weak self] state in
            self?.menu?.update { $0.brightness = state }
        }
        menu.onBrightness = { [weak brightness] level in brightness?.setFromMenu(level) }
        self.brightness = brightness

        admin = AdminWindow(url: Self.parseURL(config.adminUrl, what: "adminUrl"), access: access)

        let server = ServerProcess(config: config, access: access)
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

        // Accessibility is needed to post the synthetic events the touch driver generates, not
        // just to create the fence tap, so it is asked at launch whatever the fence setting is —
        // but after Input Monitoring when touch still needs that one: see `PermissionSequencer`.
        // The sequencer also starts the touch driver.
        permissions = PermissionSequencer(touch: config.touch, fence: config.fence, dock: config.dock)
        performPermissions(permissions.begin(inputMonitoring: Permissions.inputMonitoring, now: Self.uptime))
        if permissions.isWaiting { startPermissionSequence() }
        syncFences()
        if config.dock { dockBadges.start() }
        brightness.start()

        // An orphan from a crashed helper still holds the port and would be mistaken for an
        // external dev server, so clear it before anything probes.
        server.reapOrphan()

        if config.manageServer {
            server.start()
        } else {
            // Not managing, but the menu should still say whether something answers the port.
            let port = config.port
            server.probe { [weak self] verdict in
                guard verdict != .absent else { return }
                self?.menu?.update { $0.server = verdict == .ours ? .external : .foreign(port) }
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
        case .reveal: kiosk?.reveal(for: Self.revealDuration)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        accessibilityTimer?.invalidate()
        accessibilityTimer = nil
        permissionTimer?.invalidate()
        permissionTimer = nil
        server?.stopAndWait(timeout: 2)
        driver?.stop()
        fence?.stop()
        dockBadges?.stop()
        brightness?.stop()
        kiosk?.close()
    }

    // MARK: - Permissions

    private func performPermissions(_ actions: [PermissionSequencer.Action]) {
        for action in actions {
            switch action {
            case .requestInputMonitoring:
                Permissions.requestInputMonitoring()
                // The driver is not started until the answer is in; say what it is waiting for.
                menu?.update { $0.touch = .notPermitted }
            case .requestAccessibility:
                Permissions.requestAccessibility()
            case .startTouch:
                // The menu may have switched touch off while the prompt was up.
                if config.touch { driver?.start() }
            }
        }
    }

    /// Waits for the Input Monitoring answer, then lets the sequencer ask for Accessibility.
    private func startPermissionSequence() {
        // `.common` so the check keeps ticking while a menu is being tracked.
        let timer = Timer(timeInterval: Self.permissionInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.performPermissions(self.permissions.poll(inputMonitoring: Permissions.inputMonitoring, now: Self.uptime))
            guard !self.permissions.isWaiting else { return }
            self.permissionTimer?.invalidate()
            self.permissionTimer = nil
            self.refreshMenu()
        }
        RunLoop.main.add(timer, forMode: .common)
        permissionTimer = timer
    }

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

    /// Quits the normal way (the server is stopped in `applicationWillTerminate`) and has a
    /// detached shell open the bundle again once this process is gone.
    private static func relaunch() {
        let bundle = Bundle.main.bundleURL
        guard bundle.pathExtension == "app" else {
            // A bare executable has no bundle to reopen; quitting is all that can be done.
            NSApp.terminate(nil)
            return
        }
        let command = Relaunch.command(waitingFor: ProcessInfo.processInfo.processIdentifier, bundlePath: bundle.path)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.executable)
        process.arguments = command.arguments
        do {
            try process.run()
        } catch {
            FileHandle.standardError.write(Data("fremkit: cannot relaunch: \(error)\n".utf8))
        }
        NSApp.terminate(nil)
    }

    // MARK: - Diagnostics

    /// The server's report and the helper's own facts, on the pasteboard. The server's part is
    /// fetched with the access secret; when it does not answer, the helper's part goes alone.
    private func copyDiagnostics() {
        guard let access else { return }
        access.diagnostics { [weak self] part in
            guard let self else { return }
            let text = self.helperDiagnostics().report(server: part)
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
            self.menu?.diagnosticsCopied()
        }
    }

    private func helperDiagnostics() -> HelperDiagnostics {
        let state = menu?.current ?? MenuState()
        let info = Bundle.main.infoDictionary ?? [:]
        let grant: (PermissionStatus) -> HelperDiagnostics.Grant = {
            switch $0 {
            case .granted: return .granted
            case .denied: return .denied
            case .unknown: return .unknown
            }
        }
        let brightness: String
        switch state.brightness {
        case let .level(level): brightness = "available, level \(level) %"
        case .unavailable(.brightnessNoDDC): brightness = "not adjustable (no DDC)"
        case .unavailable(.brightnessAmbiguous): brightness = "display not identified for sure"
        case .unavailable: brightness = "no display"
        }
        let server: String
        switch state.server {
        case .external: server = "external"
        case .starting: server = "starting"
        case .running: server = "running"
        case .stopped: server = "stopped"
        case let .restarting(seconds): server = "restarting in \(seconds) s"
        case let .foreign(port): server = "port \(port) held by another program"
        }
        let fence: String
        switch state.fence {
        case .off: fence = "off"
        case .active: fence = "active"
        case .missingPermission: fence = "Accessibility missing"
        }
        let dock: String
        switch state.dock {
        case .disabled: dock = "disabled"
        case .accessibilityMissing: dock = "Accessibility missing"
        case .noDock: dock = "Dock not found"
        case .active: dock = "active"
        }
        return HelperDiagnostics(
            version: info["CFBundleShortVersionString"] as? String ?? "unknown",
            build: info["CFBundleVersion"] as? String ?? "unknown",
            launch: config.repoPath.map { $0.isEmpty ? "app" : "checkout" } ?? "app",
            server: server,
            touch: state.touch.description,
            inputMonitoring: grant(Permissions.inputMonitoring),
            accessibility: AXIsProcessTrusted() ? .granted : .denied,
            kioskDisplay: dashboardBounds.map { (Int($0.width), Int($0.height)) },
            kioskWindow: kiosk != nil,
            brightness: brightness,
            fence: fence,
            dock: dock,
            manageServer: config.manageServer)
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

    // Cmd-H temporarily hides the app without changing the user's dashboard preference.
    func applicationDidHide(_ notification: Notification) { kiosk?.applicationDidHide() }
    func applicationDidUnhide(_ notification: Notification) { kiosk?.applicationDidUnhide() }

    private func syncFences() {
        let active = config.fence && kiosk?.isShowingDashboard == true
        for update in fenceUpdates { update(active) }
    }

    private func refreshDashboardMenu() {
        menu?.update { state in
            state.dashboardAvailable = dashboardBounds != nil && kiosk != nil
            state.dashboardHidden = kiosk?.isHiddenByUser == true
        }
    }

    private func edgeDidChange(_ edge: CGRect?) {
        let ilitek = ILITEKDisplayTarget.bounds(fallbackSize: CGSize(width: config.display.width, height: config.display.height))
        let profiles = TouchDriver.connectedProfiles()
        let profile = TouchHardwareProfile.preferred(edgeDevice: profiles.contains(.edge),
                                                     edgeTarget: edge != nil,
                                                     ilitekDevice: profiles.contains(.ilitek),
                                                     ilitekTarget: ilitek != nil) ?? .edge
        let target = TouchHardwareProfile.target(for: profile, edge: edge, ilitek: ilitek)
        dashboardBounds = target
        driver?.use(profile)
        driver?.displayBounds = target
        fence?.edge = target
        brightness?.displayDidChange(edge == nil ? nil : EdgeDisplay.findID(width: config.display.width, height: config.display.height))

        if let target {
            let frame = NSRect.fromCGDisplayBounds(target, primaryHeight: NSRect.primaryScreenHeight)
            // The admin window must never open where the kiosk is: the kiosk sits above the
            // status-bar level, so a window on that display is focused and invisible.
            admin?.kioskFrame = frame
            if let kiosk {
                kiosk.setEdgeFrame(target)
            } else if let access {
                let url = Self.parseURL(config.url, what: "url")
                kiosk = KioskWindow(frame: frame, url: url, access: access)
                kiosk?.onVisibilityChange = { [weak self] in
                    self?.syncFences()
                    self?.refreshDashboardMenu()
                }
            }
        } else {
            admin?.kioskFrame = nil
            kiosk?.setEdgeFrame(nil)
        }
        syncFences()
        refreshDashboardMenu()
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
        menu.onToggleDashboard = { [weak self] in
            guard let self, self.dashboardBounds != nil, let kiosk = self.kiosk else { return }
            if kiosk.isHiddenByUser { kiosk.showDashboard() }
            else { kiosk.hideDashboard() }
        }
        menu.onOpenAdmin = { [weak self] in self?.admin?.show() }

        // The browser has a cookie jar of its own: it is handed a one-time sign-in link instead.
        // Without one — nothing on the port proved it is our server — nothing opens: the plain
        // address would show whatever holds the port, and the server line says what is wrong.
        menu.onOpenAdminInBrowser = { [weak self] in
            guard let self, let access = self.access else { return }
            let admin = Self.parseURL(self.config.adminUrl, what: "adminUrl")
            access.signInURL(for: admin) { url in
                guard let url else { NSSound.beep(); return }
                NSWorkspace.shared.open(url)
            }
        }

        menu.onReload = { [weak self] in self?.kiosk?.reload() }

        menu.onToggleTouch = { [weak self] on in
            guard let self else { return }
            self.config.touch = on
            self.saveConfig()
            if on {
                // Touch switched on after launch: the launch sequence did not ask for Input
                // Monitoring, so ask now. Accessibility was asked at launch, so no prompt clashes.
                if Permissions.inputMonitoring == .unknown { Permissions.requestInputMonitoring() }
                self.driver?.start()
            } else {
                self.driver?.stop()
            }
            // The driver reports only changes; resync in case the menu showed the launch wait.
            if let driver = self.driver { self.menu?.update { $0.touch = driver.state } }
            self.refreshMenu()
        }

        menu.onToggleFence = { [weak self] on in
            guard let self else { return }
            self.config.fence = on
            self.saveConfig()
            self.syncFences()
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
        menu.onCopyDiagnostics = { [weak self] in self?.copyDiagnostics() }

        menu.onFix = { [weak self] fix in
            switch fix {
            case let .openPrivacyPane(pane):
                // Asking again is what puts the app in the pane's list when a lost first request
                // left it out, so there is a switch to turn on once Settings opens.
                switch pane {
                case .inputMonitoring:
                    Permissions.requestInputMonitoring()
                case .accessibility:
                    // Not while the Input Monitoring prompt may still be up: that is the very
                    // clash the launch sequence avoids. The sequencer asks right after anyway.
                    if self?.permissions.isWaiting != true { Permissions.requestAccessibility() }
                }
                NSWorkspace.shared.open(pane.url)
            case .openLoginItems:
                SMAppService.openSystemSettingsLoginItems()
            case .relaunch:
                Self.relaunch()
            }
        }

        menu.onQuit = {
            NSApp.terminate(nil)
        }
    }
}
