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
}

/// Borderless full-screen window on the Edge display showing the kiosk dashboard.
///
/// The web view retries on its own while the server is not up yet: a failed navigation schedules a
/// single reload three seconds later, so the window comes up black and fills in once the dashboard
/// answers.
final class KioskWindow: NSObject, WKNavigationDelegate {
    /// Delay between a failed navigation and the next attempt.
    private static let retryDelay: TimeInterval = 3

    private let window: NSWindow
    private let webView: WKWebView
    private let url: URL
    /// Pending retry, so a burst of failures queues only one and a manual reload can cancel it.
    private var retryWork: DispatchWorkItem?

    init(frame: NSRect, url: URL) {
        self.url = url

        window = KioskNSWindow(contentRect: frame,
                               styleMask: .borderless,
                               backing: .buffered,
                               defer: false)
        // Above the menu bar and status items: with "Displays have separate Spaces" macOS draws
        // a menu bar on every display, and a floating window would leave it visible on the Edge.
        window.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.backgroundColor = .black
        window.isMovable = false
        window.isMovableByWindowBackground = false
        window.hasShadow = false
        window.isReleasedWhenClosed = false

        let configuration = WKWebViewConfiguration()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        webView = FirstMouseWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.underPageBackgroundColor = .black

        super.init()

        webView.navigationDelegate = self

        window.contentView = webView

        window.orderFrontRegardless()
        load()
    }

    // MARK: - Content

    private func load() {
        webView.load(URLRequest(url: url))
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
        guard let rect else {
            window.orderOut(nil)
            return
        }
        let frame = NSRect.fromCGDisplayBounds(rect, primaryHeight: NSRect.primaryScreenHeight)
        window.setFrame(frame, display: true)
        window.orderFrontRegardless()
    }

    func close() {
        window.orderOut(nil)
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
            decisionHandler(.allow)
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
