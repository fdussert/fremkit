import Foundation

/// Supported hardware profiles. The top-level usage distinguishes ILITEK's touch collection
/// from its sibling emulated mouse collection, which must never be decoded as finger input.
public enum TouchHardwareProfile: Equatable {
    case edge
    case ilitek

    public static func match(vendorID: Int, productID: Int, usagePage: Int, usage: Int) -> Self? {
        if vendorID == 0x27C0, productID == 0x0859, usagePage == 0x01, usage == 0x02 {
            return .edge
        }
        if vendorID == 0x222A, productID == 0x0001, usagePage == 0x0D, usage == 0x04 {
            return .ilitek
        }
        return nil
    }

    /// Uses Edge when its display and HID device are present; otherwise falls back to ILITEK.
    public static func preferred(edgeDevice: Bool,
                                 edgeTarget: Bool,
                                 ilitekDevice: Bool,
                                 ilitekTarget: Bool) -> Self? {
        if edgeDevice && edgeTarget { return .edge }
        if ilitekDevice && ilitekTarget { return .ilitek }
        if edgeDevice { return .edge }
        if ilitekDevice { return .ilitek }
        return nil
    }

    /// Returns only the target belonging to the chosen hardware profile. In particular, an
    /// ILITEK device without its selected active display must not fall through to Edge bounds.
    public static func target<Bounds>(for profile: Self, edge: Bounds?, ilitek: Bounds?) -> Bounds? {
        switch profile {
        case .edge: return edge
        case .ilitek: return ilitek
        }
    }
}

/// The physical USB grouping used to keep a touchscreen's emulated-mouse interface with it.
public struct HIDPhysicalDeviceKey: Equatable {
    public let vendorID: Int
    public let productID: Int
    public let locationID: Int

    public init(vendorID: Int, productID: Int, locationID: Int) {
        self.vendorID = vendorID
        self.productID = productID
        self.locationID = locationID
    }

    public func isSibling(vendorID: Int, productID: Int, locationID: Int) -> Bool {
        self.vendorID == vendorID && self.productID == productID && self.locationID == locationID
    }
}

/// One value emitted by IOHID for a digitizer element, converted to plain data for testing.
public struct HIDTouchElementValue {
    public let usagePage: Int
    public let usage: Int
    public let value: Int
    public let logicalMinimum: Int
    public let logicalMaximum: Int
    public let isRelative: Bool
    /// Cookie of the containing Finger collection, when the element belongs to one.
    public let fingerCookie: UInt64?

    public init(usagePage: Int,
                usage: Int,
                value: Int,
                logicalMinimum: Int,
                logicalMaximum: Int,
                isRelative: Bool = false,
                fingerCookie: UInt64? = nil) {
        self.usagePage = usagePage
        self.usage = usage
        self.value = value
        self.logicalMinimum = logicalMinimum
        self.logicalMaximum = logicalMaximum
        self.isRelative = isRelative
        self.fingerCookie = fingerCookie
    }
}

public struct HIDTouchSample: Equatable {
    public let x: Double
    public let y: Double
    public let isDown: Bool
    public let hasValidPosition: Bool
    public let hasContactElement: Bool

    public init(x: Double, y: Double, isDown: Bool, hasValidPosition: Bool, hasContactElement: Bool) {
        self.x = x
        self.y = y
        self.isDown = isDown
        self.hasValidPosition = hasValidPosition
        self.hasContactElement = hasContactElement
    }
}

/// Decodes the confirmed ILITEK Digitizer-page X/Y and tip-switch values.
public struct ILITEKTouchDecoder {
    private let primaryFingerCookie: UInt64?
    private var x = 0.5
    private var y = 0.5
    private var hasX = false
    private var hasY = false
    private var isDown = false
    private var hasContactElement = false

    public init(primaryFingerCookie: UInt64? = nil) {
        self.primaryFingerCookie = primaryFingerCookie
    }

    public var sample: HIDTouchSample {
        HIDTouchSample(x: x, y: y, isDown: isDown, hasValidPosition: hasX && hasY,
                       hasContactElement: hasContactElement)
    }

