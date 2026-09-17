import AppKit
import Foundation
import FremkitCore

if CommandLine.arguments.contains("--probe") {
    // Headless diagnostic mode: open the touch panel, print what the gesture engine makes of it.
    // No window, no menu, no synthetic events.
    let config = HelperConfig.load(from: HelperConfig.defaultURL)
    let edge = EdgeDisplay.find(width: config.display.width, height: config.display.height)
    if edge == nil {
        print("probe: no \(config.display.width)x\(config.display.height) display found; touches are dropped")
    } else {
        print("probe: edge display at \(edge!)")
    }

    let driver = TouchDriver(poster: PrintPoster())
    var reportCount = 0
    driver.onRawReport = { reportID, bytes, parsed in
        reportCount += 1
        let hex = bytes.map { String(format: "%02x", $0) }.joined(separator: " ")
        print("report #\(reportCount): id=\(reportID) len=\(bytes.count) [\(hex)]")
        if let parsed {
            print("  decoded: down=\(parsed.down) x=\(parsed.x) y=\(parsed.y)")
        } else {
            print("  unparsed")
        }
    }
    driver.onState = { print("probe: touch \($0)") }
    driver.displayBounds = edge
    driver.start()

    RunLoop.main.run()
} else {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.run()
}
