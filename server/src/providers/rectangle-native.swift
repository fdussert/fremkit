import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct Target: Codable {
    let pid: Int32
    let bundleId: String
    let title: String
    let application: String
    let windowID: UInt32
}

struct WindowCandidate: Codable {
    let windowID: UInt32
    let pid: Int32
    let title: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var bounds: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

struct IdentityProbe: Decodable {
    let pid: Int32
    let title: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let expectedWindowID: UInt32?
    let windows: [WindowCandidate]
}

struct Response: Encodable {
    let ok: Bool
    let error: String?
    let target: Target?
    let changed: Bool?

    init(ok: Bool, error: String? = nil, target: Target? = nil, changed: Bool? = nil) {
        self.ok = ok
        self.error = error
        self.target = target
        self.changed = changed
    }
}

struct Display {
    let id: CGDirectDisplayID
    let frame: CGRect
    let usable: CGRect
}

func respond(_ response: Response) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(response), let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"ok\":false,\"error\":\"response-encoding-failed\"}")
    }
    exit(0)
}

func axValue(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axValue(element, attribute) as? String
}

func pointAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let value = axValue(element, attribute) else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func sizeAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let value = axValue(element, attribute) else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func closeEnough(_ lhs: CGFloat, _ rhs: CGFloat) -> Bool { abs(lhs - rhs) <= 4 }

// CGWindowID is unique within the current user session. AX does not expose that ID directly,
// so map its focused window to exactly one Core Graphics row by owner, title, and bounds.
// If the mapping is absent or ambiguous, do not guess which same-titled window was focused.
func matchingWindowID(pid: Int32, title: String, bounds: CGRect, expectedWindowID: UInt32? = nil, candidates: [WindowCandidate]) -> UInt32? {
    let matches = candidates.filter { candidate in
        candidate.pid == pid && candidate.title == title &&
        closeEnough(CGFloat(candidate.x), bounds.minX) && closeEnough(CGFloat(candidate.y), bounds.minY) &&
        closeEnough(CGFloat(candidate.width), bounds.width) && closeEnough(CGFloat(candidate.height), bounds.height)
    }
    guard matches.count == 1, let match = matches.first, match.windowID != kCGNullWindowID else { return nil }
    if let expectedWindowID, expectedWindowID != match.windowID { return nil }
    return match.windowID
}

