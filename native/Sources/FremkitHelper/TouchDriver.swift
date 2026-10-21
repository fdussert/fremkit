import AppKit
import CoreGraphics
import Foundation
import FremkitCore
import IOKit
import IOKit.hid

/// Why the touch panel could not be opened. Structured rather than a free-form string, so the
/// status menu can phrase it in French without matching on English text.
enum TouchBusyReason: Equatable, CustomStringConvertible {
    /// Another process holds the interface exclusively (e.g. Touchscreen Gestures).
    case exclusiveAccess
    /// The ILITEK touchscreen opened, but its paired mouse interface could not be seized.
    case siblingSeizeFailed
    /// `IOHIDManagerOpen` failed for some other reason; carries the raw IOReturn code.
    case openFailed(UInt32)

    var description: String {
        switch self {
        case .exclusiveAccess: return "another driver holds the panel"
        case .siblingSeizeFailed: return "could not seize the panel's paired mouse interface"
        case let .openFailed(code): return String(format: "IOHIDManagerOpen failed (0x%08X)", code)
        }
    }
}

/// What the touch panel is currently doing, as shown in the status menu.
enum TouchState: Equatable, CustomStringConvertible {
    /// The HID interface is open and reports are flowing.
    case active
    /// Input Monitoring has not been granted.
    case notPermitted
    /// Input Monitoring is granted, but the panel still refuses this process: macOS wants it
    /// relaunched before the grant applies.
    case needsRelaunch
    /// The HID interface could not be opened.
    case busy(TouchBusyReason)
    /// The Edge display is not connected, so touches cannot be mapped.
    case noDisplay
    /// The driver is stopped, either by the config or by the menu.
    case disabled

    var description: String {
        switch self {
        case .active: return "active"
        case .notPermitted: return "notPermitted"
        case .needsRelaunch: return "needsRelaunch"
        case let .busy(reason): return "busy(\(reason))"
        case .noDisplay: return "noDisplay"
        case .disabled: return "disabled"
        }
    }
}

/// Reads the Edge touch strip in HID, recognises gestures and posts the resulting pointer actions.
///
/// The HID interface is opened in *seize* mode, which takes it away from macOS (and from any
/// third-party driver): nothing else sees the touches while the helper runs.
final class TouchDriver {
    /// IOReturn codes we need, spelled out because the IOKit macros do not import into Swift.
    private enum IOResult {
        static let success: IOReturn = 0
        // From IOKit's IOReturn.h: iokit_common_err(0x2e2) and iokit_common_err(0x2c5).
        static let notPermitted = IOReturn(bitPattern: 0xE000_02E2)
        static let exclusiveAccess = IOReturn(bitPattern: 0xE000_02C5)
    }

    private enum Hardware {
        static let vendorID = 0x27C0
        static let productID = 0x859
        /// Generic Desktop page, Mouse usage: the interface that carries the touch reports.
        static let usagePage = 1
        static let usage = 2
    }

    /// Period of the clock tick that lets a motionless press become a hold.
    private static let tickInterval: TimeInterval = 0.05
    /// Settling delay before the first re-open attempt after a device (re)appears or the Mac wakes.
    private static let reopenDelay: TimeInterval = 0.5
    /// Upper bound of the re-open backoff while the panel stays unavailable.
    private static let reopenDelayCap: TimeInterval = 5

    private let poster: PointerPoster
    /// `GestureEngine` is not thread-safe; this queue is its only owner.
    private let queue = DispatchQueue(label: "dev.fremkit.helper.touch")
    private let engine: GestureEngine

