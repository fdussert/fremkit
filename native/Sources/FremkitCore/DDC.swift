import Foundation

/// The bytes of DDC/CI, the monitor control protocol spoken over the display cable's I²C lines.
///
/// Pure: building a request and reading a reply. The I/O itself (`IOAVService` on Apple silicon)
/// lives in the helper. The wire format is VESA's MCCS over DDC/CI, as m1ddc and MonitorControl
/// speak it, and was checked against the Xeneon Edge: a "get luminance" answered
/// `6E 88 02 00 10 00 00 64 00 5F 9F` (95 of 100).
public enum DDC {
    /// The display's DDC/CI I²C address (0x6E on the wire, shifted).
    public static let chipAddress: UInt32 = 0x37
    /// The "data address" the host writes to, which is also the host's source address.
    public static let dataAddress: UInt32 = 0x51
    /// VCP code 0x10: luminance, i.e. brightness.
    public static let luminance: UInt8 = 0x10
    /// Bytes of a "get VCP feature" reply, header to checksum.
    public static let replyLength = 11

    /// "Get VCP feature": length 0x82 (2 bytes follow), opcode 0x01, the code, checksum.
    public static func getRequest(_ code: UInt8) -> [UInt8] {
        withChecksum([0x82, 0x01, code])
    }

    /// "Set VCP feature": length 0x84 (4 bytes follow), opcode 0x03, the code, value big-endian, checksum.
    public static func setRequest(_ code: UInt8, value: UInt16) -> [UInt8] {
        withChecksum([0x84, 0x03, code, UInt8(value >> 8), UInt8(value & 0xFF)])
    }

    /// The host's checksum: the destination (0x6E) and source (0x51) addresses XORed with every byte.
    static func withChecksum(_ body: [UInt8]) -> [UInt8] {
        body + [body.reduce(0x6E ^ 0x51, ^)]
    }

    /// A VCP value as the monitor reports it: where it is and how far it goes.
    public struct Value: Equatable {
        public let current: Int
        public let maximum: Int
        public init(current: Int, maximum: Int) {
            self.current = current
            self.maximum = maximum
        }
    }

    /// Why a reply was not taken.
    public enum ReplyError: Error, Equatable {
        /// Too short, or a "null message" (length byte 0x80): the monitor was not ready. Retry.
        case notReady
        /// A reply to something else: another opcode or another VCP code.
        case mismatched
        /// The checksum does not add up: a garbled transfer. Retry.
        case checksum
        /// The monitor says it does not support this code.
        case unsupported
    }

    /// Reads a "get VCP feature" reply for `code`.
    ///
    /// Layout: source 0x6E, length 0x88, opcode 0x02, result, code, type, max hi/lo, current
    /// hi/lo, checksum (0x50 XOR every byte before it). A monitor that is busy answers a null
    /// message (`6E 80 BE …`, the rest stale), which the Dell S3221QS does on a first try.
    public static func parseReply(_ bytes: [UInt8], code: UInt8) -> Result<Value, ReplyError> {
        guard bytes.count >= replyLength, bytes[1] != 0x80 else { return .failure(.notReady) }
        guard bytes[1] == 0x88, bytes[2] == 0x02, bytes[4] == code else { return .failure(.mismatched) }
        let sum = bytes[0..<(replyLength - 1)].reduce(UInt8(0x50), ^)
        guard sum == bytes[replyLength - 1] else { return .failure(.checksum) }
        guard bytes[3] == 0x00 else { return .failure(.unsupported) }
        let maximum = Int(bytes[6]) << 8 | Int(bytes[7])
        let current = Int(bytes[8]) << 8 | Int(bytes[9])
        guard maximum > 0 else { return .failure(.unsupported) }
        return .success(Value(current: current, maximum: maximum))
    }

    /// A raw level as a percentage of the display's maximum, rounded.
    public static func percent(_ value: Value) -> Int {
        let p = (Double(min(value.current, value.maximum)) * 100 / Double(value.maximum)).rounded()
        return Int(max(0, min(100, p)))
    }

    /// A percentage as a raw level for a display whose maximum is `maximum`.
    public static func raw(percent: Int, maximum: Int) -> UInt16 {
        let p = Double(max(0, min(100, percent)))
        return UInt16(max(0, min(Double(UInt16.max), (p * Double(maximum) / 100).rounded())))
    }
}
