import Darwin
import Foundation

/// Counters of one walk, printed as progress and in the final line.
public struct DiskWalkStats: Equatable {
    public var directories: UInt64 = 0
    public var files: UInt64 = 0
    public var bytes: UInt64 = 0
    /// Directories that could not be opened or listed to the end.
    public var unreadable: UInt64 = 0
    /// Entries the file system returned an error for, and directories that vanished mid-walk.
    public var errors: UInt64 = 0
    /// Directories on another device (a mount point) that were not entered, like `du -x`.
    public var otherDevices: UInt64 = 0
    /// Dataless directories (a File Provider placeholder, e.g. iCloud Drive) that were not entered,
    /// so the walk never asks for them to be downloaded.
    public var dataless: UInt64 = 0

    public init() {}
}

/// Why a walk could not even start.
public enum DiskWalkError: Error, Equatable {
    case rootUnreadable(Int32)
    case rootMissing
    case rootNotADirectory
    case cancelled
}

/// Walks a directory tree with `getattrlistbulk(2)`, the call DaisyDisk and GrandPerspective use:
/// one system call returns the name, type, device, inode, link count and allocated size of many
/// entries at once, without a `stat` per file and without ever opening a file.
///
/// Never follows a symlink (it is an entry, counted for its own blocks), never enters another
/// device (the root's `st_dev`, like `du -x`), never enters a dataless directory.
public final class DiskWalker {
    private let builder: DiskTreeBuilder
    private let isCancelled: () -> Bool
    private let onDirectory: (_ path: [String], _ node: DiskNode) -> Void
    private let onTick: (_ stats: DiskWalkStats, _ path: [String]) -> Void
    private let tickEvery: TimeInterval
    private var lastTick = Date()
    private var rootDevice: dev_t = 0
    private var buffers: [UnsafeMutableRawPointer] = []
    public private(set) var stats = DiskWalkStats()

    static let bufferSize = 128 * 1024
    /// How deep the walk goes before a directory is counted as unreadable instead of entered.
    /// Each level holds a 128 KB buffer and an open descriptor; a process starts with 256 of
    /// those, so a tree nested past this (a runaway build, a crafted one) would otherwise end in
    /// failed opens counted as nothing, or in a large allocation.
    public static let defaultMaxDepth = 128
    private let maxDepth: Int
    private let opener: DirectoryOpener
    private let onWaiting: (_ path: [String]?) -> Void

    /// How deep, counted in components of the absolute path, a directory's open goes through the
    /// `DirectoryOpener`; deeper ones are opened directly.
    ///
    /// The folders macOS asks about all sit near the top: `/Volumes/X` (a removable or network
    /// volume), `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Library/Mobile Documents` (iCloud
    /// Drive), `~/Library/Containers/X` and `~/Library/Group Containers/X` (other apps' data), and
    /// `~/Library/Containers/X/Data` at 6. The hand-off to the opener's thread costs a few
    /// microseconds; on a home folder of 236 000 directories, paying it for every one of them made
    /// a warm scan some 15 % slower, while the directories down to this depth are a few thousand.
    public static let defaultGuardedDepth = 6
    private let guardedDepth: Int
    /// Components of the root's path, `/Users/me` being 2.
    private var rootComponents = 0

    /// `onWaiting` gets the path (below the root, [] for the root itself) of a directory whose open
    /// macOS is holding, typically behind a privacy prompt, and nil once that open is over.
    public init(builder: DiskTreeBuilder,
                isCancelled: @escaping () -> Bool = { false },
                tickEvery: TimeInterval = 0.25,
                maxDepth: Int = DiskWalker.defaultMaxDepth,
                opener: DirectoryOpener = DirectoryOpener(),
                guardedDepth: Int = DiskWalker.defaultGuardedDepth,
                onDirectory: @escaping (_ path: [String], _ node: DiskNode) -> Void = { _, _ in },
                onTick: @escaping (_ stats: DiskWalkStats, _ path: [String]) -> Void = { _, _ in },
                onWaiting: @escaping (_ path: [String]?) -> Void = { _ in }) {
        self.builder = builder
        self.isCancelled = isCancelled
        self.tickEvery = tickEvery
        self.maxDepth = maxDepth
        self.opener = opener
        self.guardedDepth = guardedDepth
        self.onDirectory = onDirectory
        self.onTick = onTick
        self.onWaiting = onWaiting
    }

