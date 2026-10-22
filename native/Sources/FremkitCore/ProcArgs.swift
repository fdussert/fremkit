// A process's exact command line and environment, read the way `ps -E` does: from the kernel's
// KERN_PROCARGS2 record. `fremkit-scan procargs <pid>` prints it so the server can restart a dev
// server with the argv and environment it was started with.
//
// The environment may hold secrets. It is returned to the caller and printed on stdout only; nothing
// here logs it or writes it to stderr.

import Darwin
import Foundation

public enum ProcArgsError: Error, Equatable {
    case noSuchProcess
    case denied
    case failed

    public var code: String {
        switch self {
        case .noSuchProcess: return "no-such-process"
        case .denied: return "denied"
        case .failed: return "failed"
        }
    }

    /// The line `fremkit-scan procargs` prints for this error.
    public var jsonLine: String { "{\"type\":\"error\",\"code\":\(DiskScanJSON.string(code))}" }
}

/// The command line of `fremkit-scan`: a disk scan, or a read of one process's arguments.
public enum ScanCommand: Equatable {
    case disk(DiskScanArguments)
    case procargs(pid_t)

    public static let procargsUsage = "usage: fremkit-scan procargs <pid>"

    /// `procargs <pid>` first; anything else is the disk scan's own syntax, unchanged. A disk root is
    /// always absolute, so the word "procargs" can never be one.
    public static func parse<S: Sequence>(_ arguments: S) throws -> ScanCommand where S.Element == String {
        let list = Array(arguments)
        guard list.first == "procargs" else { return .disk(try DiskScanArguments.parse(list)) }
        guard list.count == 2 else { throw ProcArgsParseError.usage }
        let raw = list[1]
        guard !raw.isEmpty, raw.count <= 10, raw.allSatisfy({ $0.isASCII && $0.isNumber }),
              let pid = pid_t(raw), pid > 0 else { throw ProcArgsParseError.badPid(raw) }
        return .procargs(pid)
    }
}

public enum ProcArgsParseError: Error, Equatable, CustomStringConvertible {
    case usage
    case badPid(String)

    public var description: String {
        switch self {
        case .usage: return "procargs takes exactly one pid"
        case let .badPid(value): return "procargs: invalid pid \(value)"
        }
    }
}

public struct ProcArgs: Codable, Equatable {
    public let exe: String
    public let argv: [String]
    /// nil when the kernel returned no environment at all, which is how it answers for Apple's platform
    /// binaries: "hidden" is not the same as "empty".
    public let env: [String: String]?

    public init(exe: String, argv: [String], env: [String: String]?) {
        self.exe = exe
        self.argv = argv
        self.env = env
    }

    /// `{"type":"procargs","exe":…,"argv":[…],"env":{…}}`, env keys sorted for a stable line;
    /// `"env":null` when the kernel hid the environment.
    public var jsonLine: String {
        let args = argv.map { DiskScanJSON.string($0) }.joined(separator: ",")
        let vars: String
        if let env {
            vars = "{" + env.keys.sorted().map { "\(DiskScanJSON.string($0)):\(DiskScanJSON.string(env[$0]!))" }.joined(separator: ",") + "}"
        } else {
            vars = "null"
        }
        return "{\"type\":\"procargs\",\"exe\":\(DiskScanJSON.string(exe)),\"argv\":[\(args)],\"env\":\(vars)}"
    }

    public static func read(pid: pid_t) throws -> ProcArgs {
        var maxSize: Int32 = 0
        var size = MemoryLayout<Int32>.size
        var argmax = [CTL_KERN, KERN_ARGMAX]
        guard sysctl(&argmax, 2, &maxSize, &size, nil, 0) == 0, maxSize > 0 else { throw ProcArgsError.failed }

        var buffer = [UInt8](repeating: 0, count: Int(maxSize))
        var length = Int(maxSize)
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        if sysctl(&mib, 3, &buffer, &length, nil, 0) != 0 {
            // The kernel answers EINVAL both for a pid that is gone and for one it will not show a
            // non-root caller, so kill(pid, 0) tells the two apart.
            if kill(pid, 0) != 0 && errno == ESRCH { throw ProcArgsError.noSuchProcess }
            throw ProcArgsError.denied
        }
        return try parse(Array(buffer[0..<length]), pid: pid)
    }

    /// KERN_PROCARGS2: argc (Int32), the exec path, NUL padding up to a multiple of 8 bytes counted
    /// from the path's start, argc NUL-terminated arguments, then NUL-terminated `KEY=VALUE` strings.
    ///
    /// The padding is skipped by its computed length, never "all NULs", so an empty argument (even
    /// argv[0]) is not mistaken for padding. A buffer that does not fit that layout is refused.
    static func parse(_ bytes: [UInt8], pid: pid_t) throws -> ProcArgs {
        guard bytes.count > MemoryLayout<Int32>.size else { throw ProcArgsError.failed }
        let argc = bytes.withUnsafeBytes { Int($0.loadUnaligned(as: Int32.self)) }
        guard argc >= 0 else { throw ProcArgsError.failed }
        var index = MemoryLayout<Int32>.size

        /// The next NUL-terminated string; nil when the buffer ends first. Bytes that are not UTF-8
        /// are refused rather than replaced, so the caller never replays a different byte string.
        func nextString() throws -> String? {
            guard index < bytes.count, let end = bytes[index...].firstIndex(of: 0) else { return nil }
            guard let value = String(bytes: bytes[index..<end], encoding: .utf8) else { throw ProcArgsError.failed }
            index = end + 1
            return value
        }

        let pathStart = index
        guard let path = try nextString() else { throw ProcArgsError.failed }
        let padding = (8 - (index - pathStart) % 8) % 8
        guard index + padding <= bytes.count, bytes[index..<index + padding].allSatisfy({ $0 == 0 }) else {
            throw ProcArgsError.failed
        }
        index += padding

        var argv: [String] = []
        for _ in 0..<argc {
            guard let argument = try nextString() else { throw ProcArgsError.failed }
            argv.append(argument)
        }
        var env: [String: String] = [:]
        // The first empty string ends the environment: what follows is the buffer's trailing padding.
        while let entry = try nextString(), !entry.isEmpty {
            guard let equals = entry.firstIndex(of: "=") else { continue }
            env[String(entry[..<equals])] = String(entry[entry.index(after: equals)...])
        }
        return ProcArgs(exe: try executablePath(pid: pid) ?? path, argv: argv, env: env.isEmpty ? nil : env)
    }

    private static func executablePath(pid: pid_t) throws -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard count > 0 else { return nil }
        return try decodePath(buffer[0..<Int(count)].map { UInt8(bitPattern: $0) })
    }

    /// Strict like the strings of the record: a path that is not UTF-8 is refused, not rewritten.
    static func decodePath(_ bytes: [UInt8]) throws -> String {
        guard let value = String(bytes: bytes, encoding: .utf8) else { throw ProcArgsError.failed }
        return value
    }
}
