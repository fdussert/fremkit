import Foundation
import Security

/// The Mac this iPad is paired with, and the token that proves it.
public struct PairedMac: Codable, Equatable, Sendable {
    /// The Mac's `.local` name.
    public var host: String
    /// The last address that answered, usually an IP literal.
    public var address: String
    public var port: Int
    /// The pin, base64url SHA-256 of the Mac's SPKI.
    public var keyHash: String
    /// The device token, sent as the `fremkit_device` cookie. Never logged.
    public var token: String
    public var deviceId: String
    /// The Mac's name for people: its `.local` name without the suffix, or its Bonjour name.
    public var name: String
    /// The Mac's other LAN addresses, as it last listed them (`DeviceInfo.addresses`): tried after
    /// `host` and `address` when looking for it, under the same pin. Private IPv4 literals only, at
    /// most `maxAddresses`.
    public var addresses: [String]

    /// How many of the Mac's other addresses are kept.
    public static let maxAddresses = 8

    public init(host: String, address: String, port: Int, keyHash: String, token: String, deviceId: String, name: String,
                addresses: [String] = []) {
        self.host = host
        self.address = address
        self.port = port
        self.keyHash = keyHash
        self.token = token
        self.deviceId = deviceId
        self.name = name
        self.addresses = Self.cleaned(addresses)
    }

    private enum CodingKeys: String, CodingKey {
        case host, address, port, keyHash, token, deviceId, name, addresses
    }

    /// A pairing stored before `addresses` existed has none: `[]`.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(host: try c.decode(String.self, forKey: .host),
                  address: try c.decode(String.self, forKey: .address),
                  port: try c.decode(Int.self, forKey: .port),
                  keyHash: try c.decode(String.self, forKey: .keyHash),
                  token: try c.decode(String.self, forKey: .token),
                  deviceId: try c.decode(String.self, forKey: .deviceId),
                  name: try c.decode(String.self, forKey: .name),
                  addresses: (try? c.decodeIfPresent([String].self, forKey: .addresses)) ?? [])
    }

    /// The private IPv4 literals of `addresses`, each once, in order, at most `maxAddresses`.
    static func cleaned(_ addresses: [String]) -> [String] {
        var seen = Set<String>()
        return Array(addresses.filter { isPrivateIPv4Literal($0) && seen.insert($0).inserted }.prefix(maxAddresses))
    }

    /// The record with `addresses` (cleaned) as the Mac's other addresses: what it listed last.
    public func updating(addresses: [String]) -> PairedMac {
        var copy = self
        copy.addresses = Self.cleaned(addresses)
        return copy
    }

    /// The record with `address` as the one to try first next time, when it is an IP literal (the
    /// Mac moved). A name that answered changes nothing: `host` already is that name.
    public func updating(address: String) -> PairedMac {
        guard isIPLiteral(address) else { return self }
        var copy = self
        copy.address = address
        return copy
    }
}

/// Printing a pairing, `dump()` included, never shows its token or its pin.
extension PairedMac: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "PairedMac(\(name), \(host), \(address):\(port), device \(deviceId))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["host": host, "address": address, "port": port, "deviceId": deviceId, "name": name,
                                "token": redacted, "keyHash": redacted])
    }
}

/// What a secret prints as.
let redacted = "<redacted>"

public protocol CredentialStore: Sendable {
    /// nil when nothing is stored (not paired). Throws when something is stored but cannot be read,
    /// so a keychain failure is never mistaken for "not paired".
    func load() throws -> PairedMac?
    func save(_ mac: PairedMac) throws
    func clear()
}

public struct KeychainError: Error, Equatable {
    public let status: OSStatus
}

/// The pairing in the keychain, as one generic password holding the record's JSON, readable after
/// the first unlock and never leaving this device (no iCloud keychain, no backup restore elsewhere).
public struct KeychainCredentialStore: CredentialStore {
    private let service: String
    private let account = "paired-mac"

    public init(service: String = "fremkit.pairing") {
        self.service = service
    }

    private var query: [CFString: Any] {
        [kSecClass: kSecClassGenericPassword,
         kSecAttrService: service,
         kSecAttrAccount: account,
         kSecUseDataProtectionKeychain: true]
    }

    public func load() throws -> PairedMac? {
        var lookup = query
        lookup[kSecReturnData] = true
        lookup[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = item as? Data else { throw KeychainError(status: errSecDecode) }
        return try JSONDecoder().decode(PairedMac.self, from: data)
    }

    /// Updates the stored item in place, adding it only when there is none: a failure between a
    /// delete and an add would lose the pairing.
    public func save(_ mac: PairedMac) throws {
        let data = try JSONEncoder().encode(mac)
        let changes: [CFString: Any] = [kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item.merge(changes) { _, new in new }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

/// A store in memory, for tests and previews. Its one value is behind a lock, hence
/// `@unchecked Sendable`.
public final class MemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: PairedMac?

    public init(_ mac: PairedMac? = nil) {
        stored = mac
    }

    public func load() throws -> PairedMac? { lock.withLock { stored } }
    public func save(_ mac: PairedMac) throws { lock.withLock { stored = mac } }
    public func clear() { lock.withLock { stored = nil } }
}