    /// `path` is only built when the open is slow: on the fast path it would cost an array per directory.
    private func guardedOpen(_ parent: Int32, _ name: String, flags: Int32, path: @autoclosure () -> [String]) -> GuardedOpenResult {
        opener.open(parent: parent, path: name, flags: flags, isCancelled: isCancelled,
                    onWaiting: { waiting in self.onWaiting(waiting ? path() : nil) })
    }

    deinit {
        for buffer in buffers { buffer.deallocate() }
    }

    /// Walks `root` and returns the finished tree (before the node budget, see `DiskTreePruner`).
    public func walk(root: String) throws -> DiskNode {
        // The root is the one path that is followed if it is a symlink, like `du`: it is what
        // the caller asked for. Nothing below it is.
        // Guarded too: a scan of ~/Documents itself is held by the same privacy prompt.
        rootComponents = root.split(separator: "/").count
        let fd: Int32
        switch guardedOpen(AT_FDCWD, root, flags: O_RDONLY | O_DIRECTORY | O_CLOEXEC, path: []) {
        case .opened(let opened): fd = opened
        case .cancelled: throw DiskWalkError.cancelled
        case .timedOut: throw DiskWalkError.rootUnreadable(ETIMEDOUT)
        case .failed(let code):
            switch code {
            case ENOENT: throw DiskWalkError.rootMissing
            case ENOTDIR: throw DiskWalkError.rootNotADirectory
            default: throw DiskWalkError.rootUnreadable(code)
            }
        }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw DiskWalkError.rootUnreadable(errno) }
        rootDevice = info.st_dev
        let name = root == "/" ? "/" : (root as NSString).lastPathComponent
        builder.begin(name: name, ownSize: UInt64(max(0, info.st_blocks)) * 512)
        stats.directories += 1
        try walkDirectory(fd)
        guard let tree = builder.end() else { throw DiskWalkError.rootMissing }
        // The running counts above include every name of a hard-linked file; the tree's do not.
        stats.bytes = tree.size
        stats.files = tree.files
        return tree
    }

    // MARK: - One directory

    private struct Subdirectory {
        var name: String
        var allocated: UInt64
    }

    private func buffer(forDepth depth: Int) -> UnsafeMutableRawPointer {
        while buffers.count <= depth {
            buffers.append(UnsafeMutableRawPointer.allocate(byteCount: Self.bufferSize, alignment: 16))
        }
        return buffers[depth]
    }

    private func walkDirectory(_ fd: Int32) throws {
        let depth = builder.depth
        let buffer = buffer(forDepth: depth)
        var request = attrlist()
        request.bitmapcount = u_short(ATTR_BIT_MAP_COUNT)
        request.commonattr = attrgroup_t(ATTR_CMN_RETURNED_ATTRS) | attrgroup_t(ATTR_CMN_NAME)
            | attrgroup_t(ATTR_CMN_ERROR) | attrgroup_t(ATTR_CMN_DEVID) | attrgroup_t(ATTR_CMN_OBJTYPE)
            | attrgroup_t(ATTR_CMN_FLAGS) | attrgroup_t(ATTR_CMN_FILEID)
        request.dirattr = attrgroup_t(ATTR_DIR_MOUNTSTATUS) | attrgroup_t(ATTR_DIR_ALLOCSIZE)
        request.fileattr = attrgroup_t(ATTR_FILE_LINKCOUNT) | attrgroup_t(ATTR_FILE_ALLOCSIZE)

        var subdirectories: [Subdirectory] = []
        while true {
            if isCancelled() { throw DiskWalkError.cancelled }
            let count = getattrlistbulk(fd, &request, buffer, Self.bufferSize, 0)
            if count == 0 { break }
            if count < 0 {
                let code = errno
                if code == EINTR { continue }
                // A listing refused half way (TCC can do this) is reported as unreadable, never
                // as a smaller folder.
                if code == EACCES || code == EPERM { builder.markPartiallyUnreadable(); stats.unreadable += 1 }
                else { stats.errors += 1 }
                break
            }
            var entry = UnsafeRawPointer(buffer)
            for _ in 0..<count {
                let length = Int(entry.loadUnaligned(as: UInt32.self))
                if length <= 0 { break }
                if let parsed = Self.parse(entry) {
                    handle(parsed, into: &subdirectories)
                } else {
                    stats.errors += 1
                }
                entry += length
            }
            tick()
        }

        for subdirectory in subdirectories {
            if isCancelled() { throw DiskWalkError.cancelled }
            try enter(subdirectory, from: fd)
        }
    }

    private func handle(_ entry: Entry, into subdirectories: inout [Subdirectory]) {
        if entry.error != 0 {
            stats.errors += 1
            return
        }
        if entry.type == UInt32(VDIR.rawValue) {
            if entry.isMountPoint || (entry.hasDevice && entry.device != rootDevice) {
                stats.otherDevices += 1
                return
            }
            if entry.flags & UInt32(SF_DATALESS) != 0 {
                // A File Provider placeholder: listing it would ask the provider to fetch it.
                stats.dataless += 1
                builder.addFile(name: entry.name, allocated: entry.allocated, device: 0, inode: 0, links: 1)
                return
            }
            subdirectories.append(Subdirectory(name: entry.name, allocated: entry.allocated))
            return
        }
        // Anything else is a leaf counted for its own blocks: a regular file, a symlink (never
        // followed), a socket. An evicted cloud file has few or no local blocks, and that is what
        // it counts.
        stats.files += 1
        stats.bytes &+= entry.allocated
        builder.addFile(name: entry.name, allocated: entry.allocated, device: UInt64(UInt32(bitPattern: entry.device)),
                        inode: entry.inode, links: entry.links)
    }

    private func enter(_ subdirectory: Subdirectory, from parent: Int32) throws {
        if builder.depth >= maxDepth {
            builder.addUnreadable(name: subdirectory.name)
            stats.unreadable += 1
            return
        }
        let fd: Int32
        let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        let opened = rootComponents + builder.depth + 1 <= guardedDepth
            ? guardedOpen(parent, subdirectory.name, flags: flags, path: builder.path + [subdirectory.name])
            : DirectoryOpener.outcome(DirectoryOpener.system(parent, subdirectory.name, flags))
        switch opened {
        case .opened(let opened):
            fd = opened
        case .cancelled:
            throw DiskWalkError.cancelled
        case .timedOut:
            // Nobody answered the privacy prompt in time: unreadable, exactly like a refusal.
            builder.addUnreadable(name: subdirectory.name)
            stats.unreadable += 1
            return
        case .failed(let code):
            switch code {
            case EACCES, EPERM:
                builder.addUnreadable(name: subdirectory.name)
                stats.unreadable += 1
            default:
                // Gone since it was listed, or replaced by a symlink (ELOOP): not ours to count.
                stats.errors += 1
            }
            return
        }
        defer { close(fd) }
        // The definitive check, in case the listing could not say: never cross onto another device.
        var info = stat()
        if fstat(fd, &info) == 0 && info.st_dev != rootDevice {
            stats.otherDevices += 1
            return
        }
        builder.begin(name: subdirectory.name, ownSize: subdirectory.allocated)
        stats.directories += 1
        let path = builder.path
        try walkDirectory(fd)
        if let node = builder.end(), path.count <= builder.policy.progressDepth {
            onDirectory(path, node)
        }
    }

    private func tick() {
        let now = Date()
        guard now.timeIntervalSince(lastTick) >= tickEvery else { return }
        lastTick = now
        onTick(stats, builder.path)
    }

    // MARK: - Parsing one getattrlistbulk entry

    struct Entry {
        var name = ""
        var error: UInt32 = 0
        var device: dev_t = 0
        var hasDevice = false
        var type: UInt32 = 0
        var flags: UInt32 = 0
        var inode: UInt64 = 0
        var isMountPoint = false
        var allocated: UInt64 = 0
        var links: UInt32 = 1
    }

    /// Reads one entry. The attributes are packed in a fixed order, each only when the
    /// `returned` set says so, aligned on 4 bytes: 8-byte values are read unaligned.
    static func parse(_ start: UnsafeRawPointer) -> Entry? {
        let length = Int(start.loadUnaligned(as: UInt32.self))
        let end = start + length
        var field = start + 4
        let returned = field.loadUnaligned(as: attribute_set_t.self)
        field += MemoryLayout<attribute_set_t>.size
        var entry = Entry()
        func has<T: BinaryInteger>(_ group: attrgroup_t, _ bit: T) -> Bool { group & attrgroup_t(bit) != 0 }

        if returned.commonattr & attrgroup_t(ATTR_CMN_ERROR) != 0 {
            entry.error = field.loadUnaligned(as: UInt32.self)
            field += 4
        }
        if has(returned.commonattr, ATTR_CMN_NAME) {
            let reference = field
            let offset = Int(reference.loadUnaligned(as: Int32.self))
            let nameLength = Int(reference.loadUnaligned(fromByteOffset: 4, as: UInt32.self))
            let name = reference + offset
            guard nameLength > 0, name >= start, name + nameLength <= end else { return nil }
            // The length counts the terminating NUL. APFS and HFS+ only store valid UTF-8 names;
            // a name from elsewhere that is not decodes with U+FFFD, and the server then cannot
            // find it again on disk: reveal and rescan answer "gone" for that one entry.
            entry.name = String(decoding: UnsafeRawBufferPointer(start: name, count: nameLength - 1), as: UTF8.self)
            field += 8
        }
        if has(returned.commonattr, ATTR_CMN_DEVID) {
            entry.device = field.loadUnaligned(as: dev_t.self)
            entry.hasDevice = true
            field += 4
        }
        if has(returned.commonattr, ATTR_CMN_OBJTYPE) {
            entry.type = field.loadUnaligned(as: UInt32.self)
            field += 4
        }
        if has(returned.commonattr, ATTR_CMN_FLAGS) {
            entry.flags = field.loadUnaligned(as: UInt32.self)
            field += 4
        }
        if has(returned.commonattr, ATTR_CMN_FILEID) {
            entry.inode = field.loadUnaligned(as: UInt64.self)
            field += 8
        }
        if has(returned.dirattr, ATTR_DIR_MOUNTSTATUS) {
            entry.isMountPoint = field.loadUnaligned(as: UInt32.self) & UInt32(DIR_MNTSTATUS_MNTPOINT) != 0
            field += 4
        }
        if has(returned.dirattr, ATTR_DIR_ALLOCSIZE) {
            entry.allocated = UInt64(max(0, field.loadUnaligned(as: off_t.self)))
            field += 8
        }
        if has(returned.fileattr, ATTR_FILE_LINKCOUNT) {
            entry.links = field.loadUnaligned(as: UInt32.self)
            field += 4
        }
        if has(returned.fileattr, ATTR_FILE_ALLOCSIZE) {
            entry.allocated = UInt64(max(0, field.loadUnaligned(as: off_t.self)))
            field += 8
        }
        guard field <= end else { return nil }
        return entry
    }
}
