import Foundation
import FremkitCore

/// The server's access secret, as the helper presents it (see `AccessToken` in FremkitCore).
///
/// A fresh secret for every server the helper spawns, so a respawned server never honours what
/// its predecessor handed out. For a server the helper did not start — a `pnpm dev` holding the
/// port — the secret is read from the per-port token file.
///
/// The secret is presented only to a listener that has *proved* it holds it (`AccessProof`): until
/// a probe says so, and from the moment one doubts it or the spawned server dies, `authorize`
/// adds nothing and `signInURL` mints nothing, so nothing that took the port in between — another
/// account's program — ever receives the secret or gets its pages shown in the kiosk.
/// Everything here runs on the main thread.
final class ServerAccess {
    let port: Int
    private let file: URL
    /// The secret of the server this helper spawned and supervises, while it lives.
    private var spawnToken: String?
    /// The secret of the listener that last proved itself, nil until one has and after any doubt.
    private var verified: String?
    /// What the last probe concluded, for the menu and the browser link.
    private(set) var verdict: AccessProof.Verdict = .absent

    init(port: Int) {
        self.port = port
        file = AccessToken.fileURL(port: port, supportDirectory: HelperPaths.supportDirectory())
    }

    /// A new secret for a server about to be spawned. Nothing is presented until it proves it.
    func newSpawnToken() -> String {
        let token = AccessToken.generate()
        spawnToken = token
        verified = nil
        return token
    }

    /// The spawned server is gone (or was never ours): forget its secret and trust nothing.
    func forgetSpawn() {
        spawnToken = nil
        verified = nil
    }

    /// The secret the listener should hold: our spawn's, else the token file's.
    private var expected: String? {
        spawnToken ?? AccessToken.read(from: file)
    }

    /// Adds the bearer header to a request for the server, if the listener proved itself; returns
    /// whether it did. A request sent without it is simply refused by our server.
    @discardableResult
    func authorize(_ request: inout URLRequest) -> Bool {
        guard let verified else { return false }
        request.setValue(AccessToken.bearer(verified), forHTTPHeaderField: "Authorization")
        return true
    }

    /**
     Asks the listener on the port to prove it holds the secret, with no credential sent, and
     records the answer: `authorize` works after `.ours` only. `done` runs on the main thread.
     */
    func probe(timeout: TimeInterval, queue: DispatchQueue? = nil, _ done: @escaping (AccessProof.Verdict) -> Void) {
        let nonce = AccessProof.newNonce()
        let token = expected
        guard let url = AccessProof.url(port: port, nonce: nonce) else {
            DispatchQueue.main.async { done(.absent) }
            return
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        // No cookies either way: the answer must stand on the proof alone.
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        let operations = OperationQueue()
        operations.maxConcurrentOperationCount = 1
        if let queue { operations.underlyingQueue = queue }
        let session = URLSession(configuration: configuration, delegate: nil, delegateQueue: operations)
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        session.dataTask(with: request) { [weak self] data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            let verdict = AccessProof.verdict(status: status, body: data, token: token, nonce: nonce)
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async {
                guard let self else { return }
                // A spawn since the question was asked changed what the listener should hold: the
                // answer is about a secret that is no longer the one to present.
                let current = verdict == .ours && token == self.expected
                self.verdict = verdict
                if current {
                    self.verified = token
                } else if verdict == .absent, self.spawnToken != nil {
                    // A probe that timed out while our own child lives says nothing new: the
                    // child holds the port, so nobody else can, and its death clears this anyway.
                } else {
                    self.verified = nil
                }
                done(current || verdict != .ours ? verdict : .absent)
            }
        }.resume()
    }

    /**
     The server's diagnostics report (`GET /api/diagnostics`), already redacted by the server, or
     why there is none. `done` runs on the main thread.
     */
    func diagnostics(done: @escaping (HelperDiagnostics.ServerPart) -> Void) {
        guard let endpoint = URL(string: "http://127.0.0.1:\(port)/api/diagnostics") else {
            done(.unavailable(reason: "no address"))
            return
        }
        var request = URLRequest(url: endpoint)
        // The report reads the keychain and runs sw_vers and scutil: a few seconds at worst.
        request.timeoutInterval = 10
        authorize(&request)
        let session = URLSession(configuration: .ephemeral)
        session.dataTask(with: request) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            let text = data.flatMap { String(data: $0, encoding: .utf8) }
            let part: HelperDiagnostics.ServerPart
            if status == 200, let text, !text.isEmpty {
                part = .report(text)
            } else {
                part = .unavailable(reason: HelperDiagnostics.reason(status: status, error: error))
            }
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async { done(part) }
        }.resume()
    }

    /**
     A one-time link that signs a browser or a web view in and lands on `target`, or nil when the
     listener on the port did not prove it is our server, or would not mint one. `done` runs on
     the main thread.

     Following it opens a session on the server, whose cookie is what the page then carries: the
     cookie never holds the secret itself (browsers hand a host's cookies to every port on it),
     and neither does the URL (it would sit in a browser's history). The code works once, within
     a minute. The kiosk and the admin window sign in this way too.
     */
    func signInURL(for target: URL, done: @escaping (URL?) -> Void) {
        // Proved right before the code is asked for, every time: what loads next is shown on the
        // Edge or in the browser, and must come from our server.
        probe(timeout: 2) { [weak self] verdict in
            guard let self, verdict == .ours else { done(nil); return }
            self.mintSignInURL(for: target, done: done)
        }
    }

    private func mintSignInURL(for target: URL, done: @escaping (URL?) -> Void) {
        guard let endpoint = URL(string: "http://127.0.0.1:\(port)/api/auth/code") else {
            done(nil)
            return
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        guard authorize(&request) else { done(nil); return }
        let session = URLSession(configuration: .ephemeral)
        session.dataTask(with: request) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let url = ok ? AccessToken.code(fromResponse: data).flatMap { AccessToken.signInURL(for: target, code: $0) } : nil
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async { done(url) }
        }.resume()
    }
}
