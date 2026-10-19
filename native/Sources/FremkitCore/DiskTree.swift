import Foundation

/// What a node of the disk map is.
public enum DiskNodeKind: String {
    case directory = "d"
    case file = "f"
    /// A directory that could not be opened (`EACCES`, `EPERM`: TCC or plain permissions). Its
    /// size is unknown, never zero: it is reported as unreadable so nobody reads it as empty.
    case unreadable = "x"
}

/// One entry of the pruned tree `fremkit-scan` prints.
public final class DiskNode {
    public var name: String
    public var kind: DiskNodeKind
    /// Allocated bytes, like `du`: what the entry actually takes on the disk.
    public var size: UInt64
    /// Files below (a hard-linked file counted once).
    public var files: UInt64
    /// Unreadable directories below, this one included.
    public var unreadable: UInt64
    public var children: [DiskNode]
    /// Entries that were not held one by one: how many, and how much they take together.
    public var othersCount: UInt64
    public var othersSize: UInt64
    /// True when entries worth drawing are below this one but were not held — cut by the depth or
    /// the node budget. Whoever wants to look inside rescans it.
    public var more: Bool

    public init(name: String, kind: DiskNodeKind, size: UInt64 = 0, files: UInt64 = 0, unreadable: UInt64 = 0,
                children: [DiskNode] = [], othersCount: UInt64 = 0, othersSize: UInt64 = 0, more: Bool = false) {
        self.name = name
        self.kind = kind
        self.size = size
        self.files = files
        self.unreadable = unreadable
        self.children = children
        self.othersCount = othersCount
        self.othersSize = othersSize
        self.more = more
    }

    /// Total number of nodes in this subtree, this one included.
    public var nodeCount: Int { 1 + children.reduce(0) { $0 + $1.nodeCount } }
}

/// A file's identity, for counting a hard-linked file once.
public struct DiskFileKey: Hashable {
    public var device: UInt64
    public var inode: UInt64
    public init(device: UInt64, inode: UInt64) {
        self.device = device
        self.inode = inode
    }
}

/// A child worth more than this share of its parent is never quietly folded away: the widget
/// draws anything from about 3° of the ring, and 1/120 of the circle is 3°.
public let diskVisibleShare: UInt64 = 120

/// Builds the pruned tree while a walk goes depth first.
///
/// The walker calls `begin` when it enters a directory, `addFile`/`addUnreadable` for what it
/// finds there, and `end` when the directory is done. Only directories at most `policy.depth`
/// levels below the root hold child nodes, each keeping its `maxChildren` largest entries of at
/// least `minBytes`; everything else only adds its size. A folder's candidates are trimmed to
/// `maxChildren` as they arrive, so no folder holds more than twice that many at once; the node
/// budget (`DiskTreePruner`) is applied once the walk is over.
public final class DiskTreeBuilder {
    public let policy: DiskScanPolicy

    private struct Frame {
        var node: DiskNode
        var depth: Int
        var holdsChildren: Bool
        var candidates: [DiskNode] = []
        var entries: UInt64 = 0
    }

    private var stack: [Frame] = []
    private var seenLinked = Set<DiskFileKey>()
    public private(set) var root: DiskNode?

    public init(policy: DiskScanPolicy) {
        self.policy = policy
    }

    /// Depth of the directory being filled: 0 for the root, -1 before `begin`.
    public var depth: Int { stack.count - 1 }

    /// Names from the root's children down to the directory being filled.
    public var path: [String] { stack.dropFirst().map { $0.node.name } }

    /// Enters a directory. `ownSize` is the space the directory itself takes.
    public func begin(name: String, ownSize: UInt64 = 0) {
        let depth = stack.count
        let node = DiskNode(name: name, kind: .directory, size: ownSize)
        stack.append(Frame(node: node, depth: depth, holdsChildren: depth < policy.depth))
    }

    /// A file (or a symlink, or anything that is not a directory) in the current directory.
    ///
    /// A file with more than one link is counted the first time one of its names is met, like
    /// `du`: its blocks are on the disk once, whichever folder it is seen from.
    public func addFile(name: String, allocated: UInt64, device: UInt64, inode: UInt64, links: UInt32) {
        guard !stack.isEmpty else { return }
        if links > 1 {
            let key = DiskFileKey(device: device, inode: inode)
            if !seenLinked.insert(key).inserted { return }
        }
        let index = stack.count - 1
        stack[index].node.size &+= allocated
        stack[index].node.files &+= 1
        stack[index].entries &+= 1
        guard stack[index].holdsChildren else { return }
        if allocated >= policy.minBytes && allocated > 0 {
            stack[index].candidates.append(DiskNode(name: name, kind: .file, size: allocated, files: 1))
            trimIfFull(index)
        } else {
            stack[index].node.othersCount &+= 1
            stack[index].node.othersSize &+= allocated
        }
    }

    /// A subdirectory of the current directory that could not be opened.
    public func addUnreadable(name: String) {
        guard !stack.isEmpty else { return }
        let index = stack.count - 1
        stack[index].node.unreadable &+= 1
        stack[index].entries &+= 1
        guard stack[index].holdsChildren else { return }
        stack[index].candidates.append(DiskNode(name: name, kind: .unreadable, unreadable: 1))
    }

    /// The current directory opened but could not be listed to the end.
    public func markPartiallyUnreadable() {
        guard !stack.isEmpty else { return }
        stack[stack.count - 1].node.unreadable &+= 1
    }