func onScreenWindowCandidates() -> [WindowCandidate]? {
    guard let rawWindows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else { return nil }
    return rawWindows.compactMap { info in
        guard let pid = info[kCGWindowOwnerPID as String] as? NSNumber,
              let windowID = info[kCGWindowNumber as String] as? NSNumber,
              let title = info[kCGWindowName as String] as? String,
              let rawBounds = info[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
              windowID.uint32Value != kCGNullWindowID else { return nil }
        return WindowCandidate(windowID: windowID.uint32Value, pid: pid.int32Value, title: title,
                               x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height)
    }
}

func focusedTarget(expected: Target? = nil) -> (Target, AXUIElement, CGPoint, CGSize)? {
    guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let pid = app.processIdentifier
    guard let bundleId = app.bundleIdentifier, let appName = app.localizedName else { return nil }
    guard !bundleId.localizedCaseInsensitiveContains("fremkit"),
          !bundleId.localizedCaseInsensitiveContains("rectangle"),
          !appName.localizedCaseInsensitiveContains("fremkit"),
          !appName.localizedCaseInsensitiveContains("rectangle") else { return nil }
    if let expected, (expected.pid != pid || expected.bundleId != bundleId) { return nil }

    let application = AXUIElementCreateApplication(pid)
    guard let rawWindow = axValue(application, kAXFocusedWindowAttribute as CFString) else { return nil }
    let window = rawWindow as! AXUIElement
    guard let title = stringAttribute(window, kAXTitleAttribute as CFString),
          let position = pointAttribute(window, kAXPositionAttribute as CFString),
          let size = sizeAttribute(window, kAXSizeAttribute as CFString) else { return nil }
    if let expected, expected.title != title { return nil }
    guard let candidates = onScreenWindowCandidates(),
          let windowID = matchingWindowID(pid: pid, title: title, bounds: CGRect(origin: position, size: size),
                                          expectedWindowID: expected?.windowID, candidates: candidates) else { return nil }
    let target = Target(pid: pid, bundleId: bundleId, title: title, application: appName, windowID: windowID)
    return (target, window, position, size)
}

func displays() -> [Display] {
    NSScreen.screens.compactMap { screen in
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        let id = CGDirectDisplayID(number.uint32Value)
        let frame = CGDisplayBounds(id)
        let appKitFrame = screen.frame
        let visible = screen.visibleFrame
        let usable = CGRect(
            x: frame.minX + visible.minX - appKitFrame.minX,
            y: frame.minY + appKitFrame.maxY - visible.maxY,
            width: visible.width,
            height: visible.height
        )
        return Display(id: id, frame: frame, usable: usable)
    }.sorted {
        if $0.frame.minX == $1.frame.minX { return $0.frame.minY < $1.frame.minY }
        return $0.frame.minX < $1.frame.minX
    }
}

func displayFor(_ position: CGPoint, _ size: CGSize, in displays: [Display]) -> Int? {
    let window = CGRect(origin: position, size: size)
    let center = CGPoint(x: window.midX, y: window.midY)
    if let exact = displays.firstIndex(where: { $0.frame.contains(center) }) { return exact }
    let overlaps = displays.enumerated().map { index, display in (index, window.intersection(display.frame).width * window.intersection(display.frame).height) }
    return overlaps.max(by: { $0.1 < $1.1 })?.0
}

func setAX(_ window: AXUIElement, attribute: CFString, point: CGPoint) -> Bool {
    var value = point
    guard let boxed = AXValueCreate(.cgPoint, &value) else { return false }
    return AXUIElementSetAttributeValue(window, attribute, boxed) == .success
}

func setAX(_ window: AXUIElement, attribute: CFString, size: CGSize) -> Bool {
    var value = size
    guard let boxed = AXValueCreate(.cgSize, &value) else { return false }
    return AXUIElementSetAttributeValue(window, attribute, boxed) == .success
}

func waitForGeometry(_ expected: Target, position: CGPoint, size: CGSize) -> Bool {
    for _ in 0..<30 {
        if let (_, _, actualPosition, actualSize) = focusedTarget(expected: expected),
           closeEnough(actualPosition.x, position.x), closeEnough(actualPosition.y, position.y),
           closeEnough(actualSize.width, size.width), closeEnough(actualSize.height, size.height) {
            return true
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    return false
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (axValue(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func role(_ element: AXUIElement) -> String {
    stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
}

func menuAction(_ path: [String], expected: Target) -> Bool {
    guard !path.isEmpty, let (target, _, _, _) = focusedTarget(expected: expected),
          target.pid == expected.pid,
          let menuBarValue = axValue(AXUIElementCreateApplication(expected.pid), kAXMenuBarAttribute as CFString),
          CFGetTypeID(menuBarValue) == AXUIElementGetTypeID() else { return false }
    let menuBar = menuBarValue as! AXUIElement
    guard let windowMenu = children(menuBar).first(where: {
        role($0) == kAXMenuBarItemRole as String && stringAttribute($0, kAXTitleAttribute as CFString) == path[0]
    }), AXUIElementPerformAction(windowMenu, kAXPressAction as CFString) == .success else { return false }
    Thread.sleep(forTimeInterval: 0.05)
    guard let topMenu = children(windowMenu).first(where: { role($0) == kAXMenuRole as String }) else { return false }
    var currentMenu = topMenu
    for (index, title) in path.dropFirst().enumerated() {
        guard let item = children(currentMenu).first(where: {
            role($0) == kAXMenuItemRole as String && stringAttribute($0, kAXTitleAttribute as CFString) == title
        }) else { return false }
        let isFinalItem = index == path.count - 2
        if isFinalItem, focusedTarget(expected: expected) == nil { return false }
        guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { return false }
        if isFinalItem { return true }
        Thread.sleep(forTimeInterval: 0.05)
        guard let submenu = children(item).first(where: { role($0) == kAXMenuRole as String }) else { return false }
        currentMenu = submenu
    }
    return false
}

func runAction(_ action: String, expected: Target) {
    guard let (_, window, oldPosition, oldSize) = focusedTarget(expected: expected) else {
        respond(Response(ok: false, error: "target-changed-or-unavailable"))
    }
    let screens = displays()
    guard !screens.isEmpty, let currentIndex = displayFor(oldPosition, oldSize, in: screens) else {
        respond(Response(ok: false, error: "display-unavailable"))
    }
    let targetPosition: CGPoint
    let targetSize: CGSize
    switch action {
    case "left-half":
        let area = screens[currentIndex].usable
        targetPosition = CGPoint(x: area.minX, y: area.minY)
        targetSize = CGSize(width: floor(area.width / 2), height: area.height)
    case "right-half":
        let area = screens[currentIndex].usable
        let width = floor(area.width / 2)
        targetPosition = CGPoint(x: area.minX + area.width - width, y: area.minY)
        targetSize = CGSize(width: width, height: area.height)
    case "fill":
        let area = screens[currentIndex].usable
        targetPosition = CGPoint(x: area.minX, y: area.minY)
        targetSize = CGSize(width: area.width, height: area.height)
    case "next-display":
        guard screens.count > 1 else { respond(Response(ok: false, error: "no-next-display")) }
        let next = screens[(currentIndex + 1) % screens.count].usable
        targetSize = CGSize(width: min(oldSize.width, next.width), height: min(oldSize.height, next.height))
        targetPosition = CGPoint(x: next.midX - targetSize.width / 2, y: next.midY - targetSize.height / 2)
    default:
        respond(Response(ok: false, error: "invalid-action"))
    }

    var settablePosition = DarwinBoolean(false)
    var settableSize = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(window, kAXPositionAttribute as CFString, &settablePosition) == .success,
          AXUIElementIsAttributeSettable(window, kAXSizeAttribute as CFString, &settableSize) == .success,
          settablePosition.boolValue, settableSize.boolValue else {
        respond(Response(ok: false, error: "window-not-resizable"))
    }

    if action == "next-display" {
        guard focusedTarget(expected: expected) != nil else {
            respond(Response(ok: false, error: "target-changed-or-unavailable"))
        }
        guard setAX(window, attribute: kAXPositionAttribute as CFString, point: targetPosition) else {
            respond(Response(ok: false, error: "window-action-rejected"))
        }
    } else {
        let menuPath: [String]
        switch action {
        case "left-half": menuPath = ["Window", "Move & Resize", "Left"]
        case "right-half": menuPath = ["Window", "Move & Resize", "Right"]
        case "fill": menuPath = ["Window", "Fill"]
        default: respond(Response(ok: false, error: "invalid-action"))
        }
        guard menuAction(menuPath, expected: expected) else {
            respond(Response(ok: false, error: "native-menu-action-unavailable"))
        }
    }
    // Native tiling animates asynchronously; poll the same guarded window for at most 1.5 seconds.
    guard waitForGeometry(expected, position: targetPosition, size: targetSize) else {
        respond(Response(ok: false, error: "geometry-unverified"))
    }
    respond(Response(ok: true, changed: true))
}

let arguments = Array(CommandLine.arguments.dropFirst())
if ProcessInfo.processInfo.environment["FREMKIT_RECTANGLE_TESTING"] == "1", arguments.first == "test-window-identity" {
    guard arguments.count == 2,
          let data = arguments[1].data(using: .utf8),
          let probes = try? JSONDecoder().decode([IdentityProbe].self, from: data) else {
        respond(Response(ok: false, error: "invalid-test-probe"))
    }
    let windowIDs = probes.map { probe in
        matchingWindowID(pid: probe.pid, title: probe.title,
                         bounds: CGRect(x: probe.x, y: probe.y, width: probe.width, height: probe.height),
                         expectedWindowID: probe.expectedWindowID, candidates: probe.windows)
    }
    if let data = try? JSONEncoder().encode(windowIDs), let output = String(data: data, encoding: .utf8) { print(output) }
    else { respond(Response(ok: false, error: "identity-test-encoding-failed")) }
    exit(0)
}
guard let mode = arguments.first else { respond(Response(ok: false, error: "missing-mode")) }
guard AXIsProcessTrusted() else { respond(Response(ok: false, error: "accessibility-permission-required")) }

if mode == "inspect" {
    guard let (target, _, _, _) = focusedTarget() else { respond(Response(ok: false, error: "no-safe-window")) }
    respond(Response(ok: true, target: target))
}

guard mode == "run", arguments.count >= 6,
      let pid = Int32(arguments[1]), let windowID = UInt32(arguments[4]) else { respond(Response(ok: false, error: "invalid-request")) }
let expected = Target(pid: pid, bundleId: arguments[2], title: arguments[3], application: "", windowID: windowID)
let invocation = Array(arguments.dropFirst(5))
if invocation.count == 4, invocation[0] == "menu", invocation[1] == "Window" {
    let action = invocation[2] == "Fill" ? "fill" : invocation[3] == "Left" ? "left-half" : invocation[3] == "Right" ? "right-half" : "invalid"
    runAction(action, expected: expected)
} else if invocation == ["menu", "Window", "Fill"] {
    runAction("fill", expected: expected)
} else if invocation == ["position", "next-display"] {
    runAction("next-display", expected: expected)
} else {
    respond(Response(ok: false, error: "invalid-request"))
}
