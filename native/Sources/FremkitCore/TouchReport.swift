import Foundation

/// A single-touch HID report from the Corsair Xeneon Edge touch strip.
///
/// The panel emits 7-byte reports with id 7, laid out as
/// `07 btn Xlo Xhi Ylo Yhi 00`, with 14-bit little-endian coordinates.
public struct TouchReport: Equatable {
    /// True while the finger is on the panel.
    public let down: Bool
    /// Horizontal position, `0...xMax`.
    public let x: Int
    /// Vertical position, `0...yMax`.
    public let y: Int

    /// HID report id used by the touch interface.
    public static let reportID: UInt8 = 7
    /// Minimum number of bytes a usable report carries.
    public static let length = 7
    /// Maximum value the panel reports on the X axis.
    public static let xMax = 16383
    /// Maximum value the panel reports on the Y axis.
    public static let yMax = 9599

    public init(down: Bool, x: Int, y: Int) {
        self.down = down
        self.x = x
        self.y = y
    }

    /// Decodes a raw HID report, or returns nil when it is not a touch report.
    public static func parse(_ bytes: [UInt8]) -> TouchReport? {
        guard bytes.count >= length, bytes[0] == reportID else { return nil }
        let x = Int(bytes[2]) | Int(bytes[3]) << 8
        let y = Int(bytes[4]) | Int(bytes[5]) << 8
        return TouchReport(down: bytes[1] != 0, x: x, y: y)
    }
}
