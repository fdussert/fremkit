import CoreGraphics
import Foundation
import FremkitCore
import IOKit

/// The private functions brightness needs, looked up at run time.
///
/// `IOAVService*` (IOKit), `CoreDisplay_DisplayCreateInfoDictionary` and
/// `DisplayServicesGetBrightness` are not public API. Linking them by name would make the whole
/// helper fail to launch on a macOS that drops one; looked up with `dlsym`, a missing symbol only
/// makes brightness unavailable.
enum PrivateDisplayAPI {
    typealias AVCreate = @convention(c) (CFAllocator?, io_service_t) -> Unmanaged<CFTypeRef>?
    typealias AVTransfer = @convention(c) (CFTypeRef, UInt32, UInt32, UnsafeMutableRawPointer, UInt32) -> IOReturn
    typealias InfoDictionary = @convention(c) (CGDirectDisplayID) -> Unmanaged<CFDictionary>?
    typealias GetBrightness = @convention(c) (CGDirectDisplayID, UnsafeMutablePointer<Float>) -> Int32

    private static func symbol<T>(_ library: String, _ name: String, as type: T.Type) -> T? {
        guard let handle = dlopen(library, RTLD_LAZY), let pointer = dlsym(handle, name) else { return nil }
        return unsafeBitCast(pointer, to: type)
    }

    private static let iokit = "/System/Library/Frameworks/IOKit.framework/IOKit"
    static let avCreate = symbol(iokit, "IOAVServiceCreateWithService", as: AVCreate.self)
    static let avRead = symbol(iokit, "IOAVServiceReadI2C", as: AVTransfer.self)
    static let avWrite = symbol(iokit, "IOAVServiceWriteI2C", as: AVTransfer.self)
    static let infoDictionary = symbol("/System/Library/Frameworks/CoreDisplay.framework/CoreDisplay",
                                       "CoreDisplay_DisplayCreateInfoDictionary", as: InfoDictionary.self)
    static let getBrightness = symbol("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices",
                                      "DisplayServicesGetBrightness", as: GetBrightness.self)
}

/// One display's DDC/CI line. Every call blocks for tens of milliseconds: run them off the main thread.
final class DDCService {
    let name: String?
    private let service: CFTypeRef
    /// Pauses the monitors need between the two halves of a transfer, from m1ddc and the probe.
    private static let beforeWrite: useconds_t = 10_000
    private static let beforeRead: useconds_t = 50_000
    private static let attempts = 4

    private init(service: CFTypeRef, name: String?) {
        self.service = service
        self.name = name
    }

    enum Lookup {
        case found(DDCService)
        case unavailable(BrightnessChannel.Unavailable)
    }

