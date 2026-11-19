import XCTest
@testable import FremkitKit

/// The keychain, in memory: what it holds outlives the "app" a test removes.
final class MemoryVault: PairingVault, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private var broken = false
    private var readOnly = false
    init(_ data: Data? = nil) { self.data = data }
    var contents: Data? { lock.withLock { data } }
    func breakIt() { lock.withLock { broken = true } }
    func makeReadOnly() { lock.withLock { readOnly = true } }
    func read() throws -> Data? {
        try lock.withLock {
            if broken { throw KeychainError(status: -25308) }
            return data
        }
    }
    func write(_ data: Data) throws {
        try lock.withLock {
            if broken || readOnly { throw KeychainError(status: -25308) }
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
    private var damaged = false
    private var unreadable = false
    private var readOnly = false
    init(_ id: String? = nil) { self.id = id }
    var current: String? { lock.withLock { id } }
    func uninstall() { lock.withLock { id = nil; damaged = false } }
    /// The file is still there and holds no id any more.
    func damage() { lock.withLock { id = nil; damaged = true } }
    func makeUnreadable() { lock.withLock { unreadable = true } }
    func makeReadOnly() { lock.withLock { readOnly = true } }
    func read() throws -> InstallMark {
        try lock.withLock {
            if unreadable { throw Failure() }
            if let id { return .id(id) }
            return damaged ? .damaged : .absent
        }
    }
    func write(_ id: String) throws {
        try lock.withLock {
            if readOnly { throw Failure() }
            self.id = id
            damaged = false
        }
    }
}

final class InstallBoundStoreTests: XCTestCase {
    /// What 1.0 wrote, as bytes: the pairing alone, with no installation beside it. Frozen here,
    /// not encoded from today's `PairedMac`, so a change to the record cannot hide a broken update.
    private let recordFrom10 = Data("""
        {"host":"studio.local","address":"192.0.2.10","port":4243,"keyHash":"\(SPKIFixture.keyHash)",\
        "token":"device-token","deviceId":"d1","name":"studio","addresses":[]}
        """.utf8)

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
        let vault = MemoryVault(recordFrom10), marker = MemoryMarker()
        marker.makeReadOnly()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        XCTAssertEqual(try store.load(), sampleMac)
        XCTAssertEqual(vault.contents, recordFrom10)
    }

    func testTheFrozen10RecordIsTheSamplePairing() throws {
        XCTAssertEqual(try JSONDecoder().decode(PairedMac.self, from: recordFrom10), sampleMac)
        // The build before `addresses` existed wrote none.
        let older = Data(String(decoding: recordFrom10, as: UTF8.self).replacingOccurrences(of: ",\"addresses\":[]", with: "").utf8)
        let store = InstallBoundCredentialStore(vault: MemoryVault(older), marker: MemoryMarker())
        XCTAssertEqual(try store.load(), sampleMac)
    }

    /// Half bound: the id was written at an earlier launch and the keychain refused the record.
    func testAPairingWrittenBy10IsBoundToTheIdAlreadyThere() throws {
        let vault = MemoryVault(recordFrom10), marker = MemoryMarker("already-here")
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        XCTAssertEqual(try store.load(), sampleMac)
        XCTAssertEqual(marker.current, "already-here")
        XCTAssertEqual(try installOf(vault), "already-here")
    }

    func testAPairingWrittenBy10IsKeptWhenTheKeychainRefusesTheBoundRecord() throws {
        let vault = MemoryVault(recordFrom10), marker = MemoryMarker()
        vault.makeReadOnly()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        XCTAssertEqual(try store.load(), sampleMac)
        XCTAssertEqual(try store.load(), sampleMac, "and at the next launch too")
        XCTAssertEqual(vault.contents, recordFrom10)
    }

    func testAPairingWrittenBy10IsLeftAloneWhenTheMarkerCannotBeRead() throws {
        let vault = MemoryVault(recordFrom10), marker = MemoryMarker()
        marker.makeUnreadable()
        XCTAssertThrowsError(try InstallBoundCredentialStore(vault: vault, marker: marker).load())
        XCTAssertEqual(vault.contents, recordFrom10)
    }

    /// The id file is there and holds nothing: the container was not wiped, so this is damage
    /// and not a reinstall. The pairing stays and gets a new id.
    func testADamagedMarkerKeepsThePairingAndBindsItAgain() throws {
        let vault = MemoryVault(), marker = MemoryMarker()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        try store.save(sampleMac)
        let before = marker.current
        marker.damage()
        XCTAssertEqual(try store.load(), sampleMac)
        XCTAssertNotNil(marker.current)
        XCTAssertNotEqual(marker.current, before)
        XCTAssertEqual(try installOf(vault), marker.current)
        XCTAssertEqual(try store.load(), sampleMac)
    }

    func testADamagedMarkerKeepsThePairingEvenWhenItCannotBeRepaired() throws {
        let vault = MemoryVault(), marker = MemoryMarker()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        try store.save(sampleMac)
        let kept = vault.contents
        marker.damage()
        marker.makeReadOnly()
        XCTAssertEqual(try store.load(), sampleMac)
        XCTAssertEqual(vault.contents, kept)
    }

    func testSavingOverADamagedMarkerMakesANewId() throws {
        let vault = MemoryVault(), marker = MemoryMarker()
        marker.damage()
        let store = InstallBoundCredentialStore(vault: vault, marker: marker)
        try store.save(sampleMac)
        XCTAssertEqual(try installOf(vault), marker.current)
        XCTAssertEqual(try store.load(), sampleMac)
    }

    /// What cannot be decoded is an error, never "not paired" and never removed.
    func testARecordThatDoesNotDecodeThrowsAndStays() throws {
        for text in ["not json", #"{"host":"studio.local"}"#,
                     String(decoding: recordFrom10, as: UTF8.self).replacingOccurrences(of: "}", with: #","install":7}"#)] {
            let vault = MemoryVault(Data(text.utf8))
            XCTAssertThrowsError(try InstallBoundCredentialStore(vault: vault, marker: MemoryMarker("here")).load(), text)
            XCTAssertEqual(vault.contents, Data(text.utf8), text)
        }
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
        XCTAssertEqual(try FileInstallMarker(file: folder.appendingPathComponent("install-id")).read(), .absent)
    }

    func testAnIdIsReadBackAndTheFolderIsMadeForIt() throws {
        let marker = FileInstallMarker(file: folder.appendingPathComponent("nested/install-id"))
        let id = UUID().uuidString
        try marker.write(id)
        XCTAssertEqual(try marker.read(), .id(id))
        XCTAssertEqual(try FileInstallMarker(file: folder.appendingPathComponent("nested/install-id")).read(), .id(id))
    }

    /// A file with no id in it is damage, not a missing file: the store keeps the pairing then.
    func testAFileWithoutAnIdIsDamagedNotAbsent() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("install-id")
        for contents in ["", " \n", "3F2A", String(UUID().uuidString.dropLast(8))] {
            try Data(contents.utf8).write(to: file)
            XCTAssertEqual(try FileInstallMarker(file: file).read(), .damaged, contents)
        }
    }

    func testAnIdIsReadThroughTheSpaceAroundIt() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("install-id")
        let id = UUID().uuidString
        try Data("\(id)\n".utf8).write(to: file)
        XCTAssertEqual(try FileInstallMarker(file: file).read(), .id(id))
    }

    func testAFileThatCannotBeReadThrows() throws {
        // A folder where the file should be: there is something, and it is not readable as an id.
        let file = folder.appendingPathComponent("install-id")
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        XCTAssertThrowsError(try FileInstallMarker(file: file).read())
    }
}

