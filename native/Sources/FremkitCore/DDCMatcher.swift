import Foundation

/// Picks which DDC service belongs to the kiosk's display.
///
/// On Apple silicon each external display has a `DCPAVServiceProxy` in the I/O registry, under the
/// framebuffer (`IOMobileFramebufferShim`) that drives it, and CoreDisplay names that framebuffer
/// for a `CGDirectDisplayID` as its `IODisplayLocation`. Matching on that path is exact, whatever
/// the displays are: two identical monitors side by side have different framebuffers. The EDID
/// identity (vendor, product, serial) is only the fallback for when the location cannot be read,
/// and an ambiguous fallback picks nothing — writing to the wrong monitor is worse than not
/// writing at all.
public enum DDCMatcher {
    /// One external DDC service found in the registry.
    public struct Candidate: Equatable {
        /// Registry path of the framebuffer above the service, e.g. `IOService:/…/dispext0@…/IOMobileFramebufferShim`.
        public let framebuffer: String?
        public let vendor: Int?
        public let product: Int?
        public let serial: Int?
        public let name: String?
        public init(framebuffer: String?, vendor: Int?, product: Int?, serial: Int?, name: String?) {
            self.framebuffer = framebuffer
            self.vendor = vendor
            self.product = product
            self.serial = serial
            self.name = name
        }
    }

    /// The display to drive, as CoreGraphics and CoreDisplay describe it.
    public struct Target: Equatable {
        /// CoreDisplay's `IODisplayLocation`, when it could be read.
        public let location: String?
        public let vendor: Int
        public let product: Int
        /// 0 when the EDID carries none.
        public let serial: Int
        public init(location: String?, vendor: Int, product: Int, serial: Int) {
            self.location = location
            self.vendor = vendor
            self.product = product
            self.serial = serial
        }
    }

    public enum Outcome: Equatable {
        case match(Int)
        case none
        case ambiguous
    }

    /// The index of the candidate that drives `target`.
    public static func match(_ target: Target, among candidates: [Candidate]) -> Outcome {
        if let location = target.location, !location.isEmpty {
            let hits = candidates.indices.filter { candidates[$0].framebuffer == location }
            if hits.count == 1 { return .match(hits[0]) }
            if hits.count > 1 { return .ambiguous }
            // The path is known but no service sits under it: that display has no DDC service
            // (HDMI on some Macs). Falling back to the EDID here would risk its twin's service.
            if candidates.contains(where: { $0.framebuffer != nil }) { return .none }
        }
        let sameModel = candidates.indices.filter {
            candidates[$0].vendor == target.vendor && candidates[$0].product == target.product
        }
        let exact = target.serial != 0 ? sameModel.filter { candidates[$0].serial == target.serial } : sameModel
        if exact.count == 1 { return .match(exact[0]) }
        if exact.count > 1 { return .ambiguous }
        return sameModel.isEmpty ? .none : .ambiguous
    }
}
