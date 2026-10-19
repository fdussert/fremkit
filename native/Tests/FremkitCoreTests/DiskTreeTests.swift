import Foundation
import XCTest
@testable import FremkitCore

final class DiskTreeTests: XCTestCase {
    private func policy(depth: Int = 4, minBytes: UInt64 = 10, maxChildren: Int = 3, budget: Int = 1000) -> DiskScanPolicy {
        DiskScanPolicy(depth: depth, minBytes: minBytes, maxChildren: maxChildren, budget: budget, progressDepth: 1)
    }

    func testSizesAddUpThroughTheTree() {
        let builder = DiskTreeBuilder(policy: policy())
        builder.begin(name: "root", ownSize: 4)
        builder.addFile(name: "a", allocated: 100, device: 1, inode: 1, links: 1)
        builder.begin(name: "sub", ownSize: 4)
        builder.addFile(name: "b", allocated: 50, device: 1, inode: 2, links: 1)
        builder.end()
        let root = builder.end()!
        XCTAssertEqual(root.size, 158)
        XCTAssertEqual(root.files, 2)
        XCTAssertEqual(root.children.map(\.name), ["a", "sub"])
        XCTAssertEqual(root.children[1].size, 54)
    }

    func testHardLinkedFileCountsOnce() {
        let builder = DiskTreeBuilder(policy: policy())
        builder.begin(name: "root")
        builder.addFile(name: "one", allocated: 100, device: 1, inode: 7, links: 2)
        builder.begin(name: "sub")
        builder.addFile(name: "two", allocated: 100, device: 1, inode: 7, links: 2)
        builder.addFile(name: "other", allocated: 100, device: 2, inode: 7, links: 2)
        builder.end()
        let root = builder.end()!
        XCTAssertEqual(root.size, 200)
        XCTAssertEqual(root.files, 2)
    }

    func testSmallEntriesAndTheTailGoIntoOthers() {
        let builder = DiskTreeBuilder(policy: policy(minBytes: 10, maxChildren: 2))
        builder.begin(name: "root")
        builder.addFile(name: "tiny", allocated: 5, device: 1, inode: 1, links: 1)
        builder.addFile(name: "big", allocated: 300, device: 1, inode: 2, links: 1)
        builder.addFile(name: "mid", allocated: 200, device: 1, inode: 3, links: 1)
        builder.addFile(name: "third", allocated: 20, device: 1, inode: 4, links: 1)
        let root = builder.end()!
        XCTAssertEqual(root.children.map(\.name), ["big", "mid"])
        XCTAssertEqual(root.othersCount, 2)
        XCTAssertEqual(root.othersSize, 25)
        XCTAssertEqual(root.size, 525)
        XCTAssertFalse(root.more)
    }

    func testTheBudgetMarksMoreWhenItDropsSomethingWorthDrawing() {
        let builder = DiskTreeBuilder(policy: policy(minBytes: 1, maxChildren: 10))
        builder.begin(name: "root")
        builder.begin(name: "a")
        builder.addFile(name: "x", allocated: 600, device: 1, inode: 1, links: 1)
        builder.addFile(name: "y", allocated: 400, device: 1, inode: 2, links: 1)
        builder.end()
        let root = builder.end()!
        XCTAssertFalse(root.children[0].more)
        DiskTreePruner.applyBudget(root, budget: 2)
        // "y" is 40 % of "a": dropped by the budget, so looking inside "a" rescans it.
        XCTAssertEqual(root.children[0].children.map(\.name), ["x"])
        XCTAssertTrue(root.children[0].more)
    }

    func testCandidatesAreTrimmedWhileTheFolderIsWalked() {
        let builder = DiskTreeBuilder(policy: policy(minBytes: 1, maxChildren: 2))
        builder.begin(name: "root")
        for i in 1...50 { builder.addFile(name: "f\(i)", allocated: UInt64(i), device: 1, inode: UInt64(i), links: 1) }
        let root = builder.end()!
        XCTAssertEqual(root.children.map(\.name), ["f50", "f49"])
        XCTAssertEqual(root.othersCount, 48)
        XCTAssertEqual(root.size, 1275)
        XCTAssertEqual(root.othersSize, 1275 - 99)
        XCTAssertFalse(root.more)
    }

    func testEntriesBelowTheDepthAreNotHeldButCounted() {
        let builder = DiskTreeBuilder(policy: policy(depth: 1))
        builder.begin(name: "root")
        builder.begin(name: "level1")
        builder.begin(name: "level2")
        builder.addFile(name: "deep", allocated: 1000, device: 1, inode: 1, links: 1)
        builder.end()
        builder.end()
        let root = builder.end()!
        let level1 = root.children[0]
        XCTAssertEqual(level1.name, "level1")
        XCTAssertEqual(level1.size, 1000)
        XCTAssertTrue(level1.children.isEmpty)
        XCTAssertTrue(level1.more)
        XCTAssertEqual(level1.othersCount, 1)
    }

