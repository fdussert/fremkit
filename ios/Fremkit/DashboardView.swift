import FremkitKit
import SwiftUI
import WebKit

/// The Mac's dashboard in a web view: the device cookie set before the first load, the Mac's key
/// pinned on the Mac's hosts only, no zoom, no scroll, no bounce. A new host means a new view
/// (`RootView` keys it by host).
struct DashboardView: UIViewRepresentable {
    let host: String
    let port: Int
    let mac: PairedMac
    /// What the page posts to the `fremkit` message handler.
    let onMessage: @MainActor (PageMessage) -> Void
    /// The main frame failed to load, or the web content process died.
    let onFailure: @MainActor () -> Void

    static let handlerName = "fremkit"

    /// The page is laid out at the iPad's width and cannot be pinch-zoomed.
    private static let viewportScript = """
        (function () {
          var m = document.querySelector('meta[name=viewport]');
          if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
          m.content = 'width=device-width, initial-scale=1, user-scalable=no';
        })();
        """

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Nothing kept on disk: the cookie is set again on every load.
        configuration.websiteDataStore = .nonPersistent()
        let content = configuration.userContentController
        content.addUserScript(WKUserScript(source: Self.viewportScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        content.add(context.coordinator, name: Self.handlerName)

        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.underPageBackgroundColor = .black
        #if DEBUG
        web.isInspectable = true
        #endif
        context.coordinator.load(web)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        // The content controller holds its handler strongly.
        web.configuration.userContentController.removeScriptMessageHandler(forName: handlerName)
        web.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: DashboardView
        /// Set when the challenge handler refused the Mac's key: the load then ends as "cancelled",
        /// which must still count as a failure.
        private var rejectedPin = false

        init(_ parent: DashboardView) {
            self.parent = parent
        }

        /// Sets the device cookie for the host in use, then loads the page.
        func load(_ web: WKWebView) {
            let properties: [HTTPCookiePropertyKey: Any] = [
                .domain: parent.host,
                .path: "/",
                .name: Dashboard.cookieName,
                .value: parent.mac.token,
                .secure: "TRUE",
                HTTPCookiePropertyKey("HttpOnly"): "TRUE",
                .sameSitePolicy: HTTPCookieStringPolicy.sameSiteLax,
            ]
            guard let cookie = HTTPCookie(properties: properties),
                  let url = Dashboard.url(host: parent.host, port: parent.port) else {
                parent.onFailure()
                return
            }
            web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                web.load(URLRequest(url: url))
            }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the dashboard itself speaks for the app: not a frame inside it, and not a main
            // frame on any origin but the Mac's.
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame,
                  Dashboard.isPageOrigin(scheme: origin.protocol, host: origin.host, port: origin.port,
                                         host: parent.host, port: parent.port),
                  let decoded = PageMessage(body: message.body) else { return }
            parent.onMessage(decoded)
        }

        /// The pin applies to the Mac's hosts only (the host in use, its `.local` name, its last
        /// address); any other host a widget loads from gets the system's trust.
        func webView(_ webView: WKWebView, respondTo challenge: URLAuthenticationChallenge)
            async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
            let space = challenge.protectionSpace
            guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
                return (.performDefaultHandling, nil)
            }
            let hosts = Dashboard.pinnedHosts(mac: parent.mac, host: parent.host)
            switch PinnedSession.decide(host: space.host, presented: Pin.keyHash(of: trust), expected: parent.mac.keyHash, hosts: hosts) {
            case .trust: return (.useCredential, URLCredential(trust: trust))
            case .reject:
                rejectedPin = true
                return (.cancelAuthenticationChallenge, nil)
            case .defaultHandling: return (.performDefaultHandling, nil)
            }
        }

        /// The page stays on the Mac's origin (`https://<host>:<port>`), as the Mac's kiosk does,
        /// and a frame inside it (a widget) loads only the Mac's `/widgets/…`. A request for a new
        /// window (no target frame) has nowhere to open and is cancelled.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            let url = navigationAction.request.url
            guard let frame = navigationAction.targetFrame else { return .cancel }
            if frame.isMainFrame {
                return Dashboard.allowsMainFrame(url, host: parent.host, port: parent.port) ? .allow : .cancel
            }
            return Dashboard.allowsSubframe(url, host: parent.host, port: parent.port) ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            failed(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            failed(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            parent.onFailure()
        }

        /// A navigation replaced by another one is not a failure; one cancelled because the pin
        /// refused the key is.
        private func failed(_ error: any Error) {
            let error = error as NSError
            if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled, !rejectedPin { return }
            rejectedPin = false
            parent.onFailure()
        }
    }
}