    public mutating func consume(_ element: HIDTouchElementValue) {
        guard !element.isRelative else { return }
        if let primaryFingerCookie,
           let fingerCookie = element.fingerCookie,
           fingerCookie != primaryFingerCookie {
            return
        }

        guard element.usagePage == 0x0D else { return }
        switch element.usage {
        case 0x30:
            guard element.logicalMaximum > element.logicalMinimum else { return }
            x = Self.normalize(element)
            hasX = true
        case 0x31:
            guard element.logicalMaximum > element.logicalMinimum else { return }
            y = Self.normalize(element)
            hasY = true
        case 0x42, 0x32, 0x33:
            hasContactElement = true
            isDown = element.value > 0
        default:
            break
        }
    }

    private static func normalize(_ element: HIDTouchElementValue) -> Double {
        let span = Double(element.logicalMaximum - element.logicalMinimum)
        let ratio = (Double(element.value) - Double(element.logicalMinimum)) / span
        return min(1, max(0, ratio))
    }
}

/// Decodes the ILITEK sibling mouse collection. This device reports its usable absolute X/Y and
/// primary contact edge on this interface on the connected panel; relative pointer reports are
/// deliberately ignored so trackpad-like deltas cannot corrupt absolute mapping.
public struct ILITEKMouseDecoder {
    private var x = 0.5
    private var y = 0.5
    private var hasX = false
    private var hasY = false
    private var isDown = false
    private var hasContactElement = false

    public init() {}

    public var sample: HIDTouchSample {
        HIDTouchSample(x: x, y: y, isDown: isDown, hasValidPosition: hasX && hasY,
                       hasContactElement: hasContactElement)
    }

    public mutating func consume(_ element: HIDTouchElementValue) {
        guard !element.isRelative else { return }
        switch (element.usagePage, element.usage) {
        case (0x01, 0x30):
            guard element.logicalMaximum > element.logicalMinimum else { return }
            x = Self.normalize(element)
            hasX = true
        case (0x01, 0x31):
            guard element.logicalMaximum > element.logicalMinimum else { return }
            y = Self.normalize(element)
            hasY = true
        case (0x09, 0x01):
            hasContactElement = true
            isDown = element.value > 0
        default:
            break
        }
    }

    private static func normalize(_ element: HIDTouchElementValue) -> Double {
        let span = Double(element.logicalMaximum - element.logicalMinimum)
        return min(1, max(0, (Double(element.value) - Double(element.logicalMinimum)) / span))
    }
}

public enum ILITEKTouchSource: Hashable {
    case digitizer
    case mouse
}

/// Chooses one interface for each physical contact and suppresses its sibling until that
/// sibling reports release. This prevents duplicate gestures if a device emits both paths.
public struct ILITEKContactSourceSelector {
    private var activeSource: ILITEKTouchSource?
    private var suppressedUntilRelease: Set<ILITEKTouchSource> = []

    public init() {}

    public mutating func select(_ sample: HIDTouchSample, from source: ILITEKTouchSource) -> HIDTouchSample? {
        guard sample.hasValidPosition, sample.hasContactElement else { return nil }
        if suppressedUntilRelease.contains(source) {
            if !sample.isDown { suppressedUntilRelease.remove(source) }
            return nil
        }
        if let activeSource {
            guard activeSource == source else {
                if sample.isDown { suppressedUntilRelease.insert(source) }
                return nil
            }
            if !sample.isDown { self.activeSource = nil }
            return sample
        }
        guard sample.isDown else { return nil }
        activeSource = source
        return sample
    }
}

public extension DisplayMapper {
    /// Converts normalized HID axes (X→right, Y→down) into Quartz global display coordinates.
    func point(normalizedX: Double, normalizedY: Double) -> CGPoint {
        let x = min(1, max(0, normalizedX))
        let y = min(1, max(0, normalizedY))
        return CGPoint(x: bounds.minX + x * bounds.width,
                       y: bounds.minY + y * bounds.height)
    }
}