/// The app's model over the real store: what the screens show in each case.
@MainActor
final class InstallBoundModelTests: XCTestCase {
    private func stored(_ marker: MemoryMarker) throws -> MemoryVault {
        let vault = MemoryVault()
        try InstallBoundCredentialStore(vault: vault, marker: marker).save(sampleMac)
        return vault
    }

    func testAReinstalledAppStartsOnTheWelcomeScreen() throws {
        let marker = MemoryMarker()
        let vault = try stored(marker)
        marker.uninstall()
        let model = AppModel(store: InstallBoundCredentialStore(vault: vault, marker: marker),
                             connector: Connector(prober: ScriptedProber([:])))
        model.start()
        XCTAssertEqual(model.state, .welcome)
        XCTAssertNil(model.mac)
        XCTAssertFalse(model.credentialsUnreadable, "a pairing that went with the app is not an error")
    }

    func testAnUnreadableContainerShowsTheWelcomeScreenAndKeepsThePairing() async throws {
        let marker = MemoryMarker()
        let vault = try stored(marker)
        let kept = vault.contents
        marker.makeUnreadable()
        let model = AppModel(store: InstallBoundCredentialStore(vault: vault, marker: marker),
                             connector: Connector(prober: ScriptedProber([:])))
        model.start()
        XCTAssertEqual(model.state, .welcome)
        XCTAssertTrue(model.credentialsUnreadable)
        XCTAssertEqual(vault.contents, kept)
    }

    func testPairingFailsWhenTheInstallationCannotBeRecorded() throws {
        let marker = MemoryMarker()
        marker.makeReadOnly()
        let model = AppModel(store: InstallBoundCredentialStore(vault: MemoryVault(), marker: marker),
                             connector: Connector(prober: ScriptedProber([:])))
        model.start()
        XCTAssertThrowsError(try model.pair(with: sampleMac))
        XCTAssertNil(model.mac)
        XCTAssertEqual(model.state, .welcome)
    }
}