    func testUnreadableDirectoriesAreKeptAndCountedNeverAsSmall() {
        let builder = DiskTreeBuilder(policy: policy(minBytes: 10))
        builder.begin(name: "root")
        builder.addFile(name: "a", allocated: 100, device: 1, inode: 1, links: 1)
        builder.begin(name: "inner")
        builder.addUnreadable(name: "Mail")
        builder.end()
        builder.addUnreadable(name: "Safari")
        let root = builder.end()!
        XCTAssertEqual(root.unreadable, 2)
        XCTAssertEqual(root.children.map(\.name), ["a", "inner", "Safari"])
        XCTAssertEqual(root.children[2].kind, .unreadable)
        // "inner" is smaller than minBytes, but holds an unreadable folder: kept so it can be shown.
        XCTAssertEqual(root.children[1].children.first?.kind, .unreadable)
    }

    func testBudgetKeepsTheLargestNodesAndFoldsTheRest() {
        let builder = DiskTreeBuilder(policy: policy(minBytes: 1, maxChildren: 10, budget: 2))
        builder.begin(name: "root")
        builder.begin(name: "big")
        builder.addFile(name: "f1", allocated: 500, device: 1, inode: 1, links: 1)
        builder.addFile(name: "f2", allocated: 2, device: 1, inode: 2, links: 1)
        builder.end()
        builder.begin(name: "small")
        builder.addFile(name: "f3", allocated: 3, device: 1, inode: 3, links: 1)
        builder.end()
        builder.addUnreadable(name: "locked")
        let root = builder.end()!
        DiskTreePruner.applyBudget(root, budget: 2)
        XCTAssertEqual(root.children.map(\.name), ["big", "locked"])
        XCTAssertEqual(root.children[0].children.map(\.name), ["f1"])
        XCTAssertEqual(root.othersCount, 1)
        XCTAssertEqual(root.othersSize, 3)
        XCTAssertEqual(root.children[0].othersCount, 1)
        XCTAssertEqual(root.nodeCount, 4)
    }

    func testJSONEscapesNamesAndLeavesDefaultsOut() {
        let node = DiskNode(name: "a\"b\\c\n\u{1}é", kind: .directory, size: 12, files: 1,
                            children: [DiskNode(name: "x", kind: .unreadable, unreadable: 1)], othersCount: 2, othersSize: 3, more: true)
        XCTAssertEqual(DiskScanJSON.node(node),
                       "{\"name\":\"a\\\"b\\\\c\\n\\u0001é\",\"kind\":\"d\",\"size\":12,\"files\":1,\"others\":[2,3],\"more\":true,"
                       + "\"children\":[{\"name\":\"x\",\"kind\":\"x\",\"size\":0,\"unreadable\":1}]}")
        let parsed = try? JSONSerialization.jsonObject(with: Data(DiskScanJSON.node(node).utf8)) as? [String: Any]
        XCTAssertEqual(parsed?["name"] as? String, "a\"b\\c\n\u{1}é")
    }

    func testArgumentsParseWithDefaults() throws {
        let parsed = try DiskScanArguments.parse(["/Users/example"])
        XCTAssertEqual(parsed.root, "/Users/example")
        XCTAssertEqual(parsed.policy, DiskScanPolicy.default)
        let custom = try DiskScanArguments.parse(["--depth", "3", "--min-bytes", "4096", "--max-children", "50",
                                                  "--budget", "500", "--progress-depth", "2", "--", "/Volumes/-odd"])
        XCTAssertEqual(custom.root, "/Volumes/-odd")
        XCTAssertEqual(custom.policy, DiskScanPolicy(depth: 3, minBytes: 4096, maxChildren: 50, budget: 500, progressDepth: 2))
    }

    func testArgumentsRefuseWhatIsOutOfBounds() {
        XCTAssertThrowsError(try DiskScanArguments.parse([String]()))
        XCTAssertThrowsError(try DiskScanArguments.parse(["relative/path"]))
        XCTAssertThrowsError(try DiskScanArguments.parse(["/a", "/b"]))
        XCTAssertThrowsError(try DiskScanArguments.parse(["--depth", "0", "/a"]))
        XCTAssertThrowsError(try DiskScanArguments.parse(["--depth", "-1", "/a"]))
        XCTAssertThrowsError(try DiskScanArguments.parse(["--depth", "1e3", "/a"]))
        XCTAssertThrowsError(try DiskScanArguments.parse(["--budget", "1", "/a"]))
        XCTAssertThrowsError(try DiskScanArguments.parse(["--depth"]))
        XCTAssertThrowsError(try DiskScanArguments.parse(["--follow", "/a"]))
        XCTAssertThrowsError(try DiskScanArguments.parse(["/a\u{0}b"]))
    }
}