    private var manager: IOHIDManager?
    private var timer: Timer?
    private var wakeObserver: NSObjectProtocol?
    private var running = false
    /// True while the HID manager is really open; a display coming back says nothing about that.
    private var opened = false
    private var reopenPending = false
    /// Current re-open delay: doubles on every failed open, back to `reopenDelay` on success.
    private var reopenBackoff = TouchDriver.reopenDelay
    /// Guarded by `queue`.
    private var mapper: DisplayMapper?
    /// Selected by AppDelegate from the configured target display; Edge remains the default.
    var hardwareProfile: TouchHardwareProfile = .edge
    private var ilitekDevice: IOHIDDevice?
    private var ilitekSiblings: [IOHIDDevice] = []
    private var ilitekDecoder = ILITEKTouchDecoder()
    private var ilitekMouseDecoder = ILITEKMouseDecoder()
    private var ilitekSourceSelector = ILITEKContactSourceSelector()
    private var ilitekPendingSample: HIDTouchSample?
    private var ilitekFlushScheduled = false
    private let ilitekTraceEnabled = ProcessInfo.processInfo.environment["FREMKIT_ILITEK_TRACE"] == "1"
    /// Tells a missing grant from one this process cannot see until it is relaunched.
    private var accessGate = TouchAccessGate()

    /// Called on the main thread whenever the state changes.
    var onState: ((TouchState) -> Void)?
    /// Called on the driver queue once per HID report, with the raw wire bytes, the report id
    /// delivered out of band, and the decode result (nil when it is not a touch report).
    /// Used by `--probe`; the driver itself never prints.
    var onRawReport: ((_ reportID: UInt8, _ bytes: [UInt8], _ parsed: TouchReport?) -> Void)?

    private(set) var state: TouchState = .disabled {
        didSet {
            guard state != oldValue else { return }
            let current = state
            DispatchQueue.main.async { [weak self] in self?.onState?(current) }
        }
    }

    init(poster: PointerPoster, thresholds: GestureThresholds = .init()) {
        self.poster = poster
        self.engine = GestureEngine(thresholds: thresholds)
    }

    deinit {
        closeManager()
        timer?.invalidate()
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
    }

    // MARK: - Display

    /// Bounds of the Edge display; touches are dropped while this is nil.
    var displayBounds: CGRect? {
        didSet {
            let bounds = displayBounds
            queue.async { [weak self] in
                self?.mapper = bounds.map { DisplayMapper(bounds: $0) }
            }
            guard running else { return }
            if bounds == nil {
                state = .noDisplay
            } else if state == .noDisplay && opened {
                state = .active
            }
            // Not open: the retry already scheduled by the failed open sets the real state.
        }
    }

    // MARK: - Lifecycle

    func start() {
        guard !running else { return }
        running = true
        reopenBackoff = Self.reopenDelay

        // Input Monitoring is asked by the caller, not here: a request fired at launch alongside
        // the Accessibility prompt was lost (macOS shows one privacy prompt at a time). See
        // `PermissionSequencer`.

        if hardwareProfile == .ilitek { openILITEKDevice() }
        else { openManager() }

        // `.common` so a menu tracking loop cannot stall the gesture clock.
        let timer = Timer(timeInterval: Self.tickInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer

        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // Waking is a fresh situation too, and the user is there to see it recover quickly.
            self?.scheduleReopen(resetBackoff: true)
        }
    }

