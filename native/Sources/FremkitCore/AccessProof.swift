import CryptoKit
import Foundation

/// The challenge a listener on the port answers before the helper shows it the secret.
///
/// Whatever answers on 4242 is not necessarily our server: another account on the Mac can bind
/// the port while ours is down (at login, or during the back-off after a crash) and wait for the
/// helper to send its bearer, or to load its pages in the kiosk. So the helper asks first, with a
/// random nonce and no credential, and the listener has to answer with
/// HMAC-SHA256(secret, "fremkit-access-proof-v1:" + nonce). Only a server holding the secret can.
/// `server/src/http/access.ts` (`accessProof`) computes the same and must stay in step.
///
/// Chosen over checking who owns the listening socket: macOS does not let one account read
/// another's process table entries (`proc_pidfdinfo` answers EPERM), so "the listener is ours"
/// could only be shown by finding it among our own processes — which says nothing useful about a
/// `pnpm dev` started from a terminal, and is a scan rather than a question.
public enum AccessProof {
    /// The route the server answers it on, without a credential.
    public static let path = "/auth/proof"
    /// Prefix of the MAC'd message, so the MAC means nothing anywhere else.
    static let label = "fremkit-access-proof-v1:"

    /// What a probe concluded about the listener on the port.
    public enum Verdict: Equatable {
        /// It proved it holds the secret the helper expects.
        case ours
        /// Something answered, and could not prove it.
        case foreign
        /// Nothing answered.
        case absent
    }

    /// 24 random bytes, base64url: 32 characters.
    public static func newNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<24).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return AccessToken.base64URL(Data(bytes))
    }

    /// The proof a server holding `token` gives for `nonce`, base64url.
    public static func expected(token: String, nonce: String) -> String {
        let key = SymmetricKey(data: Data(token.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: Data((label + nonce).utf8), using: key)
        return AccessToken.base64URL(Data(mac))
    }

    /// `http://127.0.0.1:<port>/auth/proof?nonce=…`.
    public static func url(port: Int, nonce: String) -> URL? {
        URL(string: "http://127.0.0.1:\(port)\(path)?nonce=\(nonce)")
    }

    /**
     What an answer to the challenge says.

     No status at all (refused, timed out) is `.absent`. Anything else is `.ours` only when it is
     a 200 whose `proof` matches what `token` gives for `nonce`, compared in constant time; with
     no token to check against — no server of ours, no token file — nothing can be ours.
     */
    public static func verdict(status: Int?, body: Data?, token: String?, nonce: String) -> Verdict {
        guard let status else { return .absent }
        guard status == 200, let token, let body, body.count < 4096,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let proof = object["proof"] as? String
        else { return .foreign }
        return constantTimeEqual(proof, expected(token: token, nonce: nonce)) ? .ours : .foreign
    }

    static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<x.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }
}
