import CommonCrypto
import Foundation

/// What the iPad sends for a typed pairing code: never the code itself, but a proof of it bound to
/// the key of the Mac it is talking to. The Mac checks it against its own key, so a machine that
/// took the Mac's name on the network, showed its own key and relays the request gets a proof that
/// does not pair the real Mac, and cannot read the code back out of it in the code's five minutes.
/// The same derivation as `server/src/devices/codeProof.ts`; both test the same vector.
public enum CodeProof {
    public static let iterations: UInt32 = 600_000

    /// PBKDF2-HMAC-SHA256 of the normalized code, salted with `fremkit-pair-code-v1:<keyHash>`,
    /// 32 bytes, base64url without padding. Nil only if CommonCrypto fails.
    public static func proof(code: String, keyHash: String) -> String? {
        let password = Array(code.utf8)
        let salt = Array("fremkit-pair-code-v1:\(keyHash)".utf8)
        var out = [UInt8](repeating: 0, count: 32)
        let status = password.withUnsafeBufferPointer { pw in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                 pw.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self) }, pw.count,
                                 salt, salt.count,
                                 CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), iterations,
                                 &out, out.count)
        }
        guard status == kCCSuccess else { return nil }
        return Data(out).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
