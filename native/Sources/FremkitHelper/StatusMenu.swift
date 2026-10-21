import AppKit
import Foundation
import FremkitCore

/// Everything the menu displays, handed over by the delegate on each rebuild.
struct MenuState {
    var dashboardAvailable = false
    var dashboardHidden = false
    var server: ServerState = .stopped
    var touch: TouchState = .disabled
    /// What the fence is really doing, as opposed to what the config asks for.
    var fence: FenceState = .off
    /// Whether Accessibility is granted; synthetic events need it, not just the fence.
    var accessibility = true
    var touchEnabled = false
    var fenceEnabled = false
    /// What the Dock reader is really doing, as opposed to what the config asks for.
    var dock: DockReaderState = .disabled
    var dockEnabled = false
    var manageServer = false
    var launchAtLogin = false
    /// True when registering the login item last failed. The detail goes to the log, not the menu.
    var loginFailed = false
    /// True when the login item is registered but still waiting for approval in System Settings.
    var loginNeedsApproval = false
    /// True in the app, which updates itself; the developer helper has no updater to offer.
    var updates = false
    /// The kiosk display's brightness, or why it cannot be set.
    var brightness: BrightnessMenuState = .unavailable(.brightnessUnavailable)

    /// The text of the touch line, which also decides whether clicking it fixes something.
    var touchKey: L10nKey {
        switch touch {
        case .active:
            // The driver is reading the panel, but without Accessibility nothing it posts lands.
            return accessibility ? .touchActive : .touchAccessibilityMissing
        case .notPermitted: return .touchNotPermitted
        case .needsRelaunch: return .touchNeedsRelaunch
        case .busy(.exclusiveAccess): return .touchBusy
        case .busy(.siblingSeizeFailed): return .touchBusy
        case .busy(.openFailed): return .touchOpenFailed
        case .noDisplay: return .touchNoDisplay
        case .disabled: return .touchDisabled
        }
    }

    /// Touch line label, in the language the helper picked at launch.
    var touchLabel: String {
        if case let .busy(.openFailed(code)) = touch { return L10n.string(.touchOpenFailed, code) }
        return L10n.string(touchKey)
    }
}

/// The menu bar item and its menu.
///
/// The menu is built once; every state change only edits the titles, the enabled flags, the
/// checkmarks and the visibility of the items already in place, so the menu keeps its identity
/// (and stays usable while it is open) instead of being swapped out from under the user.
///
/// The menu owns no logic: every item calls back into a closure the `AppDelegate` sets.
final class StatusMenu: NSObject {
    private let item: NSStatusItem
    private var state = MenuState()

    // Status lines. They are disabled, except while one reports a missing permission: it can then
    // be clicked to open the place in System Settings that grants it (`PermissionFix`). The last
    // three are hidden unless they have something to say.
    private let dashboardToggle = NSMenuItem()
    private let serverLine = NSMenuItem()
    private let touchLine = NSMenuItem()
    private let fenceLine = NSMenuItem()
    private let dockLine = NSMenuItem()
    private let loginFailedLine = NSMenuItem()
    private let loginApprovalLine = NSMenuItem()

    // Toggles, whose checkmark follows the config flags.
    private let touchToggle: NSMenuItem
    private let fenceToggle: NSMenuItem
    private let dockToggle: NSMenuItem
    private let manageServerToggle: NSMenuItem
    private let launchAtLoginToggle: NSMenuItem
    private let checkForUpdatesItem = NSMenuItem()
    private let copyDiagnosticsItem = NSMenuItem()
    /// A title line and a slider, as one custom view: a menu item cannot hold a slider otherwise.
    private let brightnessItem = NSMenuItem()
    private let brightnessLabel = NSTextField(labelWithString: "")
    private let brightnessSlider = NSSlider(value: 50, minValue: 0, maxValue: 100, target: nil, action: nil)

    var onOpenAdmin: (() -> Void)?
    var onOpenAdminInBrowser: (() -> Void)?
    var onReload: (() -> Void)?
    var onToggleDashboard: (() -> Void)?
    var onToggleTouch: ((Bool) -> Void)?
    var onToggleFence: ((Bool) -> Void)?
    var onToggleDock: ((Bool) -> Void)?
    var onToggleManageServer: ((Bool) -> Void)?
    var onToggleLaunchAtLogin: ((Bool) -> Void)?
    var onOpenLog: (() -> Void)?
    var onCopyDiagnostics: (() -> Void)?
    var onCheckForUpdates: (() -> Void)?
    var onFix: ((PermissionFix) -> Void)?
    var onQuit: (() -> Void)?
    /// The slider moved; called continuously while it is dragged (the controller throttles).
    var onBrightness: ((Int) -> Void)?

