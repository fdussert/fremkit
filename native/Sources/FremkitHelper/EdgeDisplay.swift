import AppKit
import CoreGraphics
import Foundation

/// Locates the Corsair Xeneon Edge display among the active displays by its pixel size.
enum EdgeDisplay {
    /// Bounds of the first active display whose size matches, in global coordinates.
    static func find(width: Int, height: Int) -> CGRect? {
        findID(width: width, height: height).map(CGDisplayBounds)
    }

    /// The first active display whose size matches: the one the kiosk goes on.
    static func findID(width: Int, height: Int) -> CGDirectDisplayID? {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return nil }

        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return nil }

        return ids.prefix(Int(count)).first { id in
            let bounds = CGDisplayBounds(id)
            return Int(bounds.width.rounded()) == width && Int(bounds.height.rounded()) == height
        }
    }

    /// Re-runs `find` whenever the screen layout changes and reports the result.
    ///
    /// The callback fires once at creation so callers start from a known state.
    final class Watcher {
        private let width: Int
        private let height: Int
        private let onChange: (CGRect?) -> Void
        private var observer: NSObjectProtocol?

        init(width: Int, height: Int, onChange: @escaping (CGRect?) -> Void) {
            self.width = width
            self.height = height
            self.onChange = onChange

            observer = NotificationCenter.default.addObserver(
                forName: NSApplication.didChangeScreenParametersNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                self.onChange(EdgeDisplay.find(width: self.width, height: self.height))
            }
            onChange(EdgeDisplay.find(width: width, height: height))
        }

        deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
    }
}
