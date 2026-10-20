import Foundation

/// The pairing-protocol vectors shared with the server's tests and the Android kit's:
/// `test-vectors/devices.json` at the repository root. A SwiftPM resource cannot live outside the
/// package, so the file is read relative to this source file.
enum Vectors {
    static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // FremkitKitTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // FremkitKit
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // repository root
        .appendingPathComponent("test-vectors/devices.json")

    static let data: Data = {
        do { return try Data(contentsOf: url) } catch { fatalError("cannot read \(url.path): \(error)") }
    }()

    static let all: File = {
        do { return try JSONDecoder().decode(File.self, from: data) } catch { fatalError("cannot decode \(url.path): \(error)") }
    }()

    /// The raw JSON, for the values `Decodable` would flatten (a page message's body keeps its
    /// `NSNull`s and `NSNumber`s as `WKScriptMessage` hands them over).
    static var json: [String: Any] {
        (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) as? [String: Any] ?? [:]
    }

    struct File: Decodable {
        let version: Int
        let codeProof: CodeProofVector
        let fingerprint: FingerprintVectors
        let spki: SPKIVector
        let codes: CodeVectors
        let pairingLinks: [PairingLinkVector]
        let ipv4: [IPv4Vector]
        let subframes: [FrameVector]
        let mainFrames: MainFrameVectors
    }

    struct CodeProofVector: Decodable {
        let iterations: Int
        let code: String
        let keyHash: String
        let proof: String
        let anotherKeyHash: String
    }

    struct FingerprintVectors: Decodable {
        struct Case: Decodable {
            let bytesHex: String
            let keyHash: String
            let words: [String]
        }
        let listSha256: String
        let listLength: Int
        let cases: [Case]
        let tooShort: [String]
    }

    struct SPKIVector: Decodable {
        let derHex: String
        let keyHash: String
        let rawOffset: Int
        let rejectedRawHex: [String]
    }

    struct CodeVectors: Decodable {
        struct Normalise: Decodable {
            let input: String
            let output: String?
            let why: String
        }
        let alphabet: String
        let length: Int
        let normalise: [Normalise]
    }

    struct PairingLinkVector: Decodable {
        struct Parsed: Decodable {
            let host: String
            let address: String
            let port: Int
            let code: String
            let keyHash: String
            let secret: String?
        }
        let why: String
        let url: String
        let expect: Parsed?
    }

    struct IPv4Vector: Decodable {
        let literal: String
        let ipv4: Bool
        let `private`: Bool
    }

    struct FrameVector: Decodable {
        let url: String?
        let host: String
        let port: Int
        let allowed: Bool
        let why: String
    }

    struct MainFrameVectors: Decodable {
        struct Origin: Decodable {
            let scheme: String
            let originHost: String
            let originPort: Int
            let host: String
            let port: Int
            let heard: Bool
        }
        let navigations: [FrameVector]
        let pageOrigins: [Origin]
    }

    /// `pageMessages`: each body as `JSONSerialization` reads it, and the expected parse.
    static var pageMessages: [(body: Any, expect: [String: Any]?)] {
        (json["pageMessages"] as? [[String: Any]] ?? []).map { ($0["body"] as Any, $0["expect"] as? [String: Any]) }
    }
}

extension Data {
    /// Bytes from lowercase or uppercase hex; traps on anything else (test data only).
    init(hex: String) {
        var bytes = [UInt8]()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        self.init(bytes)
    }
}