    /// Leaves the current directory and hands its finished node back (the root's, after the last).
    @discardableResult
    public func end() -> DiskNode? {
        guard var frame = stack.popLast() else { return nil }
        let node = frame.node
        if frame.holdsChildren {
            DiskTreeBuilder.keepLargest(&frame.candidates, in: node, maxChildren: policy.maxChildren)
        } else if frame.entries > 0 {
            // Cut by the depth: the entries are there, only not held.
            node.othersCount &+= frame.entries
            node.othersSize = node.size
            node.more = true
        }
        if stack.isEmpty {
            root = node
            return node
        }
        let parent = stack.count - 1
        stack[parent].node.size &+= node.size
        stack[parent].node.files &+= node.files
        stack[parent].node.unreadable &+= node.unreadable
        stack[parent].entries &+= 1
        if stack[parent].holdsChildren {
            if node.size >= policy.minBytes || node.unreadable > 0 {
                stack[parent].candidates.append(node)
                trimIfFull(parent)
            } else {
                stack[parent].node.othersCount &+= 1
                stack[parent].node.othersSize &+= node.size
            }
        }
        return node
    }

    /// A folder with thousands of large entries would hold them all until it ends: once there are
    /// twice `maxChildren` candidates, the smallest are folded into "others" right away.
    private func trimIfFull(_ index: Int) {
        guard stack[index].candidates.count >= 2 * policy.maxChildren else { return }
        DiskTreeBuilder.keepLargest(&stack[index].candidates, in: stack[index].node, maxChildren: policy.maxChildren)
        stack[index].candidates = stack[index].node.children
        stack[index].node.children = []
    }

    /// Keeps the `maxChildren` largest candidates, and the unreadable ones up to the same count;
    /// the rest goes into the node's "others". This never marks the node `more`: scanning the
    /// folder again would apply the same cut and show the same "others".
    static func keepLargest(_ candidates: inout [DiskNode], in node: DiskNode, maxChildren: Int) {
        var readable = candidates.filter { $0.kind != .unreadable }
        var unreadable = candidates.filter { $0.kind == .unreadable }
        readable.sort(by: DiskTreeBuilder.largerFirst)
        unreadable.sort { $0.name < $1.name }
        if readable.count > maxChildren {
            for dropped in readable[maxChildren...] {
                node.othersCount &+= 1
                node.othersSize &+= dropped.size
            }
            readable.removeSubrange(maxChildren...)
        }
        if unreadable.count > maxChildren {
            node.othersCount &+= UInt64(unreadable.count - maxChildren)
            unreadable.removeSubrange(maxChildren...)
        }
        node.children = readable + unreadable
    }

    /// Size first, then name, so the order never depends on how the disk listed the folder.
    static func largerFirst(_ a: DiskNode, _ b: DiskNode) -> Bool {
        a.size != b.size ? a.size > b.size : a.name < b.name
    }
}

/// The final cut: at most `budget` nodes, the largest first.
public enum DiskTreePruner {
    /// Keeps the `budget` largest nodes below the root (an ancestor is never smaller than its
    /// descendants, so the kept set is a tree), plus the unreadable children of kept nodes. A
    /// dropped child goes into its parent's "others"; a dropped entry big enough to be drawn
    /// marks the parent `more`, so looking inside it rescans instead of showing a blank.
    public static func applyBudget(_ root: DiskNode, budget: Int) {
        var all: [(node: DiskNode, depth: Int)] = []
        func collect(_ node: DiskNode, _ depth: Int) {
            for child in node.children {
                if child.kind != .unreadable { all.append((child, depth)) }
                collect(child, depth + 1)
            }
        }
        collect(root, 1)
        guard all.count > budget else { return }
        all.sort { a, b in
            if a.node.size != b.node.size { return a.node.size > b.node.size }
            return a.depth < b.depth
        }
        var kept = Set<ObjectIdentifier>()
        for entry in all.prefix(budget) { kept.insert(ObjectIdentifier(entry.node)) }
        func prune(_ node: DiskNode) {
            var children: [DiskNode] = []
            for child in node.children {
                if child.kind == .unreadable || kept.contains(ObjectIdentifier(child)) {
                    children.append(child)
                    prune(child)
                } else {
                    node.othersCount &+= 1
                    node.othersSize &+= child.size
                    if child.size &* diskVisibleShare >= node.size { node.more = true }
                }
            }
            node.children = children
        }
        prune(root)
    }
}

/// The JSON `fremkit-scan` prints, written by hand: one line per object, keys in a fixed order,
/// default values left out.
public enum DiskScanJSON {
    public static func string(_ value: String) -> String {
        var out = "\""
        out.reserveCapacity(value.utf8.count + 2)
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 || scalar.value == 0x2028 || scalar.value == 0x2029 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    public static func path(_ components: [String]) -> String {
        "[" + components.map(string).joined(separator: ",") + "]"
    }

    public static func node(_ node: DiskNode) -> String {
        var out = ""
        write(node, into: &out)
        return out
    }

    private static func write(_ node: DiskNode, into out: inout String) {
        out += "{\"name\":"
        out += string(node.name)
        out += ",\"kind\":\"\(node.kind.rawValue)\",\"size\":\(node.size)"
        if node.files > 0 { out += ",\"files\":\(node.files)" }
        if node.unreadable > 0 { out += ",\"unreadable\":\(node.unreadable)" }
        if node.othersCount > 0 || node.othersSize > 0 { out += ",\"others\":[\(node.othersCount),\(node.othersSize)]" }
        if node.more { out += ",\"more\":true" }
        if !node.children.isEmpty {
            out += ",\"children\":["
            for (index, child) in node.children.enumerated() {
                if index > 0 { out += "," }
                write(child, into: &out)
            }
            out += "]"
        }
        out += "}"
    }
}