    /// The DDC service of a display, matched through its framebuffer (see `DDCMatcher`).
    static func find(for display: CGDirectDisplayID) -> Lookup {
        guard let create = PrivateDisplayAPI.avCreate, PrivateDisplayAPI.avRead != nil, PrivateDisplayAPI.avWrite != nil
        else { return .unavailable(.noDDC) }
        let info = PrivateDisplayAPI.infoDictionary?(display)?.takeRetainedValue() as? [String: Any]
        let target = DDCMatcher.Target(
            location: info?["IODisplayLocation"] as? String,
            vendor: Int(CGDisplayVendorNumber(display)),
            product: Int(CGDisplayModelNumber(display)),
            serial: Int(CGDisplaySerialNumber(display))
        )

        var candidates: [DDCMatcher.Candidate] = []
        var entries: [io_service_t] = []
        var iterator = io_iterator_t()
        guard IORegistryCreateIterator(kIOMainPortDefault, kIOServicePlane, IOOptionBits(kIORegistryIterateRecursively), &iterator) == KERN_SUCCESS
        else { return .unavailable(.noDDC) }
        defer { IOObjectRelease(iterator) }
        // The registry lists a framebuffer, then the services below it: remember the last one seen.
        var framebuffer: String?
        var attributes: [String: Any]?
        while case let entry = IOIteratorNext(iterator), entry != 0 {
            var nameBuffer = [CChar](repeating: 0, count: 128)
            IORegistryEntryGetName(entry, &nameBuffer)
            let entryName = String(cString: nameBuffer)
            if entryName == "IOMobileFramebufferShim" || entryName == "AppleCLCD2" {
                var path = [CChar](repeating: 0, count: 1024)
                framebuffer = IORegistryEntryGetPath(entry, kIOServicePlane, &path) == KERN_SUCCESS ? String(cString: path) : nil
                let display = IORegistryEntryCreateCFProperty(entry, "DisplayAttributes" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? [String: Any]
                attributes = display?["ProductAttributes"] as? [String: Any]
            }
            guard entryName == "DCPAVServiceProxy",
                  IORegistryEntryCreateCFProperty(entry, "Location" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String == "External"
            else { IOObjectRelease(entry); continue }
            candidates.append(DDCMatcher.Candidate(
                framebuffer: framebuffer,
                vendor: attributes?["LegacyManufacturerID"] as? Int,
                product: attributes?["ProductID"] as? Int,
                serial: attributes?["SerialNumber"] as? Int,
                name: attributes?["ProductName"] as? String
            ))
            entries.append(entry)
        }
        defer { entries.forEach { IOObjectRelease($0) } }

        switch DDCMatcher.match(target, among: candidates) {
        case .none: return .unavailable(.noDDC)
        case .ambiguous: return .unavailable(.ambiguous)
        case let .match(index):
            guard let service = create(kCFAllocatorDefault, entries[index])?.takeRetainedValue() else { return .unavailable(.noDDC) }
            return .found(DDCService(service: service, name: candidates[index].name))
        }
    }

    /// Reads the brightness, retrying a monitor that is not ready yet.
    func read() -> DDC.Value? {
        guard let write = PrivateDisplayAPI.avWrite, let read = PrivateDisplayAPI.avRead else { return nil }
        var request = DDC.getRequest(DDC.luminance)
        for _ in 0..<Self.attempts {
            usleep(Self.beforeWrite)
            guard write(service, DDC.chipAddress, DDC.dataAddress, &request, UInt32(request.count)) == KERN_SUCCESS else { continue }
            usleep(Self.beforeRead)
            var reply = [UInt8](repeating: 0, count: DDC.replyLength)
            guard read(service, DDC.chipAddress, DDC.dataAddress, &reply, UInt32(reply.count)) == KERN_SUCCESS else { continue }
            switch DDC.parseReply(reply, code: DDC.luminance) {
            case let .success(value): return value
            case .failure(.unsupported): return nil
            case .failure: continue
            }
        }
        return nil
    }

    /// Writes a raw level and reads it back, retrying until the display has taken it; returns the last read-back.
    func write(raw: UInt16, maximum: Int) -> DDC.Value? {
        guard let write = PrivateDisplayAPI.avWrite else { return nil }
        var request = DDC.setRequest(DDC.luminance, value: raw)
        var last: DDC.Value?
        for _ in 0..<Self.attempts {
            usleep(Self.beforeWrite)
            guard write(service, DDC.chipAddress, DDC.dataAddress, &request, UInt32(request.count)) == KERN_SUCCESS else { continue }
            usleep(Self.beforeRead)
            // Monitors drop commands: the read-back is what says whether this one landed.
            last = read()
            if let value = last, abs(value.current - Int(raw)) <= max(1, maximum / 100) { return value }
        }
        return last
    }
}

/// The Mac's built-in display, which follows the ambient light sensor.
enum BuiltinDisplay {
    /// Its brightness, 0–1, or nil when the Mac has none, the lid is closed, or the call fails.
    static func brightness() -> Double? {
        guard let get = PrivateDisplayAPI.getBrightness else { return nil }
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return nil }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return nil }
        guard let builtin = ids.prefix(Int(count)).first(where: { CGDisplayIsBuiltin($0) != 0 }) else { return nil }
        var level: Float = 0
        guard get(builtin, &level) == 0, level.isFinite else { return nil }
        return Double(max(0, min(1, level)))
    }
}
