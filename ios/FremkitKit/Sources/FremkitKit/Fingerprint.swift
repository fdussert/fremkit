import CryptoKit
import Foundation

/// Four words for the Mac's key, so a person can compare what the iPad shows with what the Mac
/// shows by eye. The same list and algorithm as `server/src/devices/fingerprint.ts`.
public enum Fingerprint {
    /// Hex SHA-256 of `fingerprint-words.txt`: the server's `FINGERPRINT_LIST_SHA256`.
    public static let listSHA256 = "247bec0519f05acf5f8716f8515af0532676cce180409949d265f5670797c930"

    /// The PGP word list's even column, byte value -> word, from the bundled copy of the server's
    /// file. A copy that does not hash to `listSHA256` is a build mistake and stops the app.
    static let list: [String] = {
        guard let url = Bundle.module.url(forResource: "fingerprint-words", withExtension: "txt"),
              let data = try? Data(contentsOf: url) else { preconditionFailure("fingerprint-words.txt is missing") }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        precondition(digest == listSHA256, "fingerprint-words.txt differs from the server's")
        let words = String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
        precondition(words.count == 256, "fingerprint-words.txt must hold 256 words")
        return words
    }()

    /// The words of the first four bytes of `keyHash` (base64url, the QR's `k`). Empty when the
    /// hash does not decode to at least four bytes: the server throws there, and an empty list is
    /// the app's "nothing to compare", never four made-up words.
    public static func words(keyHash: String) -> [String] {
        guard let bytes = Data(base64URLEncoded: keyHash), bytes.count >= 4 else { return [] }
        return bytes.prefix(4).map { list[Int($0)] }
    }
}
