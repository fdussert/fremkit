import CoreGraphics
import Foundation

/// Reads TouchRemap's selected screen as a read-only preference for this local ILITEK trial.
/// Fremkit never writes this file, and it does not activate TouchRemap's currently-disabled
/// calibration settings.
enum ILITEKDisplayTarget {
    private struct TouchRemapPreference: Decodable {
        let lastScreen: String?
    }

    /// `fallbackSize` is the dashboard display's size in points: macOS renumbers displays when
    /// they reconnect, so a saved `id:` can name a screen that is gone. The one active display of
    /// that size is then the same panel.
    static func bounds(fallbackSize: CGSize? = nil) -> CGRect? {
        savedBounds() ?? fallbackSize.flatMap(uniqueDisplay(ofSize:))
    }

    private static func uniqueDisplay(ofSize size: CGSize) -> CGRect? {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return nil }
        let matches = ids.prefix(Int(count)).map(CGDisplayBounds).filter { $0.size == size }
        return matches.count == 1 ? matches[0] : nil
    }

    private static func savedBounds() -> CGRect? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let url = support.appendingPathComponent("pd-touchbase/remap_config.json")
        guard let data = try? Data(contentsOf: url),
              let preference = try? JSONDecoder().decode(TouchRemapPreference.self, from: data),
              let key = preference.lastScreen,
              key.hasPrefix("id:"),
              let rawID = UInt32(key.dropFirst(3)) else { return nil }
        let displayID = CGDirectDisplayID(rawID)
        guard CGDisplayIsActive(displayID) != 0 else { return nil }
        let frame = CGDisplayBounds(displayID)
        guard frame.width > 0, frame.height > 0 else { return nil }
        return frame
    }
}