    /// The fix each clickable status line currently offers, looked up when it is clicked.
    private var fixes: [ObjectIdentifier: PermissionFix] = [:]

    override init() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        touchToggle = NSMenuItem(title: L10n.string(.toggleTouch), action: #selector(toggleTouch), keyEquivalent: "")
        fenceToggle = NSMenuItem(title: L10n.string(.toggleFence), action: #selector(toggleFence), keyEquivalent: "")
        dockToggle = NSMenuItem(title: L10n.string(.toggleDock), action: #selector(toggleDock), keyEquivalent: "")
        manageServerToggle = NSMenuItem(title: L10n.string(.toggleManageServer), action: #selector(toggleManageServer), keyEquivalent: "")
        launchAtLoginToggle = NSMenuItem(title: L10n.string(.toggleLaunchAtLogin), action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        super.init()

        if let glyph = StatusMenu.menuBarGlyph() {
            item.button?.image = glyph
        } else {
            item.button?.title = "F"
        }
        item.menu = build()
        apply()
    }

    /// The Fremkit glyph for the menu bar, or nil when the resources are missing.
    ///
    /// The bundle ships the black-on-transparent template PNGs at 1x and 2x. Both describe the
    /// same 18 pt glyph and only differ in pixel count, so both representations are given that
    /// point size and AppKit picks the 2x file on a Retina menu bar. `isTemplate` is what lets
    /// macOS tint the glyph for the current menu bar theme instead of drawing it flat black.
    private static func menuBarGlyph() -> NSImage? {
        let size = NSSize(width: 18, height: 18)
        let reps = ["fremkitTemplate", "fremkitTemplate@2x"].compactMap { name -> NSImageRep? in
            guard let url = Bundle.main.url(forResource: name, withExtension: "png") else { return nil }
            guard let rep = NSImageRep(contentsOf: url) else { return nil }
            rep.size = size
            return rep
        }
        guard !reps.isEmpty else { return nil }
        let image = NSImage(size: size)
        reps.forEach(image.addRepresentation)
        image.isTemplate = true
        return image
    }

    /// Replaces the current state and redraws the menu.
    func update(_ state: MenuState) {
        self.state = state
        apply()
    }

    /// What the menu shows right now, for the diagnostics report.
    var current: MenuState { state }

    /// Says on the menu item that the report is on the pasteboard, for a few seconds: the menu
    /// is closed by the click, so this is what the user sees when they open it again to check.
    func diagnosticsCopied() {
        copyDiagnosticsItem.title = L10n.string(.diagnosticsCopied)
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            self?.copyDiagnosticsItem.title = L10n.string(.copyDiagnostics)
        }
    }

    /// Edits the current state in place, then redraws.
    func update(_ mutate: (inout MenuState) -> Void) {
        mutate(&state)
        apply()
    }

    // MARK: - Construction

    private func build() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false

        for line in [serverLine, touchLine, fenceLine, dockLine, loginFailedLine, loginApprovalLine] {
            line.isEnabled = false
            line.target = self
            line.action = #selector(fix(_:))
            menu.addItem(line)
        }
        fenceLine.title = L10n.string(.fenceMissingPermission)
        loginFailedLine.title = L10n.string(.loginFailed)
        loginApprovalLine.title = L10n.string(.loginNeedsApproval)
        menu.addItem(.separator())

        menu.addItem(actionItem(L10n.string(.openAdmin), #selector(openAdmin)))
        menu.addItem(actionItem(L10n.string(.openAdminInBrowser), #selector(openAdminInBrowser)))
        dashboardToggle.target = self
        dashboardToggle.action = #selector(toggleDashboard)
        menu.addItem(dashboardToggle)
        menu.addItem(actionItem(L10n.string(.reloadDashboard), #selector(reload)))
        menu.addItem(.separator())

        brightnessItem.view = brightnessView()
        menu.addItem(brightnessItem)
        menu.addItem(.separator())

        for toggle in [touchToggle, fenceToggle, dockToggle, manageServerToggle, launchAtLoginToggle] {
            toggle.target = self
            toggle.isEnabled = true
            menu.addItem(toggle)
        }
        menu.addItem(.separator())

        menu.addItem(actionItem(L10n.string(.openLog), #selector(openLog)))
        copyDiagnosticsItem.title = L10n.string(.copyDiagnostics)
        copyDiagnosticsItem.action = #selector(copyDiagnostics)
        copyDiagnosticsItem.target = self
        copyDiagnosticsItem.isEnabled = true
        menu.addItem(copyDiagnosticsItem)
        checkForUpdatesItem.title = L10n.string(.checkForUpdates)
        checkForUpdatesItem.action = #selector(checkForUpdates)
        checkForUpdatesItem.target = self
        checkForUpdatesItem.isEnabled = true
        menu.addItem(checkForUpdatesItem)
        let quit = actionItem(L10n.string(.quit), #selector(quit))
        quit.keyEquivalent = "q"
        menu.addItem(quit)

        return menu
    }

    private func brightnessView() -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 260, height: 50))
        brightnessLabel.frame = NSRect(x: 20, y: 28, width: 230, height: 17)
        brightnessLabel.font = .menuFont(ofSize: 0)
        brightnessLabel.textColor = .secondaryLabelColor
        brightnessSlider.frame = NSRect(x: 18, y: 4, width: 224, height: 22)
        brightnessSlider.isContinuous = true
        brightnessSlider.target = self
        brightnessSlider.action = #selector(brightnessMoved)
        view.addSubview(brightnessLabel)
        view.addSubview(brightnessSlider)
        return view
    }

    private func actionItem(_ title: String, _ action: Selector) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: "")
        menuItem.target = self
        menuItem.isEnabled = true
        return menuItem
    }

    // MARK: - State

    private func apply() {
        dashboardToggle.title = L10n.string(state.dashboardHidden ? .showDashboard : .hideDashboard)
        dashboardToggle.isEnabled = state.dashboardAvailable
        serverLine.title = state.server.label
        touchLine.title = state.touchLabel
        offer(touchLine, PermissionFix.forLine(state.touchKey))
        fenceLine.isHidden = state.fence != .missingPermission
        offer(fenceLine, PermissionFix.forLine(.fenceMissingPermission))
        dockLine.title = state.dock.label
        offer(dockLine, PermissionFix.forLine(state.dock.key))
        loginFailedLine.isHidden = !state.loginFailed
        loginApprovalLine.isHidden = !state.loginNeedsApproval
        offer(loginApprovalLine, PermissionFix.forLine(.loginNeedsApproval))
        checkForUpdatesItem.isHidden = !state.updates

        switch state.brightness {
        case let .level(level):
            brightnessLabel.stringValue = L10n.string(.brightnessLevel, level)
            brightnessSlider.isEnabled = true
            // Not while the user is dragging it: the echo of their own move would fight them.
            if !brightnessDragging { brightnessSlider.integerValue = level }
        case let .unavailable(key):
            brightnessLabel.stringValue = L10n.string(key)
            brightnessSlider.isEnabled = false
        }

        touchToggle.state = state.touchEnabled ? .on : .off
        fenceToggle.state = state.fenceEnabled ? .on : .off
        dockToggle.state = state.dockEnabled ? .on : .off
        manageServerToggle.state = state.manageServer ? .on : .off
        launchAtLoginToggle.state = state.launchAtLogin ? .on : .off
    }

    /// Makes a status line clickable when it has a fix to offer, and inert otherwise.
    private func offer(_ line: NSMenuItem, _ fix: PermissionFix?) {
        fixes[ObjectIdentifier(line)] = fix
        line.isEnabled = fix != nil
    }

    // MARK: - Actions

    @objc private func fix(_ sender: NSMenuItem) {
        guard let fix = fixes[ObjectIdentifier(sender)] else { return }
        onFix?(fix)
    }

    @objc private func openAdmin() { onOpenAdmin?() }
    @objc private func openAdminInBrowser() { onOpenAdminInBrowser?() }
    @objc private func reload() { onReload?() }
    @objc private func toggleDashboard() { onToggleDashboard?() }
    @objc private func openLog() { onOpenLog?() }
    @objc private func copyDiagnostics() { onCopyDiagnostics?() }
    @objc private func checkForUpdates() { onCheckForUpdates?() }
    @objc private func quit() { onQuit?() }

    private var brightnessDragging = false
    @objc private func brightnessMoved() {
        let event = NSApp.currentEvent
        brightnessDragging = event?.type == .leftMouseDragged || event?.type == .leftMouseDown
        brightnessLabel.stringValue = L10n.string(.brightnessLevel, brightnessSlider.integerValue)
        onBrightness?(brightnessSlider.integerValue)
    }

    @objc private func toggleTouch() { onToggleTouch?(!state.touchEnabled) }
    @objc private func toggleFence() { onToggleFence?(!state.fenceEnabled) }
    @objc private func toggleDock() { onToggleDock?(!state.dockEnabled) }
    @objc private func toggleManageServer() { onToggleManageServer?(!state.manageServer) }
    @objc private func toggleLaunchAtLogin() { onToggleLaunchAtLogin?(!state.launchAtLogin) }
}
