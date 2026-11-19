import XCTest
@testable import FremkitKit

/// The keychain, in memory: what it holds outlives the "app" a test removes.
final class MemoryVault: PairingVault, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private var broken = false
    init(_ data: Data? = nil) { self.data = data }
    var contents: Data? { lock.withLock { data } }
    func breakIt() { lock.withLock { broken = true } }
    func read() throws -> Data? {
        try lock.withLock {
            if broken { throw KeychainError(status: -25308) }
            return data
        }
    }
    func write(_ data: Data) throws {
        try lock.withLock {
            if broken { throw KeychainError(status: -25308) }
            self.data = data
        }
    }
    func remove() { lock.withLock { data = nil } }
}

/// The app's container, in memory: `uninstall()` is what deleting the app does to it.
final class MemoryMarker: InstallMarker, @unchecked Sendable {
    struct Failure: Error {}
    private let lock = NSLock()
    private var id: String?
    private var unreadable = false
    private var readOnly = false
    init(_ id: String? = nil) { self.id = id }
    var current: String? { lock.withLock { id } }
    func uninstall() { lock.withLock { id = nil } }
    func makeUnreadable() { lock.withLock { unreadable = true } }
    func makeReadOnly() { lock.withLock { readOnly = true } }
    func read() throws -> String? {
        try lock.withLock {
            if unreadable { throw Failure() }
            return id
        }
    }
    func write(_ id: String) throws {
        try lock.withLock {
            if readOnly { throw Failure() }
            self.id = id
        }
    }
}

final class InstallBoundStoreTests: XCTestCase {
    /// What 1.0 wrote: the pairing alone, with no installation beside it.
    private var recordFrom10: Data { try! JSONEncoder().encode(sampleMac) }

    private func installOf(_ vault: MemoryVault) throws -> String? {
        let object = try JSONSerialization.jsonObject(with: XCTUnwrap(vault.contents)) as? [String: Any]
        return object?["install"] as? String
    }

    func testAPairingIsReadBackByTheInstallationThatSavedIt() throws {
        let vault = MemoryVault(), marker = MemoryMarker()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        try store.save(sampleMac)
        XCTAssertEqual(try store.load(), sampleMac)
        XCTAssertNotNil(marker.current)
        XCTAssertEqual(try installOf(vault), marker.current)
    }

    func testTheSameInstallationKeepsItsIdAcrossSaves() throws {
        let vault = MemoryVault(), marker = MemoryMarker()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        try store.save(sampleMac)
        let first = marker.current
        try store.save(sampleMac.updating(address: "192.168.1.77"))
        XCTAssertEqual(marker.current, first)
        XCTAssertEqual(try store.load()?.address, "192.168.1.77")
    }

    func testAPairingLeftByADeletedAppIsDroppedAfterTheReinstall() throws {
        let vault = MemoryVault(), marker = MemoryMarker()
        try InstallBoundCredentialStore(vault: vault, marker: marker).save(sampleMac)
        marker.uninstall()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        XCTAssertNil(try store.load())
        XCTAssertNil(vault.contents, "the stale pairing is removed from the keychain, not only hidden")
    }

    func testAPairingOfAnotherInstallationIsDropped() throws {
        let vault = MemoryVault()
        try InstallBoundCredentialStore(vault: vault, marker: MemoryMarker("earlier")).save(sampleMac)
        let store = InstallBoundCredentialStore(vault: vault, marker: MemoryMarker("this-one"))
        XCTAssertNil(try store.load())
        XCTAssertNil(vault.contents)
    }

    /// An update from 1.0 has a pairing and no installation id: it must not cost the pairing.
    func testAPairingWrittenBy10SurvivesTheUpdateAndIsBound() throws {
        let vault = MemoryVault(recordFrom10), marker = MemoryMarker()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        XCTAssertEqual(try store.load(), sampleMac)
        XCTAssertNotNil(marker.current)
        XCTAssertEqual(try installOf(vault), marker.current)
        XCTAssertEqual(try store.load(), sampleMac)
        marker.uninstall()
        XCTAssertNil(try store.load(), "once bound, it goes with the app like any other")
    }

    func testAPairingWrittenBy10IsKeptWhenItCannotBeBoundYet() throws {
        // Encoded once: the encoder does not promise the same key order twice.
        let record = recordFrom10
        let vault = MemoryVault(record), marker = MemoryMarker()
        marker.makeReadOnly()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        XCTAssertEqual(try store.load(), sampleMac)
        XCTAssertEqual(vault.contents, record)
    }

    /// Not being able to read the container is not "the app was reinstalled".
    func testAnUnreadableMarkerThrowsAndLeavesThePairingAlone() throws {
        let vault = MemoryVault(), marker = MemoryMarker()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        try store.save(sampleMac)
        let kept = vault.contents
        marker.makeUnreadable()
        XCTAssertThrowsError(try store.load())
        XCTAssertEqual(vault.contents, kept)
    }

    func testAnUnreadableKeychainThrows() throws {
        let vault = MemoryVault(recordFrom10)
        vault.breakIt()
        XCTAssertThrowsError(try InstallBoundCredentialStore(vault: vault, marker: MemoryMarker()).load())
    }

    /// A pairing that the next launch would take for a stale one is not a pairing.
    func testSavingFailsWhenTheInstallationCannotBeRecorded() throws {
        let vault = MemoryVault(), marker = MemoryMarker()
        marker.makeReadOnly()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        XCTAssertThrowsError(try store.save(sampleMac))
        XCTAssertNil(vault.contents)
    }

    func testNothingStoredIsNotPaired() throws {
        let marker = MemoryMarker()
        XCTAssertNil(try InstallBoundCredentialStore(vault: MemoryVault(), marker: marker).load())
        XCTAssertNil(marker.current, "reading makes no installation id")
    }

    func testClearRemovesThePairingAndKeepsTheInstallation() throws {
        let vault = MemoryVault(), marker = MemoryMarker()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        try store.save(sampleMac)
        let id = marker.current
        store.clear()
        XCTAssertNil(vault.contents)
        XCTAssertEqual(marker.current, id)
        XCTAssertNil(try store.load())
    }

    /// The stored JSON stays the pairing's own keys with one more, so 1.0 could still read it.
    func testTheStoredRecordStillDecodesAsAPairing() throws {
        let vault = MemoryVault()
        try InstallBoundCredentialStore(vault: vault, marker: MemoryMarker()).save(sampleMac)
        XCTAssertEqual(try JSONDecoder().decode(PairedMac.self, from: XCTUnwrap(vault.contents)), sampleMac)
    }
}

final class FileInstallMarkerTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("fremkit-marker-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testThereIsNoIdBeforeOneIsWritten() throws {
        XCTAssertNil(try FileInstallMarker(file: folder.appendingPathComponent("install-id")).read())
    }

    func testAnIdIsReadBackAndTheFolderIsMadeForIt() throws {
        let marker = FileInstallMarker(file: folder.appendingPathComponent("nested/install-id"))
        try marker.write("3F2A")
        XCTAssertEqual(try marker.read(), "3F2A")
        XCTAssertEqual(try FileInstallMarker(file: folder.appendingPathComponent("nested/install-id")).read(), "3F2A")
    }

    func testAnEmptyFileIsNoId() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("install-id")
        try Data(" \n".utf8).write(to: file)
        XCTAssertNil(try FileInstallMarker(file: file).read())
    }

    func testAFileThatCannotBeReadThrows() throws {
        // A folder where the file should be: there is something, and it is not readable as an id.
        let file = folder.appendingPathComponent("install-id")
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        XCTAssertThrowsError(try FileInstallMarker(file: file).read())
    }
}
