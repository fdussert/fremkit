import AppKit
import CoreGraphics
import FremkitCore
import Foundation
import WebKit

extension NSRect {
    /// Converts display bounds from CoreGraphics global space to AppKit screen space.
    ///
    /// `CGDisplayBounds` uses a top-left origin growing downwards, while `NSWindow` frames use a
    /// bottom-left origin growing upwards. Both share the same x axis and the same origin display
    /// (the primary screen), so only y changes:
    ///
    ///     y_ns = primaryHeight - (y_cg + height)
    ///
    /// With a 1512x982 primary at (0,0) and the Edge at CG (1950, -1309, 2560, 720) — i.e. to the
    /// right and above the primary — this gives y_ns = 982 - (-1309 + 720) = 1571, so the Edge
    /// sits at NS (1950, 1571, 2560, 720), above the primary's 982-point top edge. Correct.
    static func fromCGDisplayBounds(_ bounds: CGRect, primaryHeight: CGFloat) -> NSRect {
        NSRect(x: bounds.origin.x,
               y: primaryHeight - (bounds.origin.y + bounds.height),
               width: bounds.width,
               height: bounds.height)
    }

    /// Height of the primary screen, which is the one whose AppKit origin is (0,0).
    static var primaryScreenHeight: CGFloat {
        NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.height
            ?? NSScreen.screens.first?.frame.height
            ?? CGDisplayBounds(CGMainDisplayID()).height
    }
}

/// Borderless window that can still take the keyboard focus.
///
/// `NSWindow` refuses to become key or main when it is borderless, which in an accessory
/// (`LSUIElement`) app leaves the dashboard unable to receive clicks and key events at all.
private final class KioskNSWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// Web view that lets the very first click reach the page.
///
/// AppKit asks `acceptsFirstMouse(for:)` on the hit-tested view only, and the web view covers
/// the whole window, so the override has to live on the web view itself: on a plain container
/// it is never consulted. Without it, a click on an inactive app is spent activating it and
/// never reaches the page, so the user has to tap twice to press anything on the dashboard.
private final class FirstMouseWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /**
     No context menu, ever.

     A long press on the Edge is how the dashboard's own gestures work, and WebKit answers one
     with its native menu: "Open Frame in New Window" inside a widget, "Reload" on the bar. Both
     are ways out of the kiosk, on a screen with no keyboard and no window chrome to get back
     from. Emptying the menu is enough — WebKit shows nothing for an empty one.
     */
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.removeAllItems()
    }
}

/// Borderless full-screen window on the Edge display showing the kiosk dashboard.
///
/// The web view retries on its own while the server is not up yet: a failed navigation schedules a
/// single reload three seconds later, so the window comes up black and fills in once the dashboard
/// answers.
final class KioskWindow: NSObject, WKNavigationDelegate {
    /// Above the menu bar and status items (see `init`). System alerts are drawn below it.
    static let kioskLevel = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
    /// Delay between a failed navigation and the next attempt.
    private static let retryDelay: TimeInterval = 3

    private let window: NSWindow
    private let webView: WKWebView
    private let url: URL
    /// Signs the web view in (a one-time link, see `ServerAccess.signInURL`) before every load.
    private let access: ServerAccess
    /// Pending retry, so a burst of failures queues only one and a manual reload can cancel it.
    private var retryWork: DispatchWorkItem?

    init(frame: NSRect, url: URL, access: ServerAccess) {
        self.url = url
        self.access = access

        window = KioskNSWindow(contentRect: frame,
                               styleMask: .borderless,
                               backing: .buffered,
                               defer: false)
        // Above the menu bar and status items: with "Displays have separate Spaces" macOS draws
        // a menu bar on every display, and a floating window would leave it visible on the Edge.
        window.level = Self.kioskLevel
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.backgroundColor = .black
        window.isMovable = false
        window.isMovableByWindowBackground = false
        window.hasShadow = false
        window.isReleasedWhenClosed = false

        let configuration = WKWebViewConfiguration()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Nothing on the Edge may look or behave like a web page: no text selection and no
        // Look Up (which a long press would otherwise offer, widgets included).
        if #available(macOS 11.3, *) { configuration.preferences.isTextInteractionEnabled = false }
        webView = FirstMouseWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.underPageBackgroundColor = .black
        // A pinch on the panel must not zoom the dashboard, a two-finger swipe must not navigate
        // back out of it, and a press must not raise a link preview.
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false

        super.init()

        webView.navigationDelegate = self

        window.contentView = webView

        window.orderFrontRegardless()
        load()
    }

    // MARK: - Content

    /// Loads the dashboard through a fresh one-time sign-in link, so the web view holds a session
    /// of the server that answers now: a server restarted since (sessions die with it) is caught
    /// up with on the next load. Without a link — nothing proved it is our server on the port,
    /// or it is not up yet — nothing is loaded: whatever holds the port is not shown on the Edge.
    /// The current page stays, and the load is tried again shortly.
    private func load() {
        access.signInURL(for: url) { [weak self] signIn in
            guard let self else { return }
            guard let signIn else { self.scheduleRetry(); return }
            self.webView.load(URLRequest(url: signIn))
        }
    }

