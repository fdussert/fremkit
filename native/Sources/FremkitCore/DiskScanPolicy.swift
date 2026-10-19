import Foundation

/// How much of a scanned tree `fremkit-scan` keeps, and what it reports while it walks.
///
/// The walk itself always visits everything below the root; the policy only decides what is held
/// in memory and printed. Every bound is validated, because the numbers arrive on a command line.
public struct DiskScanPolicy: Equatable {
    /// Levels below the root whose entries are held as nodes. Anything deeper only adds its size.
    public var depth: Int
    /// An entry smaller than this is never held on its own: it goes into its parent's "others".
    public var minBytes: UInt64
    /// At most this many entries are held per directory, the largest first.
    public var maxChildren: Int
    /// At most this many nodes in the final tree, the largest first (see `DiskTreePruner`).
    public var budget: Int
    /// Finished directories down to this depth are reported as they finish: that is the progress.
    public var progressDepth: Int

    public static let depthRange = 1...16
    public static let minBytesRange: ClosedRange<UInt64> = 0...(UInt64(1) << 50)
    public static let maxChildrenRange = 1...1000
    public static let budgetRange = 10...200_000
    public static let progressDepthRange = 0...3

    public static let `default` = DiskScanPolicy(depth: 6, minBytes: 1 << 20, maxChildren: 128, budget: 20_000, progressDepth: 1)

    public init(depth: Int, minBytes: UInt64, maxChildren: Int, budget: Int, progressDepth: Int) {
        self.depth = depth
        self.minBytes = minBytes
        self.maxChildren = maxChildren
        self.budget = budget
        self.progressDepth = progressDepth
    }
}

/// The command line of `fremkit-scan`, parsed and checked.
public struct DiskScanArguments: Equatable {
    public var root: String
    public var policy: DiskScanPolicy

    public enum ParseError: Error, Equatable, CustomStringConvertible {
        case unknownOption(String)
        case missingValue(String)
        case badValue(String, String)
        case missingRoot
        case extraArgument(String)
        case badRoot(String)

        public var description: String {
            switch self {
            case let .unknownOption(name): return "unknown option \(name)"
            case let .missingValue(name): return "\(name) needs a value"
            case let .badValue(name, value): return "\(name): invalid value \(value)"
            case .missingRoot: return "missing root path"
            case let .extraArgument(value): return "unexpected argument \(value)"
            case let .badRoot(reason): return "root: \(reason)"
            }
        }
    }

    public static let usage = "usage: fremkit-scan [--depth N] [--min-bytes N] [--max-children N] [--budget N] [--progress-depth N] [--] <absolute root>"

    public init(root: String, policy: DiskScanPolicy) {
        self.root = root
        self.policy = policy
    }

    /// Parses the arguments after the program name.
    public static func parse<S: Sequence>(_ arguments: S) throws -> DiskScanArguments where S.Element == String {
        var policy = DiskScanPolicy.default
        var root: String?
        var iterator = arguments.makeIterator()
        var optionsDone = false

        func integer<T: FixedWidthInteger>(_ name: String, _ range: ClosedRange<T>) throws -> T {
            guard let raw = iterator.next() else { throw ParseError.missingValue(name) }
            // Digits only: no sign, no spaces, no hexadecimal, so "1e9" or "-1" are refused rather
            // than read as something nobody typed.
            guard !raw.isEmpty, raw.count <= 20, raw.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let value = T(raw), range.contains(value) else {
                throw ParseError.badValue(name, raw)
            }
            return value
        }

        while let argument = iterator.next() {
            if !optionsDone && argument.hasPrefix("-") {
                switch argument {
                case "--": optionsDone = true
                case "--depth": policy.depth = try integer(argument, DiskScanPolicy.depthRange)
                case "--min-bytes": policy.minBytes = try integer(argument, DiskScanPolicy.minBytesRange)
                case "--max-children": policy.maxChildren = try integer(argument, DiskScanPolicy.maxChildrenRange)
                case "--budget": policy.budget = try integer(argument, DiskScanPolicy.budgetRange)
                case "--progress-depth": policy.progressDepth = try integer(argument, DiskScanPolicy.progressDepthRange)
                default: throw ParseError.unknownOption(argument)
                }
                continue
            }
            if root != nil { throw ParseError.extraArgument(argument) }
            root = argument
        }
        guard let root else { throw ParseError.missingRoot }
        guard root.hasPrefix("/") else { throw ParseError.badRoot("must be absolute") }
        guard !root.utf8.contains(0) else { throw ParseError.badRoot("contains a NUL byte") }
        guard root.utf8.count < Int(PATH_MAX) else { throw ParseError.badRoot("too long") }
        return DiskScanArguments(root: root, policy: policy)
    }
}
