import AppKit
import Foundation
import FremkitCore

/// Everything the menu displays, handed over by the delegate on each rebuild.
struct MenuState {
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

    /// Touch line label, in the language the helper picked at launch.
    var touchLabel: String {
        switch touch {
        case .active:
            // The driver is reading the panel, but without Accessibility nothing it posts lands.
            return L10n.string(accessibility ? .touchActive : .touchAccessibilityMissing)
        case .notPermitted: return L10n.string(.touchNotPermitted)
        case .busy(.exclusiveAccess): return L10n.string(.touchBusy)
        case let .busy(.openFailed(code)): return L10n.string(.touchOpenFailed, code)
        case .noDisplay: return L10n.string(.touchNoDisplay)
        case .disabled: return L10n.string(.touchDisabled)
        }
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

    // Status lines, all disabled; the last three are hidden unless they have something to say.
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

    var onOpenAdmin: (() -> Void)?
    var onOpenAdminInBrowser: (() -> Void)?
    var onReload: (() -> Void)?
    var onToggleTouch: ((Bool) -> Void)?
    var onToggleFence: ((Bool) -> Void)?
    var onToggleDock: ((Bool) -> Void)?
    var onToggleManageServer: ((Bool) -> Void)?
    var onToggleLaunchAtLogin: ((Bool) -> Void)?
    var onOpenLog: (() -> Void)?
    var onQuit: (() -> Void)?

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
            menu.addItem(line)
        }
        fenceLine.title = L10n.string(.fenceMissingPermission)
        loginFailedLine.title = L10n.string(.loginFailed)
        loginApprovalLine.title = L10n.string(.loginNeedsApproval)
        menu.addItem(.separator())

        menu.addItem(actionItem(L10n.string(.openAdmin), #selector(openAdmin)))
        menu.addItem(actionItem(L10n.string(.openAdminInBrowser), #selector(openAdminInBrowser)))
        menu.addItem(actionItem(L10n.string(.reloadDashboard), #selector(reload)))
        menu.addItem(.separator())

        for toggle in [touchToggle, fenceToggle, dockToggle, manageServerToggle, launchAtLoginToggle] {
            toggle.target = self
            toggle.isEnabled = true
            menu.addItem(toggle)
        }
        menu.addItem(.separator())

        menu.addItem(actionItem(L10n.string(.openLog), #selector(openLog)))
        let quit = actionItem(L10n.string(.quit), #selector(quit))
        quit.keyEquivalent = "q"
        menu.addItem(quit)

        return menu
    }

    private func actionItem(_ title: String, _ action: Selector) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: "")
        menuItem.target = self
        menuItem.isEnabled = true
        return menuItem
    }

    // MARK: - State

    private func apply() {
        serverLine.title = state.server.label
        touchLine.title = state.touchLabel
        fenceLine.isHidden = state.fence != .missingPermission
        dockLine.title = state.dock.label
        loginFailedLine.isHidden = !state.loginFailed
        loginApprovalLine.isHidden = !state.loginNeedsApproval

        touchToggle.state = state.touchEnabled ? .on : .off
        fenceToggle.state = state.fenceEnabled ? .on : .off
        dockToggle.state = state.dockEnabled ? .on : .off
        manageServerToggle.state = state.manageServer ? .on : .off
        launchAtLoginToggle.state = state.launchAtLogin ? .on : .off
    }

    // MARK: - Actions

    @objc private func openAdmin() { onOpenAdmin?() }
    @objc private func openAdminInBrowser() { onOpenAdminInBrowser?() }
    @objc private func reload() { onReload?() }
    @objc private func openLog() { onOpenLog?() }
    @objc private func quit() { onQuit?() }

    @objc private func toggleTouch() { onToggleTouch?(!state.touchEnabled) }
    @objc private func toggleFence() { onToggleFence?(!state.fenceEnabled) }
    @objc private func toggleDock() { onToggleDock?(!state.dockEnabled) }
    @objc private func toggleManageServer() { onToggleManageServer?(!state.manageServer) }
    @objc private func toggleLaunchAtLogin() { onToggleLaunchAtLogin?(!state.launchAtLogin) }
}