    /// Reloads the dashboard; used when the server comes up or restarts.
    func reload() {
        // A retry queued by an earlier failure would otherwise reload a second time on top of this.
        retryWork?.cancel()
        retryWork = nil
        load()
    }

    // MARK: - Geometry

    /// Moves the window onto `rect` (CoreGraphics display bounds), or hides it when the Edge is gone.
    func setEdgeFrame(_ rect: CGRect?) {
        visibility.displayAvailable = rect != nil
        guard let rect else {
            window.orderOut(nil)
            return
        }
        let frame = NSRect.fromCGDisplayBounds(rect, primaryHeight: NSRect.primaryScreenHeight)
        window.setFrame(frame, display: visibility.shouldShow)
        if visibility.shouldShow { window.orderFrontRegardless() }
    }

    // MARK: - Visibility

    private var visibility = DashboardVisibility()
    var isHiddenByUser: Bool { visibility.hiddenByUser }
    var isShowingDashboard: Bool { visibility.shouldShow }
    var onVisibilityChange: (() -> Void)?

    /// Lends the Edge to the windows behind the dashboard until the user shows it again.
    func hideDashboard() {
        visibility.hide()
        window.orderOut(nil)
        onVisibilityChange?()
    }

    /// Returns the dashboard without taking keyboard focus from the current application.
    func showDashboard() {
        visibility.show()
        if NSApp.isHidden { NSApp.unhideWithoutActivation() }
        if visibility.shouldShow {
            window.orderFrontRegardless()
        }
        onVisibilityChange?()
    }

    func applicationDidHide() {
        visibility.applicationDidHide()
        window.orderOut(nil)
        onVisibilityChange?()
    }

    func applicationDidUnhide() {
        visibility.applicationDidUnhide()
        if visibility.shouldShow { window.orderFrontRegardless() }
        onVisibilityChange?()
    }

    func close() {
        endReveal()
        window.orderOut(nil)
    }

    // MARK: - Reveal

    /// Pending return to the kiosk level after a reveal.
    private var revealWork: DispatchWorkItem?

    /// Lets what sits behind the dashboard be seen and touched for `seconds`: a macOS dialog — a
    /// privacy prompt the disk map is waiting on — opens on the Edge *under* the kiosk, which sits
    /// above the status bar. The window drops to the normal level, behind the other windows, and
    /// comes back on its own; a second reveal starts the time again.
    func reveal(for seconds: TimeInterval) {
        revealWork?.cancel()
        window.level = .normal
        // A dashboard the user hid stays hidden: ordering it back would show it.
        if visibility.shouldShow { window.orderBack(nil) }
        let work = DispatchWorkItem { [weak self] in self?.endReveal() }
        revealWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// Back to the kiosk level, at once; nothing to do when no reveal is running.
    func endReveal() {
        guard let work = revealWork else { return }
        work.cancel()
        revealWork = nil
        window.level = Self.kioskLevel
        if visibility.shouldShow { window.orderFrontRegardless() }
    }

    // MARK: - WKNavigationDelegate

    /**
     Keeps the kiosk on the dashboard.

     The window has no chrome and no way back: a main-frame navigation somewhere else — a widget
     setting `top.location`, a link a page opens, a redirect from a proxied answer — would leave
     the Edge showing that page with no way for the user to return but quitting the helper. Only
     the configured origin loads; anything else is cancelled and the current page stays.

     Sub-frames are not touched: the widgets are iframes, and they have their own CSP.
     */
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame != false else {
            // A frame is a widget, and a widget may only ever be another widget document: a
            // sandboxed frame can still navigate itself, and the request would carry its data.
            if WidgetFrames.allows(navigationAction.request.url, on: url) {
                decisionHandler(.allow)
            } else {
                NSLog("fremkit: kiosk refused a frame navigation outside /widgets/")
                decisionHandler(.cancel)
            }
            return
        }
        let target = navigationAction.request.url
        if KioskOrigin.sameOrigin(target, as: url) {
            decisionHandler(.allow)
        } else {
            NSLog("fremkit: kiosk refused a navigation away from the dashboard")
            decisionHandler(.cancel)
        }
    }

    /**
     A dashboard the server refused (401) is retried like one that failed to load.

     It happens when the session the web view holds is not one the server knows — the server was
     restarted (sessions live in its memory), or the session expired. The server's refusal page is
     shown meanwhile, and the retry signs in again with a new one-time link.
     */
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame,
           (navigationResponse.response as? HTTPURLResponse)?.statusCode == 401 {
            scheduleRetry()
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }

    private func scheduleRetry() {
        guard retryWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.retryWork = nil
            self.load()
        }
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.retryDelay, execute: work)
    }
}
