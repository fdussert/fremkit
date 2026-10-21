import AppKit
import CoreGraphics
import Foundation

struct Result: Encodable {
    let ok: Bool
    var error: String? = nil

    static func success() -> Result { Result(ok: true) }
    static func failure(_ error: String) -> Result { Result(ok: false, error: error) }
}

func respond(_ result: Result) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(result) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } else {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":\"unavailable\"}\n".utf8))
    }
    exit(0)
}

/**
 * Posts one key press to whatever has the focus, through the HID tap: the kiosk panel never
 * activates, so the event lands in the app the user was typing in — exactly where ⌘V typed by
 * hand would go. Key codes are hardware codes: 9 is 'v', 36 is Return.
 */
func press(_ keyCode: CGKeyCode, flags: CGEventFlags = []) -> Bool {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        return false
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return true
}

guard AXIsProcessTrusted() else { respond(.failure("permission-required")) }

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "paste" where args.count >= 2:
    // The pasteboard write and the keystroke are one process: the value travels as argv and is
    // never interpolated into code, and the Transient marker keeps clipboard managers from
    // remembering a button's saved value.
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.declareTypes([.string, NSPasteboard.PasteboardType("org.nspasteboard.TransientType")], owner: nil)
    guard pasteboard.setString(args[1], forType: .string) else { respond(.failure("unavailable")) }
    respond(press(9, flags: .maskCommand) ? .success() : .failure("unavailable"))
case "enter":
    respond(press(36) ? .success() : .failure("unavailable"))
default:
    respond(.failure("unavailable"))
}
