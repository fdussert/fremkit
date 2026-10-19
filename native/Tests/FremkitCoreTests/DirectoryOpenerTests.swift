import Darwin
import Foundation
import XCTest
@testable import FremkitCore

/// The guarded open, with an injected `openat` that blocks the way a pending privacy prompt does.
final class DirectoryOpenerTests: XCTestCase {
    private var root = ""
    /// Released at tearDown, so no blocked test thread outlives its test by more than a moment.
    private let release = DispatchSemaphore(value: 0)

    override func setUp() {
        root = NSTemporaryDirectory() + "fremkit-open-test-\(getpid())-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        for _ in 0..<16 { release.signal() }
        try? FileManager.default.removeItem(atPath: root)
    }

    private func write(_ relative: String, bytes: Int) {
        let path = root + "/" + relative
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: path, contents: Data(repeating: 0x5a, count: bytes))
    }

    /// `openat`, except that the names in `blocked` wait for `release` (at most 5 s) first.
    private func blockingOpen(_ blocked: Set<String>, release: DispatchSemaphore) -> DirectoryOpener.OpenCall {
        return { parent, path, flags in
            if blocked.contains((path as NSString).lastPathComponent) { _ = release.wait(timeout: .now() + 5) }
            return DirectoryOpener.system(parent, path, flags)
        }
    }

    private func child(_ node: DiskNode?, _ name: String) -> DiskNode? {
        node?.children.first { $0.name == name }
    }

    private let policy = DiskScanPolicy(depth: 6, minBytes: 1, maxChildren: 100, budget: 1000, progressDepth: 1)

    func testABlockedOpenIsReportedThenGivenUpAndTheWalkGoesOn() throws {
        write("Documents/secret.bin", bytes: 10_000)
        write("Movies/film.bin", bytes: 10_000)
        let opener = DirectoryOpener(grace: 0.05, timeout: 0.3, open: blockingOpen(["Documents"], release: release))
        var waiting: [[String]?] = []
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: policy), opener: opener, guardedDepth: .max, onWaiting: { waiting.append($0) })
        let tree = try walker.walk(root: root)
        XCTAssertEqual(waiting, [["Documents"], nil])
        XCTAssertEqual(child(tree, "Documents")?.kind, .unreadable)
        XCTAssertEqual(child(tree, "Movies")?.kind, .directory)
        XCTAssertEqual(walker.stats.unreadable, 1)
    }

    func testAnOpenAnsweredAfterTheGraceIsUsed() throws {
        write("Documents/letter.bin", bytes: 10_000)
        let release = self.release
        let opener = DirectoryOpener(grace: 0.05, timeout: 5, open: blockingOpen(["Documents"], release: release))
        var waiting: [[String]?] = []
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: policy), opener: opener, guardedDepth: .max, onWaiting: { path in
            waiting.append(path)
            // The user answers once the walk has said it waits.
            if path != nil { release.signal() }
        })
        let tree = try walker.walk(root: root)
        XCTAssertEqual(waiting, [["Documents"], nil])
        XCTAssertEqual(child(tree, "Documents")?.kind, .directory)
        XCTAssertEqual(child(tree, "Documents")?.files, 1)
        XCTAssertEqual(walker.stats.unreadable, 0)
    }

    func testCancellationWhileWaitingStopsTheWalk() {
        write("Documents/secret.bin", bytes: 10)
        let opener = DirectoryOpener(grace: 0.05, timeout: 30, open: blockingOpen(["Documents"], release: release))
        var cancelled = false
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: policy), isCancelled: { cancelled }, opener: opener, guardedDepth: .max,
                                onWaiting: { if $0 != nil { cancelled = true } })
        let started = Date()
        XCTAssertThrowsError(try walker.walk(root: root)) { error in
            XCTAssertEqual(error as? DiskWalkError, .cancelled)
        }
        XCTAssertTrue(Date().timeIntervalSince(started) < 5)
    }

    func testABlockedRootIsUnreadable() {
        let opener = DirectoryOpener(grace: 0.05, timeout: 0.2, open: blockingOpen([(root as NSString).lastPathComponent], release: release))
        var waiting: [[String]?] = []
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: policy), opener: opener, guardedDepth: .max, onWaiting: { waiting.append($0) })
        XCTAssertThrowsError(try walker.walk(root: root)) { error in
            XCTAssertEqual(error as? DiskWalkError, .rootUnreadable(ETIMEDOUT))
        }
        XCTAssertEqual(waiting, [[], nil])
    }

    func testAnAbandonedOpenIsClosedWhenItFinallyReturns() {
        write("Documents/x.bin", bytes: 10)
        var returned: Int32 = -1
        let lock = NSLock()
        let release = self.release
        let opener = DirectoryOpener(grace: 0.02, timeout: 0.05, open: { parent, path, flags in
            _ = release.wait(timeout: .now() + 5)
            let r = DirectoryOpener.system(parent, path, flags)
            lock.lock(); returned = r.fd; lock.unlock()
            return r
        })
        XCTAssertEqual(opener.open(parent: AT_FDCWD, path: root + "/Documents", flags: O_RDONLY | O_DIRECTORY), .timedOut)
        XCTAssertEqual(opener.blockedCount, 1)
        release.signal()
        let deadline = Date().addingTimeInterval(5)
        while opener.blockedCount > 0 && Date() < deadline { usleep(5_000) }
        XCTAssertEqual(opener.blockedCount, 0)
        lock.lock(); let fd = returned; lock.unlock()
        XCTAssertTrue(fd >= 0)
        // The worker closed it: the descriptor is no longer valid (nothing else opened one meanwhile).
        XCTAssertEqual(fcntl(fd, F_GETFD), -1)
        // And a fresh worker takes the next open (let it through the injected wait at once).
        release.signal()
        if case .opened(let next) = opener.open(parent: AT_FDCWD, path: root, flags: O_RDONLY | O_DIRECTORY) {
            close(next)
        } else {
            XCTFail("the next open did not go through")
        }
    }

    func testWhileAPromptIsUnansweredLaterOpensGiveUpAfterTheGrace() throws {
        for name in ["Desktop", "Documents", "Downloads"] { write("\(name)/x.bin", bytes: 10) }
        let opener = DirectoryOpener(grace: 0.05, timeout: 1.5, open: blockingOpen(["Desktop", "Documents", "Downloads"], release: release))
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: policy), opener: opener, guardedDepth: .max)
        let started = Date()
        let tree = try walker.walk(root: root)
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertEqual(walker.stats.unreadable, 3)
        XCTAssertEqual(tree.unreadable, 3)
        // One full timeout, then two graces; three full timeouts would be 4.5 s.
        XCTAssertTrue(elapsed < 2.8, "took \(elapsed) s")
    }

    func testOnlyTheTopOfTheTreeGoesThroughTheOpener() throws {
        write("a/deep/x.bin", bytes: 10)
        let release = self.release
        let opener = DirectoryOpener(grace: 0.05, timeout: 30, open: blockingOpen(["a", "deep"], release: release))
        var waiting: [[String]?] = []
        let components = root.split(separator: "/").count
        // `a` is guarded (and held), `a/deep` is one level past the guarded depth: opened directly.
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: policy), opener: opener, guardedDepth: components + 1,
                                onWaiting: { path in waiting.append(path); if path != nil { release.signal() } })
        let tree = try walker.walk(root: root)
        XCTAssertEqual(waiting, [["a"], nil])
        XCTAssertEqual(child(child(tree, "a"), "deep")?.files, 1)
    }

    func testPastTheCapTheWalkWaitsForAnAnswerRatherThanLeaveAThread() throws {
        write("Documents/x.bin", bytes: 10)
        write("Downloads/y.bin", bytes: 10)
        let release = self.release
        let opener = DirectoryOpener(grace: 0.05, timeout: 0.1, maxAbandoned: 1, open: blockingOpen(["Documents", "Downloads"], release: release))
        var waits = 0
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: policy), opener: opener, guardedDepth: .max, onWaiting: { path in
            guard path != nil else { return }
            waits += 1
            // The second blocked open is past the cap: it is only answered after a while, and is used.
            // Two signals: one for each blocked thread, whichever the semaphore wakes first.
            if waits == 2 { DispatchQueue.global().asyncAfter(deadline: .now() + 0.4) { release.signal(); release.signal() } }
        })
        let tree = try walker.walk(root: root)
        XCTAssertEqual(waits, 2)
        XCTAssertEqual(walker.stats.unreadable, 1)
        XCTAssertEqual(tree.children.filter { $0.kind == .directory }.count, 1)
        XCTAssertTrue(opener.blockedCount <= 1)
    }
}
