import AppKit
import Foundation
import FremkitCore
import WebKit

/// Web view with WebKit's native context menu removed; everything else is stock.
private final class AdminNoMenuWebView: WKWebView {
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.removeAllItems()
    }
}

/// Ordinary titled window showing the admin UI, opened from the status menu.
///
/// One instance is kept for the lifetime of the helper: re-opening brings the existing window
/// forward instead of building a second one.
final class AdminWindow: NSObject, NSWindowDelegate, WKUIDelegate {
    private static let size = NSSize(width: 1280, height: 800)

    private var window: NSWindow?
    private var webView: WKWebView?
    private let url: URL
    /// The Edge display's frame in AppKit space, kept in step by the helper as displays come and
    /// go. The kiosk covers it above the status-bar level, so the admin must never sit there.
    var kioskFrame: NSRect?

    init(url: URL) {
        self.url = url
    }

    /// Shows the window, creating it on first use.
    func show() {
        // While the admin is open the helper behaves like a regular app (Dock icon, Cmd+Tab),
        // and an Edit menu gives the web view its standard key equivalents (Cmd+Z, Cmd+C…).
        NSApp.setActivationPolicy(.regular)
        installEditMenuIfNeeded()
        if let window {
            // Checked on every open, not only at creation: the window remembers its frame across
            // launches, so one drag onto the Edge — or a display rearrangement — would otherwise
            // park it under the kiosk for good, focused and invisible.
            rescueIfBuried(window)
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }

        let frame = centredFrame()
        let window = NSWindow(contentRect: frame,
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered,
                              defer: false)
        window.title = L10n.string(.adminWindowTitle)
        window.isReleasedWhenClosed = false
        window.delegate = self
        // Remember size and position across launches; the centred frame is only the first-run default.
        window.setFrameAutosaveName("FremkitAdmin")

        // No context menu here either — the admin is a touch-first panel too — but text
        // interaction stays on: it has fields to type into and values to copy out.
        let webView = AdminNoMenuWebView(frame: NSRect(origin: .zero, size: frame.size))
        webView.allowsLinkPreview = false
        webView.autoresizingMask = [.width, .height]
        // Without a UI delegate a WKWebView silently ignores <input type="file">.
        webView.uiDelegate = self
        webView.load(URLRequest(url: url))
        window.contentView = webView

        self.window = window
        self.webView = webView

        // `setFrameAutosaveName` above restored whatever was saved, which may be the frame that
        // put this window under the kiosk in the first place.
        rescueIfBuried(window)

        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Moves the window back onto a usable screen when its frame is not one. See `AdminPlacement`.
    private func rescueIfBuried(_ window: NSWindow) {
        let screens = NSScreen.screens.map(\.visibleFrame)
        guard let rescued = AdminPlacement.rescue(frame: window.frame,
                                                  size: Self.size,
                                                  screens: screens,
                                                  kiosk: kioskFrame) else { return }
        window.setFrame(rescued, display: false)
    }

    /// Centres the 1280x800 content rect on a screen the kiosk is not covering.
    private func centredFrame() -> NSRect {
        let screens = NSScreen.screens.map(\.visibleFrame)
        guard let screen = AdminPlacement.target(screens: screens, kiosk: kioskFrame)
            ?? NSScreen.main?.visibleFrame else {
            return NSRect(origin: .zero, size: Self.size)
        }
        return AdminPlacement.centred(size: Self.size, in: screen)
    }

    // MARK: - WKUIDelegate

    /// Backs the page's file inputs (background images) with the standard open panel.
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.png, .jpeg, .webP]
        guard let window else { completionHandler(nil); return }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: - NSWindowDelegate

    // The window is only hidden by the close button; keeping it means the next "Open the admin"
    // is instant and does not reload the page.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        // Back to a menu-bar-only app once the admin is hidden.
        NSApp.setActivationPolicy(.accessory)
        return false
    }

    /// Builds the minimal main menu once: an application menu and an Edit menu whose standard
    /// selectors reach the first responder, i.e. the web view.
    private func installEditMenuIfNeeded() {
        guard NSApp.mainMenu == nil else { return }
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L10n.string(.menuHideFremkit), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: L10n.string(.menuQuitFremkit), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: L10n.string(.menuEdit))
        edit.addItem(withTitle: L10n.string(.menuUndo), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: L10n.string(.menuRedo), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(.separator())
        edit.addItem(withTitle: L10n.string(.menuCut), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L10n.string(.menuCopy), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L10n.string(.menuPaste), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L10n.string(.menuSelectAll), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: L10n.string(.menuWindow))
        windowMenu.addItem(withTitle: L10n.string(.menuClose), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: L10n.string(.menuMinimize), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
    }
}
