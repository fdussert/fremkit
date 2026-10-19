import Darwin
import Foundation
import XCTest
@testable import FremkitCore

/// The walker against a real fixture tree in a temporary directory.
final class DiskWalkerTests: XCTestCase {
    private var root = ""
    private var mounted: String?

    override func setUp() {
        root = NSTemporaryDirectory() + "fremkit-scan-test-\(getpid())-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        if let mounted { _ = run("/usr/bin/hdiutil", ["detach", mounted, "-force"]) }
        // An unreadable directory has to be readable again before it can be removed.
        _ = chmod(root + "/locked", 0o755)
        try? FileManager.default.removeItem(atPath: root)
    }

    private func write(_ relative: String, bytes: Int) {
        let path = root + "/" + relative
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: path, contents: Data(repeating: 0x5a, count: bytes))
    }

    /// What `lstat` says the file takes on the disk, the reference `du` uses too.
    private func allocated(_ relative: String) -> UInt64 {
        var info = stat()
        _ = lstat(root + "/" + relative, &info)
        return UInt64(info.st_blocks) * 512
    }

    @discardableResult
    private func run(_ tool: String, _ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return -1 }
        process.waitUntilExit()
        return process.terminationStatus
    }

    private func scan(_ policy: DiskScanPolicy = DiskScanPolicy(depth: 6, minBytes: 1, maxChildren: 100, budget: 1000, progressDepth: 1)) throws -> (DiskNode, DiskWalkStats) {
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: policy))
        let tree = try walker.walk(root: root)
        return (tree, walker.stats)
    }

    private func child(_ node: DiskNode?, _ name: String) -> DiskNode? {
        node?.children.first { $0.name == name }
    }

    func testTooDeepIsUnreadableNotEntered() throws {
        write("a/b/c/d/deep.bin", bytes: 50_000)
        let policy = DiskScanPolicy(depth: 6, minBytes: 1, maxChildren: 100, budget: 1000, progressDepth: 1)
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: policy), maxDepth: 2)
        let tree = try walker.walk(root: root)
        // The root is depth 0: `a` and `a/b` are entered, `a/b/c` is not.
        let b = child(child(tree, "a"), "b")
        XCTAssertEqual(child(b, "c")?.kind, .unreadable)
        XCTAssertEqual(walker.stats.unreadable, 1)
        XCTAssertEqual(tree.unreadable, 1)
        XCTAssertTrue(tree.size < allocated("a/b/c/d/deep.bin"))
    }

    func testCountsAllocatedSizesLikeLstat() throws {
        write("a/one.bin", bytes: 200_000)
        write("a/b/two.bin", bytes: 50_000)
        write("three.bin", bytes: 10)
        let (tree, stats) = try scan()
        let files = allocated("a/one.bin") + allocated("a/b/two.bin") + allocated("three.bin")
        let a = child(tree, "a")
        XCTAssertEqual(child(a, "one.bin")?.size, allocated("a/one.bin"))
        XCTAssertEqual(child(child(a, "b"), "two.bin")?.size, allocated("a/b/two.bin"))
        XCTAssertTrue(tree.size >= files)
        XCTAssertEqual(tree.files, 3)
        XCTAssertEqual(stats.directories, 3)
        XCTAssertEqual(stats.unreadable, 0)
    }

    func testHardLinksCountOnce() throws {
        write("data/original.bin", bytes: 300_000)
        XCTAssertEqual(link(root + "/data/original.bin", root + "/data/second-name.bin"), 0)
        write("data/other/x", bytes: 1)
        XCTAssertEqual(link(root + "/data/original.bin", root + "/data/other/third-name.bin"), 0)
        let (tree, _) = try scan()
        let once = allocated("data/original.bin")
        let data = child(tree, "data")
        XCTAssertEqual(data?.files, 2)
        let linked = (data?.children ?? []).filter { $0.kind == .file && $0.size == once }
        XCTAssertEqual(linked.count, 1)
        XCTAssertTrue((data?.size ?? 0) < once * 2)
    }

    func testSymlinksAreNeverFollowedEvenInALoop() throws {
        write("real/payload.bin", bytes: 400_000)
        XCTAssertEqual(symlink(root + "/real", root + "/link-to-real"), 0)
        XCTAssertEqual(symlink("loop-b", root + "/loop-a"), 0)
        XCTAssertEqual(symlink("loop-a", root + "/loop-b"), 0)
        XCTAssertEqual(symlink(root, root + "/real/up"), 0)
        let (tree, stats) = try scan()
        XCTAssertEqual(stats.directories, 2)
        XCTAssertTrue(tree.size < allocated("real/payload.bin") * 2)
        // A symlink is a leaf counted for its own blocks, never a directory.
        XCTAssertNotEqual(child(tree, "link-to-real")?.kind, .directory)
    }

    func testUnreadableDirectoryIsReportedNotCountedAsEmpty() throws {
        if geteuid() == 0 { return } // root reads everything; nothing to test.
        write("locked/secret.bin", bytes: 100_000)
        write("open/visible.bin", bytes: 100_000)
        XCTAssertEqual(chmod(root + "/locked", 0), 0)
        let (tree, stats) = try scan()
        XCTAssertEqual(stats.unreadable, 1)
        XCTAssertEqual(tree.unreadable, 1)
        XCTAssertEqual(child(tree, "locked")?.kind, .unreadable)
        XCTAssertEqual(child(tree, "open")?.kind, .directory)
    }

    func testAnotherDeviceIsNotCrossed() throws {
        // A real mount point inside the tree: a small disk image attached under it.
        let image = root + "-image.dmg"
        defer { try? FileManager.default.removeItem(atPath: image) }
        let mountPoint = root + "/mnt"
        try? FileManager.default.createDirectory(atPath: mountPoint, withIntermediateDirectories: true)
        guard run("/usr/bin/hdiutil", ["create", "-size", "4m", "-fs", "HFS+", "-volname", "FremkitScanTest", "-ov", image]) == 0,
              run("/usr/bin/hdiutil", ["attach", image, "-mountpoint", mountPoint, "-nobrowse", "-noautoopen", "-noverify"]) == 0 else {
            // Not a silent pass: the brief requires this to be checked. A machine that cannot attach
            // a disk image (a sandbox) opts out explicitly.
            if ProcessInfo.processInfo.environment["FREMKIT_SKIP_MOUNT_TEST"] == "1" {
                print("SKIP testAnotherDeviceIsNotCrossed: FREMKIT_SKIP_MOUNT_TEST=1")
                return
            }
            XCTFail("hdiutil could not attach a disk image; set FREMKIT_SKIP_MOUNT_TEST=1 to skip this test")
            return
        }
        mounted = mountPoint
        FileManager.default.createFile(atPath: mountPoint + "/inside.bin", contents: Data(repeating: 1, count: 1_000_000))
        write("outside.bin", bytes: 1000)
        let (tree, stats) = try scan()
        XCTAssertEqual(stats.otherDevices, 1)
        XCTAssertNil(child(tree, "mnt"))
        XCTAssertTrue(tree.size < 1_000_000)
    }

    func testCancellationStopsTheWalk() {
        write("a/b/c.bin", bytes: 10)
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: .default), isCancelled: { true })
        XCTAssertThrowsError(try walker.walk(root: root)) { error in
            XCTAssertEqual(error as? DiskWalkError, .cancelled)
        }
    }

    func testMissingRootIsAnError() {
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: .default))
        XCTAssertThrowsError(try walker.walk(root: root + "/nope")) { error in
            XCTAssertEqual(error as? DiskWalkError, .rootMissing)
        }
    }

    func testFinishedDirectoriesAreReportedDownToTheProgressDepth() throws {
        write("a/b/c.bin", bytes: 10)
        write("d/e.bin", bytes: 10)
        var reported: [[String]] = []
        let walker = DiskWalker(builder: DiskTreeBuilder(policy: DiskScanPolicy(depth: 6, minBytes: 1, maxChildren: 10, budget: 100, progressDepth: 1)),
                                onDirectory: { path, _ in reported.append(path) })
        _ = try walker.walk(root: root)
        XCTAssertEqual(reported.sorted { $0.joined() < $1.joined() }, [["a"], ["d"]])
    }
}
