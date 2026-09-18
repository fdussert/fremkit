import CoreGraphics
import Foundation
import FremkitCore

/// Anything that can turn a `PointerAction` into an effect (real events, or a print for `--probe`).
protocol PointerPoster: AnyObject {
    func perform(_ action: PointerAction)
}

/// Moves the cursor, keeping the hardware mouse and the cursor consistent across the jump.
///
/// `CGWarpMouseCursorPosition` leaves the HID mouse deltas untouched, so a physical mouse moving
/// at the same moment can drag the cursor straight back. Disassociating the mouse for the
/// duration of the warp and re-associating right after makes the new position stick.
func warpCursor(to point: CGPoint) {
    CGAssociateMouseAndMouseCursorPosition(0)
    CGWarpMouseCursorPosition(point)
    CGAssociateMouseAndMouseCursorPosition(1)
}

// Private window-server calls: by default only the frontmost app may hide the cursor, and the
// helper never is. Setting "SetsCursorInBackground" on our connection lifts that restriction
// (the same trick screen-sharing and remote-control tools rely on).
@_silgen_name("CGSMainConnectionID") private func CGSMainConnectionID() -> Int32
@_silgen_name("CGSSetConnectionProperty")
private func CGSSetConnectionProperty(_ cid: Int32, _ owner: Int32, _ key: CFString, _ value: CFTypeRef) -> Int32

/// Posts synthetic mouse events for the gestures recognised on the touch panel.
///
/// Every event carries `userData == 0x4652454D` ("FREM") on its source so the mouse fence
/// can recognise the helper's own events and let them through untouched.
final class EventPoster: PointerPoster {
    /// Marker written into the event source, checked by `MouseFence`.
    static let userData: Int64 = 0x4652_454D

    /// Delay before the cursor is put back where the user left it.
    private static let restoreDelay: TimeInterval = 0.25

    /// Flips the scroll direction, mirroring `HelperConfig.scrollInvert`.
    var scrollInvert = false

    private let source: CGEventSource?
    /**
     Guards the three fields below.

     `perform` runs on TouchDriver's own queue, once per HID report, while the restore work item
     runs on the main queue — so both touch this state. Unsynchronised, a gesture starting as a
     restore fires could read a half-written `savedCursor`, or hide the cursor twice and show it
     once (`CGDisplayHideCursor` counts nested hides per process, so it would stay hidden).

     A lock rather than a queue hop: `perform` posts events on the driver's thread on purpose,
     and these three mutations are a handful of instructions each.
     */
    private let lock = NSLock()
    /// Cursor position before the gesture moved it; captured at the first warp of a gesture.
    private var savedCursor: CGPoint?
    /// Pending restore; cancelled when a new gesture starts before it fires.
    private var pendingRestore: DispatchWorkItem?
    /// Whether the cursor is hidden for the gesture in progress; see `lock`.
    private var cursorHidden = false
    /**
     Bumped by every warp, and stamped on each restore work item.

     `DispatchWorkItem.cancel()` does nothing to a block that has already started, so a restore
     that fired just as a new gesture began would run to completion — warping the cursor away
     from the finger and showing it again in the middle of the new gesture. The block reads this
     under the lock and gives up when it has moved.
     */
    private var gesture: UInt64 = 0

    init() {
        source = CGEventSource(stateID: .hidSystemState)
        source?.userData = Self.userData

        let cid = CGSMainConnectionID()
        if CGSSetConnectionProperty(cid, cid, "SetsCursorInBackground" as CFString, kCFBooleanTrue) != 0 {
            NSLog("fremkit: could not enable background cursor hiding; the cursor will stay visible on the panel")
        }
    }

    deinit {
        showCursorIfHidden()
    }

    /// Hides the cursor for the duration of a gesture: the page hides it in CSS, but WebKit only
    /// applies the CSS cursor on a real mouse move, so a warped-in pointer shows the arrow.
    private func hideCursor() {
        lock.lock()
        let alreadyHidden = cursorHidden
        cursorHidden = true
        lock.unlock()
        guard !alreadyHidden else { return }
        CGDisplayHideCursor(CGMainDisplayID())
    }

    private func showCursorIfHidden() {
        lock.lock()
        let wasHidden = cursorHidden
        cursorHidden = false
        lock.unlock()
        guard wasHidden else { return }
        CGDisplayShowCursor(CGMainDisplayID())
    }

    func perform(_ action: PointerAction) {
        switch action {
        case let .move(point):
            warp(to: point)
            post(.mouseMoved, at: point, button: .left)

        case let .mouseDown(point):
            post(.leftMouseDown, at: point, button: .left)

        case let .mouseUp(point):
            post(.leftMouseUp, at: point, button: .left)

        case let .drag(point):
            warp(to: point)
            post(.leftMouseDragged, at: point, button: .left)

        case let .doubleClick(point):
            // The engine already posted a full click for the first tap, so this completes
            // the pair: a single down/up carrying clickState 2.
            warp(to: point)
            post(.leftMouseDown, at: point, button: .left, clickState: 2)
            post(.leftMouseUp, at: point, button: .left, clickState: 2)

        case let .rightClick(point):
            warp(to: point)
            post(.rightMouseDown, at: point, button: .right)
            post(.rightMouseUp, at: point, button: .right)

        case let .scroll(dx, dy, at):
            postScroll(dx: dx, dy: dy, at: at)

        case .restoreCursor:
            restoreCursor()
        }
    }

