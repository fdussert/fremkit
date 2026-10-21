import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct Result: Encodable {
    let ok: Bool
    var text: String? = nil
    var error: String? = nil

    static func success(_ text: String) -> Result { Result(ok: true, text: text) }
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

func isSecureField(_ element: AXUIElement) -> Bool {
    var subroleValue: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleValue) == .success
        && (subroleValue as? String) == (kAXSecureTextFieldSubrole as String)
}

func selectedText(of element: AXUIElement) -> String? {
    var selectionValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &selectionValue) == .success,
          let text = selectionValue as? String,
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return text
}

/**
 * Some editors never report focus into their text view — Sublime answers its window instead —
 * while a descendant carries the selection. When the focused element cannot answer
 * AXSelectedText at all, walk its subtree for one that does. Bounded: selections are rare and
 * shallow, and the walk stops at the first hit.
 */
func findSelection(in element: AXUIElement, depth: Int) -> String? {
    guard depth < 8 else { return nil }
    if !isSecureField(element), let text = selectedText(of: element) { return text }
    var childrenValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue) == .success,
          let children = childrenValue as? [AXUIElement] else { return nil }
    for child in children.prefix(80) {
        if let text = findSelection(in: child, depth: depth + 1) { return text }
    }
    return nil
}

func readSelection() -> Never {
    guard AXIsProcessTrusted() else { respond(.failure("permission-required")) }
    guard let frontmost = NSWorkspace.shared.frontmostApplication,
          let bundleId = frontmost.bundleIdentifier,
          !bundleId.localizedCaseInsensitiveContains("fremkit") else {
        respond(.failure("no-selection"))
    }

    let application = AXUIElementCreateApplication(frontmost.processIdentifier)
    AXUIElementSetMessagingTimeout(application, 1.0)
    var focusedValue: CFTypeRef?
    let focusedError = AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &focusedValue)
    guard focusedError == .success,
          let focusedValue,
          CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
        // No focused element either — the main window's subtree may still carry a selection.
        var windowValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(application, kAXMainWindowAttribute as CFString, &windowValue) == .success,
           let windowValue,
           CFGetTypeID(windowValue) == AXUIElementGetTypeID(),
           let text = findSelection(in: windowValue as! AXUIElement, depth: 0) {
            respond(.success(text))
        }
        respond(.failure(focusedError == .apiDisabled ? "permission-required" : "no-selection"))
    }

    let focused = focusedValue as! AXUIElement
    if isSecureField(focused) { respond(.failure("secure-field")) }

    var selectionValue: CFTypeRef?
    let selectionError = AXUIElementCopyAttributeValue(focused, kAXSelectedTextAttribute as CFString, &selectionValue)
    if selectionError == .success {
        // The element answers the attribute: an empty one really means nothing is selected.
        if let text = selectionValue as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            respond(.success(text))
        }
        respond(.failure("no-selection"))
    }
    if let text = findSelection(in: focused, depth: 0) { respond(.success(text)) }
    respond(.failure(selectionError == .apiDisabled ? "permission-required" : "no-selection"))
}

/**
 * The copy fallback for apps that never publish AXSelectedText — GPU-rendered editors and
 * terminals among them. ⌘C goes through the HID tap to whatever holds focus, exactly as typed
 * by hand. The pasteboard's changeCount is the receipt: when nothing was selected the app
 * copies nothing and the count stands still. Secure fields refuse ⌘C on their own.
 */
func copySelection() -> Never {
    guard AXIsProcessTrusted() else { respond(.failure("permission-required")) }
    guard let frontmost = NSWorkspace.shared.frontmostApplication,
          let bundleId = frontmost.bundleIdentifier,
          !bundleId.localizedCaseInsensitiveContains("fremkit") else {
        respond(.failure("no-selection"))
    }

    let pasteboard = NSPasteboard.general
    let before = pasteboard.changeCount
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 8, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 8, keyDown: false) else {
        respond(.failure("unavailable"))
    }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)

    var waited = 0
    while pasteboard.changeCount == before && waited < 700 {
        usleep(20_000)
        waited += 20
    }
    guard pasteboard.changeCount != before,
          let text = pasteboard.string(forType: .string),
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        respond(.failure("no-selection"))
    }
    respond(.success(text))
}

/**
 * Posts ⌘V through the HID tap — the paste half of copy→translate→paste. The pasteboard write
 * happens on the Node side; this only presses the key, so a failed write can never make the
 * user paste whatever was on the board before.
 */
func pasteOver() -> Never {
    guard AXIsProcessTrusted() else { respond(.failure("permission-required")) }
    guard let frontmost = NSWorkspace.shared.frontmostApplication,
          let bundleId = frontmost.bundleIdentifier,
          !bundleId.localizedCaseInsensitiveContains("fremkit") else {
        respond(.failure("no-selection"))
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false) else {
        respond(.failure("unavailable"))
    }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    respond(.success(""))
}

switch CommandLine.arguments.dropFirst().first {
case "read": readSelection()
case "copy": copySelection()
case "paste": pasteOver()
default: respond(.failure("unavailable"))
}
