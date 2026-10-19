// fremkit-scan: walks one directory and prints what takes the space, as JSON lines.
//
// Run by the dashboard server (execFile-style: absolute path, argument list, no shell) for the
// disk map widget. It is its own process rather than part of the helper so that the server can
// start and cancel it exactly as it would `du`, and so that a scan can never hold up the helper.
//
// Output, one JSON object per line on stdout:
//   {"type":"start","root":"/abs/path"}
//   {"type":"dir","path":["Library"],"size":…,"files":…,"unreadable":…}   a finished directory
//   {"type":"progress","directories":…,"files":…,"bytes":…,"path":[…]}    at most every 250 ms
//   {"type":"waiting","path":["Documents"]}   a directory's open has been held for 2 s, which is
//                                               macOS asking the user for access (a TCC prompt)
//   {"type":"waiting","path":null}            that open is over: answered, refused, or given up
//   {"type":"done","tree":{…},"stats":{…}}                                 the last line
//   {"type":"cancelled"} after SIGTERM/SIGINT, {"type":"error","code":"…"} when the root fails.
// The tree's nodes are documented in FremkitCore/DiskTree.swift.
//
// A "waiting" path is relative to the root like the others, [] for the root itself. An open nobody
// answers within 30 s is given up: that directory counts as unreadable and the walk goes on (see
// FremkitCore/DirectoryOpener.swift). A waiting line is always followed by its `null` before any
// other waiting line.

import Darwin
import Foundation
import FremkitCore

/// Set from the signal handler, read by the walk between two batches of entries.
var cancelRequested: sig_atomic_t = 0

func emit(_ line: String) {
    // A server that went away closes the pipe: SIGPIPE is ignored below, so the write fails and
    // the scan stops rather than walking on for nobody.
    if fputs(line + "\n", stdout) < 0 || fflush(stdout) != 0 { exit(0) }
}

func fail(_ code: String, _ status: Int32) -> Never {
    emit("{\"type\":\"error\",\"code\":\(DiskScanJSON.string(code))}")
    exit(status)
}

let arguments: DiskScanArguments
do {
    arguments = try DiskScanArguments.parse(CommandLine.arguments.dropFirst())
} catch {
    FileHandle.standardError.write(Data("fremkit-scan: \(error)\n\(DiskScanArguments.usage)\n".utf8))
    exit(64)
}

// Low priority: the scan must not make the Mac stutter. Disk I/O is throttled behind everyone
// else's, and the thread runs at utility QoS.
_ = setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_THROTTLE)
_ = pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0)
// Never materialise a dataless file or directory (iCloud Drive, File Provider placeholders):
// counting them must not download them.
_ = setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS, IOPOL_MATERIALIZE_DATALESS_FILES_OFF)

// One descriptor per level of the tree is open during the walk; the default soft limit (256)
// would end a walk down a deep tree with EMFILE.
var limit = rlimit()
if getrlimit(RLIMIT_NOFILE, &limit) == 0 {
    let wanted = min(limit.rlim_max, rlim_t(OPEN_MAX))
    if limit.rlim_cur < wanted {
        limit.rlim_cur = wanted
        _ = setrlimit(RLIMIT_NOFILE, &limit)
    }
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM) { _ in cancelRequested = 1 }
signal(SIGINT) { _ in cancelRequested = 1 }

let policy = arguments.policy
let builder = DiskTreeBuilder(policy: policy)
let started = Date()
let walker = DiskWalker(
    builder: builder,
    isCancelled: { cancelRequested != 0 },
    onDirectory: { path, node in
        var line = "{\"type\":\"dir\",\"path\":\(DiskScanJSON.path(path)),\"size\":\(node.size),\"files\":\(node.files)"
        if node.unreadable > 0 { line += ",\"unreadable\":\(node.unreadable)" }
        emit(line + "}")
    },
    onTick: { stats, path in
        emit("{\"type\":\"progress\",\"directories\":\(stats.directories),\"files\":\(stats.files),\"unreadable\":\(stats.unreadable),\"path\":\(DiskScanJSON.path(Array(path.prefix(2))))}")
    },
    onWaiting: { path in
        emit("{\"type\":\"waiting\",\"path\":\(path.map { DiskScanJSON.path($0) } ?? "null")}")
    }
)

emit("{\"type\":\"start\",\"root\":\(DiskScanJSON.string(arguments.root))}")
let tree: DiskNode
do {
    tree = try walker.walk(root: arguments.root)
} catch DiskWalkError.cancelled {
    emit("{\"type\":\"cancelled\"}")
    exit(0)
} catch DiskWalkError.rootMissing {
    fail("missing", 1)
} catch DiskWalkError.rootNotADirectory {
    fail("not-a-directory", 1)
} catch DiskWalkError.rootUnreadable {
    fail("unreadable", 1)
} catch {
    fail("failed", 1)
}

DiskTreePruner.applyBudget(tree, budget: policy.budget)
let stats = walker.stats
let elapsed = Int(Date().timeIntervalSince(started) * 1000)
emit("{\"type\":\"done\",\"tree\":\(DiskScanJSON.node(tree)),\"stats\":{\"directories\":\(stats.directories),\"files\":\(stats.files),\"bytes\":\(stats.bytes),\"unreadable\":\(stats.unreadable),\"errors\":\(stats.errors),\"otherDevices\":\(stats.otherDevices),\"dataless\":\(stats.dataless),\"nodes\":\(tree.nodeCount),\"ms\":\(elapsed)}}")
exit(0)