    // MARK: - Cursor bookkeeping

    /// Moves the cursor, remembering where it was at the start of the gesture.
    private func warp(to point: CGPoint) {
        // A tap within `restoreDelay` of the previous gesture would otherwise be teleported
        // away mid-gesture by the restore still queued from that previous gesture.
        let current = Self.currentCursor()
        lock.lock()
        pendingRestore?.cancel()
        pendingRestore = nil
        // A restore already running cannot be cancelled; this is what makes it stand down.
        gesture &+= 1
        if savedCursor == nil { savedCursor = current }
        lock.unlock()

        hideCursor()
        warpCursor(to: point)
    }

    /// Schedules the cursor to go back where the user left it.
    ///
    /// `savedCursor` is deliberately kept until the restore actually runs: a new gesture starting
    /// inside `restoreDelay` cancels this work item, and clearing it early would make that gesture
    /// capture its own on-Edge position as the "original" one, so the pointer would stay there.
    private func restoreCursor() {
        lock.lock()
        guard savedCursor != nil else { lock.unlock(); return }
        pendingRestore?.cancel()
        let stamp = gesture
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            // A new gesture started while this was queued or already running: leave the cursor
            // where that gesture put it, and leave it hidden for the gesture's duration.
            guard stamp == self.gesture else { self.lock.unlock(); return }
            let saved = self.savedCursor
            self.savedCursor = nil
            self.pendingRestore = nil
            self.lock.unlock()
            guard let saved else { return }
            warpCursor(to: saved)
            self.showCursorIfHidden()
        }
        pendingRestore = work
        lock.unlock()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.restoreDelay, execute: work)
    }

    private static func currentCursor() -> CGPoint? {
        CGEvent(source: nil)?.location
    }

    // MARK: - Event posting

    private func post(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, clickState: Int64? = nil) {
        guard let event = CGEvent(mouseEventSource: source,
                                  mouseType: type,
                                  mouseCursorPosition: point,
                                  mouseButton: button)
        else { return }
        if let clickState { event.setIntegerValueField(.mouseEventClickState, value: clickState) }
        event.post(tap: .cghidEventTap)
    }

    /// Posts a pixel scroll for a finger displacement of `(dx, dy)` in global coordinates.
    ///
    /// Sign convention: `scrollWheelEvent2` follows the classic wheel, where a positive
    /// `wheel1` is a wheel roll away from the user, which moves the content down the screen
    /// (the viewport travels toward the top of the document). Global coordinates grow
    /// downward, so a finger sliding down gives `dy > 0`; passing it through unchanged makes
    /// the content follow the finger, i.e. macOS "natural" scrolling. The same reasoning
    /// applies horizontally: a finger sliding right gives `dx > 0` and drags the content right.
    /// `scrollInvert` flips both axes for users who expect the opposite convention.
    private func postScroll(dx: Double, dy: Double, at point: CGPoint) {
        // A scroll event posted at `.cghidEventTap` is delivered to the window under the *real*
        // cursor, whatever `event.location` says, so the cursor has to be moved onto the Edge
        // first or the gesture scrolls whatever sits under the mouse on the primary display.
        // Warping here also captures `savedCursor`, so the `.restoreCursor` the engine emits at
        // the end of the gesture puts the pointer back.
        warp(to: point)

        let sign: Double = scrollInvert ? -1 : 1
        guard let event = CGEvent(scrollWheelEvent2Source: source,
                                  units: .pixel,
                                  wheelCount: 2,
                                  wheel1: Int32(clamping: Int((sign * dy).rounded())),
                                  wheel2: Int32(clamping: Int((sign * dx).rounded())),
                                  wheel3: 0)
        else { return }
        event.location = point
        event.post(tap: .cghidEventTap)
    }
}

/// Poster used by `--probe`: prints the recognised actions instead of posting events.
final class PrintPoster: PointerPoster {
    func perform(_ action: PointerAction) {
        print("action: \(describe(action))")
    }

    private func describe(_ action: PointerAction) -> String {
        switch action {
        case let .move(p): return "move(\(fmt(p)))"
        case let .mouseDown(p): return "mouseDown(\(fmt(p)))"
        case let .mouseUp(p): return "mouseUp(\(fmt(p)))"
        case let .drag(p): return "drag(\(fmt(p)))"
        case let .doubleClick(p): return "doubleClick(\(fmt(p)))"
        case let .rightClick(p): return "rightClick(\(fmt(p)))"
        case let .scroll(dx, dy, at): return "scroll(dx: \(round(dx)), dy: \(round(dy)), at: \(fmt(at)))"
        case .restoreCursor: return "restoreCursor"
        }
    }

    private func fmt(_ p: CGPoint) -> String {
        "\(Int(p.x.rounded())), \(Int(p.y.rounded()))"
    }
}
