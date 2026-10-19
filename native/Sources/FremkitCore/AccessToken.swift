import Foundation

/// The server's local access secret, as the helper makes, finds and presents it.
///
/// The server answers only callers that carry it (see `SECURITY.md` and `server/src/http/access.ts`).
/// The helper makes a fresh one for every server it spawns. A server the helper did not start —
/// `pnpm dev` holding the port — has its own, which it wrote to the same per-port file once it
/// listened. Either way, the listener has to prove it holds the secret (`AccessProof`) before the
/// helper presents it. The two sides must agree on the file's place.
public enum AccessToken {
    /// The variable the helper passes the secret in. The server deletes it once read.
    public static let environmentKey = "FREMKIT_ACCESS_TOKEN"

    /// 32 random bytes, base64url without padding: 43 characters.
    ///
    /// `SystemRandomNumberGenerator` is the system's cryptographic generator on Apple platforms
    /// (`arc4random_buf`), which keeps FremkitCore free of the Security framework.
    public static func generate() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return base64URL(Data(bytes))
    }

    /// base64url without padding.
    public static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// What the server accepts as a secret: base64url, at least 32 bytes' worth.
    public static func isWellFormed(_ value: String) -> Bool {
        guard (43...512).contains(value.count) else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            switch scalar {
            case "A"..."Z", "a"..."z", "0"..."9", "-", "_": return true
            default: return false
            }
        }
    }

    /// `<support>/access-<port>.token`, where the server writes its secret.
    public static func fileURL(port: Int, supportDirectory: URL) -> URL {
        supportDirectory.appendingPathComponent("access-\(port).token")
    }

    /// The secret in a token file, or nil when the file is missing or holds anything else.
    public static func read(from url: URL) -> String? {
        guard let data = try? Data(contentsOf: url), data.count < 4096,
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return isWellFormed(token) ? token : nil
    }

    /// `Authorization` header value for a secret.
    public static func bearer(_ token: String) -> String {
        "Bearer \(token)"
    }

    /// The code in a `POST /api/auth/code` answer.
    public static func code(fromResponse data: Data?) -> String? {
        guard let data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let code = object["code"] as? String, isWellFormed(code)
        else { return nil }
        return code
    }

    /// The one-time link that signs a browser in and lands on `target`'s path and query.
    ///
    /// Built on `target`'s own scheme, host and port, so it opens on the origin the cookie is
    /// meant for. The path and query travel in `next`, which the server keeps on its own origin.
    public static func signInURL(for target: URL, code: String) -> URL? {
        guard var components = URLComponents(url: target, resolvingAgainstBaseURL: false) else { return nil }
        var next = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        if let query = components.percentEncodedQuery { next += "?" + query }
        // `next` is a path with a query of its own: encoded strictly, so its `&`, `=`, `?` and
        // `+` stay inside the parameter rather than being read as the link's own.
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~/")
        guard let encoded = next.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        components.percentEncodedPath = "/auth"
        components.fragment = nil
        components.percentEncodedQuery = "code=\(code)&next=\(encoded)"
        return components.url
    }
}
