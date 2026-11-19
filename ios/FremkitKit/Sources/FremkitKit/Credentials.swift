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

/// The stored pairing's bytes, wherever they are kept.
public protocol PairingVault: Sendable {
    /// nil when nothing is stored. Throws when something is stored but cannot be read.
    func read() throws -> Data?
    func write(_ data: Data) throws
    func remove()
}

/// The keychain, as one generic password holding the record's JSON, readable after the first
/// unlock and never leaving this device (no iCloud keychain, no backup restore elsewhere). iOS
/// keeps the item when the app is deleted, which is what `InstallBoundCredentialStore` is for.
public struct KeychainVault: PairingVault {
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

    public func read() throws -> Data? {
        var lookup = query
        lookup[kSecReturnData] = true
        lookup[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = item as? Data else { throw KeychainError(status: errSecDecode) }
        return data
    }

    /// Updates the stored item in place, adding it only when there is none: a failure between a
    /// delete and an add would lose the pairing.
    public func write(_ data: Data) throws {
        let changes: [CFString: Any] = [kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item.merge(changes) { _, new in new }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func remove() {
        SecItemDelete(query as CFDictionary)
    }
}

/// What the app's container says about this installation.
public enum InstallMark: Equatable, Sendable {
    /// Nothing there: the first launch, or the first one after the app was deleted and installed
    /// again.
    case absent
    /// Something is there and it is not an id (an empty file, one cut short). The container was
    /// not wiped, so the app was not reinstalled: this is damage, never a reason to drop a pairing.
    case damaged
    case id(String)
}

/// The id of this installation of the app, kept where deleting the app deletes it.
public protocol InstallMarker: Sendable {
    /// Throws when what is there cannot be read at all.
    func read() throws -> InstallMark
    func write(_ id: String) throws
}

/// The installation id as a file in the app's container.
public struct FileInstallMarker: InstallMarker {
    private let file: URL

    public init(file: URL) {
        self.file = file
    }

    /// `Application Support/install-id` in the app's container: deleted with the app, and restored
    /// with it from a backup of this device, like the keychain item it is compared with.
    public static func inApplicationSupport() -> FileInstallMarker {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return FileInstallMarker(file: folder.appendingPathComponent("install-id"))
    }

    public func read() throws -> InstallMark {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return .absent
        }
        let id = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return UUID(uuidString: id) == nil ? .damaged : .id(id)
    }

    /// Readable from the first unlock on, as the keychain item is: the two are read together.
    public func write(_ id: String) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(id.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// What the vault holds: the pairing's own JSON keys and, beside them, the installation that wrote
/// it. A record written by version 1.0 of the app has no `install`.
struct StoredPairing: Codable {
    var mac: PairedMac
    var install: String?

    private enum CodingKeys: String, CodingKey {
        case install
    }

    init(mac: PairedMac, install: String?) {
        self.mac = mac
        self.install = install
    }

    init(from decoder: any Decoder) throws {
        mac = try PairedMac(from: decoder)
        install = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(String.self, forKey: .install)
    }

    func encode(to encoder: any Encoder) throws {
        try mac.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(install, forKey: .install)
    }
}

/// The pairing, kept only for the installation that saved it. The keychain outlives the app: with
/// the keychain alone, deleting the app and installing it again brought back the old pairing, and
/// an iPad whose Mac was gone could not be reset by reinstalling. Each record carries the id of
/// the installation that wrote it, and one whose installation is not this one is removed.
///
/// "Not this one" is an empty container or another id, nothing else: an iPad erased and restored
/// without the app's data counts, as a reinstall does. Whatever is only an error (a keychain or a
/// container that cannot be read, a damaged id file, a record that does not decode) removes
/// nothing.
public struct InstallBoundCredentialStore: CredentialStore {
    private let vault: any PairingVault
    private let marker: any InstallMarker

    public init(vault: any PairingVault, marker: any InstallMarker) {
        self.vault = vault
        self.marker = marker
    }

    public func load() throws -> PairedMac? {
        guard let data = try vault.read() else { return nil }
        let record = try JSONDecoder().decode(StoredPairing.self, from: data)
        let mark = try marker.read()
        switch (record.install, mark) {
        case let (wrote?, .id(here)) where wrote == here:
            return record.mac
        case (_?, .id), (_?, .absent):
            // Left by an installation that is gone.
            vault.remove()
            return nil
        case (nil, _), (_?, .damaged):
            // A record written by 1.0, which recorded no installation: nothing tells an update
            // from a reinstall here, and an update must keep its pairing. Or the id file is
            // damaged, in a container that was not wiped. Either way the pairing is kept and bound
            // to this installation, at the next load if it cannot be written now.
            try? write(record.mac, mark: mark)
            return record.mac
        }
    }

    /// Throws when the installation id cannot be recorded either: the next launch would take the
    /// pairing for a stale one and remove it.
    public func save(_ mac: PairedMac) throws {
        try write(mac, mark: try marker.read())
    }

    public func clear() {
        vault.remove()
    }

    /// The marker first: a record must never name an installation the container does not hold.
    private func write(_ mac: PairedMac, mark: InstallMark) throws {
        let id: String
        if case let .id(here) = mark {
            id = here
        } else {
            id = UUID().uuidString
            try marker.write(id)
        }
        try vault.write(JSONEncoder().encode(StoredPairing(mac: mac, install: id)))
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