    func stop() {
        guard running else { return }
        running = false

        timer?.invalidate()
        timer = nil
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
            self.wakeObserver = nil
        }
        closeManager()
        closeILITEKDevice()
        state = .disabled
    }

    /// Switches between the existing Edge report adapter and the optional ILITEK element adapter.
    func use(_ profile: TouchHardwareProfile) {
        guard hardwareProfile != profile else { return }
        let wasRunning = running
        if wasRunning { stop() }
        hardwareProfile = profile
        if wasRunning { start() }
    }

    /// Enumerates HID metadata without opening or seizing any device.
    static func connectedProfiles() -> Set<TouchHardwareProfile> {
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(0))
        IOHIDManagerSetDeviceMatching(manager, nil)
        guard let raw = IOHIDManagerCopyDevices(manager) else { return [] }
        let devices = (raw as NSSet).allObjects as! [IOHIDDevice]
        var profiles = Set<TouchHardwareProfile>()
        if devices.contains(where: isEdgeTouchscreen) { profiles.insert(.edge) }
        if devices.contains(where: isILITEKTouchscreen) { profiles.insert(.ilitek) }
        return profiles
    }

    private func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        queue.async { [weak self] in
            guard let self else { return }
            for action in self.engine.tick(now: now) { self.poster.perform(action) }
        }
    }

    // MARK: - HID

    private func openManager() {
        closeManager()

        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        self.manager = manager

        let matching: [String: Any] = [
            kIOHIDVendorIDKey: Hardware.vendorID,
            kIOHIDProductIDKey: Hardware.productID,
            kIOHIDPrimaryUsagePageKey: Hardware.usagePage,
            kIOHIDPrimaryUsageKey: Hardware.usage,
        ]
        IOHIDManagerSetDeviceMatching(manager, matching as CFDictionary)

        let context = Unmanaged.passUnretained(self).toOpaque()

        IOHIDManagerRegisterDeviceMatchingCallback(manager, { context, _, _, _ in
            guard let context else { return }
            let driver = Unmanaged<TouchDriver>.fromOpaque(context).takeUnretainedValue()
            // Only re-open when we are not already reading: the manager fires this for the
            // devices it enrols during our own open, which would otherwise loop forever.
            if driver.state != .active { driver.scheduleReopen() }
        }, context)

        IOHIDManagerRegisterDeviceRemovalCallback(manager, { context, _, _, _ in
            guard let context else { return }
            // A real unplug: the next open is a fresh situation, so start the backoff over.
            Unmanaged<TouchDriver>.fromOpaque(context).takeUnretainedValue().scheduleReopen(resetBackoff: true)
        }, context)

        IOHIDManagerRegisterInputReportCallback(manager, { context, _, _, _, reportID, report, length in
            guard let context, length > 0 else { return }
            let driver = Unmanaged<TouchDriver>.fromOpaque(context).takeUnretainedValue()
            let bytes = Array(UnsafeBufferPointer(start: report, count: Int(length)))
            driver.handle(bytes, reportID: UInt8(truncatingIfNeeded: reportID))
        }, context)

        // `.commonModes`, like the fence tap: touches keep flowing while a menu is tracking.
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)

        let result = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
        switch result {
        case IOResult.success:
            opened = true
            accessGate.reset()
            state = displayBounds == nil ? .noDisplay : .active
            reopenBackoff = Self.reopenDelay
        case IOResult.notPermitted:
            // The retry below, at most `reopenDelayCap` apart, is also the re-check of the grant:
            // the panel opens on its own once Input Monitoring is given, or the menu learns that
            // the grant needs a relaunch to apply.
            switch accessGate.refused(inputMonitoring: Permissions.inputMonitoring) {
            case .missing: state = .notPermitted
            case .relaunchNeeded: state = .needsRelaunch
            }
            failedToOpen()
        case IOResult.exclusiveAccess:
            accessGate.reset()
            state = .busy(.exclusiveAccess)
            failedToOpen()
        default:
            accessGate.reset()
            state = .busy(.openFailed(UInt32(bitPattern: result)))
            failedToOpen()
        }
    }

    /// Opens only the ILITEK digitizer collection, then seizes its paired mouse collection so one
    /// physical touch cannot generate both a digitizer gesture and a WindowServer mouse click.
    private func openILITEKDevice() {
        closeILITEKDevice()
        traceILITEK("open preflight inputMonitoring=\(Permissions.inputMonitoring) accessibilityTrusted=\(AXIsProcessTrusted())")
        guard displayBounds != nil else {
            state = .noDisplay
            return
        }

        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(0))
        IOHIDManagerSetDeviceMatching(manager, nil)
        guard let raw = IOHIDManagerCopyDevices(manager) else {
            state = .busy(.openFailed(UInt32(bitPattern: kIOReturnNoDevice)))
            failedToOpen()
            return
        }
        let devices = (raw as NSSet).allObjects as! [IOHIDDevice]
        guard let device = devices.first(where: Self.isILITEKTouchscreen) else {
            state = .busy(.openFailed(UInt32(bitPattern: kIOReturnNoDevice)))
            failedToOpen()
            return
        }
        let key = Self.physicalKey(for: device)
        let mouseSiblings = devices.filter {
            !CFEqual($0, device) && Self.physicalKey(for: $0) == key && Self.isMouseCollection($0)
        }
        guard !mouseSiblings.isEmpty || Self.isMouseCollection(device) else {
            state = .busy(.siblingSeizeFailed)
            failedToOpen()
            return
        }

        let result = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
        guard result == kIOReturnSuccess else {
            traceILITEK("primary open failed result=\(String(format: "0x%08X", UInt32(bitPattern: result)))")
            if result == IOResult.notPermitted {
                switch accessGate.refused(inputMonitoring: Permissions.inputMonitoring) {
                case .missing: state = .notPermitted
                case .relaunchNeeded: state = .needsRelaunch
                }
            } else if result == IOResult.exclusiveAccess {
                accessGate.reset()
                state = .busy(.exclusiveAccess)
            } else {
                accessGate.reset()
                state = .busy(.openFailed(UInt32(bitPattern: result)))
            }
            failedToOpen()
            return
        }

        for sibling in mouseSiblings {
            guard IOHIDDeviceOpen(sibling, IOOptionBits(kIOHIDOptionsTypeSeizeDevice)) == kIOReturnSuccess else {
                for opened in ilitekSiblings { IOHIDDeviceClose(opened, IOOptionBits(0)) }
                ilitekSiblings = []
                IOHIDDeviceClose(device, IOOptionBits(0))
                state = .busy(.siblingSeizeFailed)
                traceILITEK("mouse sibling open failed")
                failedToOpen()
                return
            }
            ilitekSiblings.append(sibling)
        }

        ilitekDecoder = ILITEKTouchDecoder(primaryFingerCookie: Self.primaryFingerCookie(device))
        ilitekMouseDecoder = ILITEKMouseDecoder()
        ilitekSourceSelector = ILITEKContactSourceSelector()
        ilitekPendingSample = nil
        IOHIDDeviceScheduleWithRunLoop(device, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
        IOHIDDeviceRegisterRemovalCallback(device, Self.ilitekRemovalCallback, Unmanaged.passUnretained(self).toOpaque())
        IOHIDDeviceRegisterInputValueCallback(device, Self.ilitekValueCallback, Unmanaged.passUnretained(self).toOpaque())
        for sibling in ilitekSiblings {
            IOHIDDeviceScheduleWithRunLoop(sibling, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
            IOHIDDeviceRegisterRemovalCallback(sibling, Self.ilitekRemovalCallback, Unmanaged.passUnretained(self).toOpaque())
            IOHIDDeviceRegisterInputValueCallback(sibling, Self.ilitekValueCallback, Unmanaged.passUnretained(self).toOpaque())
        }
        ilitekDevice = device
        opened = true
        accessGate.reset()
        state = .active
        reopenBackoff = Self.reopenDelay
        traceILITEK("open active interfaces=digitizer+\(ilitekSiblings.count) mouse sibling(s); requested seize option=\(kIOHIDOptionsTypeSeizeDevice)")
    }

    private func closeILITEKDevice() {
        opened = false
        if let device = ilitekDevice {
            IOHIDDeviceRegisterRemovalCallback(device, nil, nil)
            IOHIDDeviceRegisterInputValueCallback(device, nil, nil)
            IOHIDDeviceUnscheduleFromRunLoop(device, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
            IOHIDDeviceClose(device, IOOptionBits(0))
            ilitekDevice = nil
        }
        for sibling in ilitekSiblings {
            IOHIDDeviceRegisterRemovalCallback(sibling, nil, nil)
            IOHIDDeviceUnscheduleFromRunLoop(sibling, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
            IOHIDDeviceClose(sibling, IOOptionBits(0))
        }
        ilitekSiblings = []
        ilitekPendingSample = nil
        ilitekSourceSelector = ILITEKContactSourceSelector()
        ilitekFlushScheduled = false
    }

    private func handleILITEKRemoval() {
        guard opened else { return }
        queue.async { [weak self] in
            guard let self else { return }
            for action in self.engine.cancel() { self.poster.perform(action) }
        }
        closeILITEKDevice()
        state = .busy(.openFailed(UInt32(bitPattern: kIOReturnNoDevice)))
        failedToOpen()
    }

    private static func propertyInt(_ device: IOHIDDevice, _ key: String) -> Int {
        (IOHIDDeviceGetProperty(device, key as CFString) as? NSNumber)?.intValue ?? 0
    }

    private static func isILITEKTouchscreen(_ device: IOHIDDevice) -> Bool {
        let vendor = propertyInt(device, "VendorID")
        let product = propertyInt(device, "ProductID")
        guard vendor == 0x222A, product == 0x0001 else { return false }
        return hasUsage(device, page: 0x0D, usage: 0x04)
    }

    private static func isEdgeTouchscreen(_ device: IOHIDDevice) -> Bool {
        let vendor = propertyInt(device, "VendorID")
        let product = propertyInt(device, "ProductID")
        guard vendor == Hardware.vendorID, product == Hardware.productID else { return false }
        return hasUsage(device, page: Hardware.usagePage, usage: Hardware.usage)
    }

    private static func isMouseCollection(_ device: IOHIDDevice) -> Bool {
        hasUsage(device, page: 0x01, usage: 0x02)
    }

    private static func hasUsage(_ device: IOHIDDevice, page: Int, usage: Int) -> Bool {
        guard let pairs = IOHIDDeviceGetProperty(device, "DeviceUsagePairs" as CFString) as? [[String: Any]] else {
            return propertyInt(device, "PrimaryUsagePage") == page && propertyInt(device, "PrimaryUsage") == usage
        }
        return pairs.contains {
            ($0["DeviceUsagePage"] as? NSNumber)?.intValue == page
                && ($0["DeviceUsage"] as? NSNumber)?.intValue == usage
        }
    }

    private static func physicalKey(for device: IOHIDDevice) -> HIDPhysicalDeviceKey {
        HIDPhysicalDeviceKey(vendorID: propertyInt(device, "VendorID"),
                             productID: propertyInt(device, "ProductID"),
                             locationID: propertyInt(device, "LocationID"))
    }

    private static func primaryFingerCookie(_ device: IOHIDDevice) -> UInt64? {
        guard let elements = IOHIDDeviceCopyMatchingElements(device, nil, IOOptionBits(0)) as? [IOHIDElement] else {
            return nil
        }
        return elements.filter {
            IOHIDElementGetType($0) == kIOHIDElementTypeCollection
                && IOHIDElementGetUsagePage($0) == kHIDPage_Digitizer
                && IOHIDElementGetUsage($0) == kHIDUsage_Dig_Finger
        }.map { UInt64(IOHIDElementGetCookie($0)) }.min()
    }

    private func handleILITEKValue(_ value: IOHIDValue) {
        let element = IOHIDValueGetElement(value)
        let valueDevice = IOHIDElementGetDevice(element)
        let source: ILITEKTouchSource
        if let device = ilitekDevice, CFEqual(valueDevice, device) {
            source = .digitizer
        } else if ilitekSiblings.contains(where: { CFEqual(valueDevice, $0) }) {
            source = .mouse
        } else {
            return
        }
        let parent = IOHIDElementGetParent(element)
        let parentCookie: UInt64?
        if let parent,
           IOHIDElementGetUsagePage(parent) == kHIDPage_Digitizer,
           IOHIDElementGetUsage(parent) == kHIDUsage_Dig_Finger {
            parentCookie = UInt64(IOHIDElementGetCookie(parent))
        } else {
            parentCookie = nil
        }
        let relative = (IOHIDElementGetProperty(element, "IsRelative" as CFString) as? NSNumber)?.boolValue ?? false
        let elementValue = HIDTouchElementValue(
            usagePage: Int(IOHIDElementGetUsagePage(element)),
            usage: Int(IOHIDElementGetUsage(element)),
            value: IOHIDValueGetIntegerValue(value),
            logicalMinimum: Int(IOHIDElementGetLogicalMin(element)),
            logicalMaximum: Int(IOHIDElementGetLogicalMax(element)),
            isRelative: relative,
            fingerCookie: parentCookie
        )
        switch source {
        case .digitizer: ilitekDecoder.consume(elementValue)
        case .mouse: ilitekMouseDecoder.consume(elementValue)
        }
        let decodedSample = source == .digitizer ? ilitekDecoder.sample : ilitekMouseDecoder.sample
        guard let sample = ilitekSourceSelector.select(decodedSample, from: source) else {
            traceILITEK("callback source=\(source) usage=\(elementValue.usagePage):\(elementValue.usage) value=\(elementValue.value) ignored contact=\(decodedSample.isDown)")
            return
        }
        ilitekPendingSample = sample
        traceILITEK(String(format: "callback source=%@ usage=%04X:%04X value=%ld decoded x=%.4f y=%.4f down=%@",
                            String(describing: source), elementValue.usagePage, elementValue.usage,
                            elementValue.value, sample.x, sample.y, sample.isDown ? "yes" : "no"))
        guard !ilitekFlushScheduled else { return }
        ilitekFlushScheduled = true
        DispatchQueue.main.async { [weak self] in self?.flushILITEKValues() }
    }

    private func flushILITEKValues() {
        ilitekFlushScheduled = false
        guard opened else { return }
        guard let sample = ilitekPendingSample else { return }
        ilitekPendingSample = nil
        queue.async { [weak self] in
            guard let self, let mapper = self.mapper else { return }
            let point = mapper.point(normalizedX: sample.x, normalizedY: sample.y)
            let touch = TouchSample(down: sample.isDown, point: point, time: ProcessInfo.processInfo.systemUptime)
            self.traceILITEK(String(format: "mapped x=%.2f y=%.2f down=%@", point.x, point.y, sample.isDown ? "yes" : "no"))
            for action in self.engine.feed(touch) {
                self.traceILITEK("action/post \(action)")
                self.poster.perform(action)
            }
        }
    }

    private func traceILITEK(_ message: String) {
        guard ilitekTraceEnabled else { return }
        FileHandle.standardError.write(Data("[ilitek-trace] \(message)\n".utf8))
    }

    private static let ilitekValueCallback: IOHIDValueCallback = { context, result, _, value in
        guard result == kIOReturnSuccess, let context else { return }
        let driver = Unmanaged<TouchDriver>.fromOpaque(context).takeUnretainedValue()
        if Thread.isMainThread { driver.handleILITEKValue(value) }
        else { DispatchQueue.main.async { driver.handleILITEKValue(value) } }
    }

    private static let ilitekRemovalCallback: IOHIDCallback = { context, _, _ in
        guard let context else { return }
        let driver = Unmanaged<TouchDriver>.fromOpaque(context).takeUnretainedValue()
        DispatchQueue.main.async { driver.handleILITEKRemoval() }
    }

    /// Backs off before the next attempt.
    ///
    /// While Input Monitoring is missing or another driver holds the panel, every open fails and
    /// the matching callback fires again for the device the failed manager still enrolled, so a
    /// fixed delay would rebuild an `IOHIDManager` twice a second forever.
    private func failedToOpen() {
        // Schedule first, so the first retry uses the initial 0.5 s and only the next one doubles.
        scheduleReopen()
        reopenBackoff = min(reopenBackoff * 2, Self.reopenDelayCap)
    }

    private func closeManager() {
        opened = false
        guard let manager else { return }
        IOHIDManagerUnscheduleFromRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
        IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        self.manager = nil
    }

    /// Coalesces the reconnect triggers (wake, matching, removal, failed open) into a single
    /// re-open, after the current backoff delay.
    private func scheduleReopen(resetBackoff: Bool = false) {
        guard running, !reopenPending else { return }
        if resetBackoff { reopenBackoff = Self.reopenDelay }
        reopenPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + reopenBackoff) { [weak self] in
            guard let self else { return }
            self.reopenPending = false
            guard self.running else { return }
            if self.hardwareProfile == .ilitek { self.openILITEKDevice() }
            else { self.openManager() }
        }
    }

    private func handle(_ bytes: [UInt8], reportID: UInt8) {
        let now = ProcessInfo.processInfo.systemUptime
        queue.async { [weak self] in
            guard let self else { return }

            // Some transports deliver the payload without its leading report id, which
            // `TouchReport.parse` expects. Decide on the length rather than on the first byte,
            // which could legitimately equal the id.
            var frame = bytes
            if bytes.count == TouchReport.length - 1 { frame.insert(reportID, at: 0) }

            let report = TouchReport.parse(frame)
            self.onRawReport?(reportID, bytes, report)

            guard let report, let mapper = self.mapper else { return }
            let point = mapper.point(x: report.x, y: report.y)
            let sample = TouchSample(down: report.down, point: point, time: now)
            for action in self.engine.feed(sample) { self.poster.perform(action) }
        }
    }
}
