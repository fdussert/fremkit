import Foundation

/// What macOS says about one privacy grant, as `IOHIDCheckAccess` reports it.
public enum PermissionStatus: Equatable {
    case granted
    case denied
    /// Never asked, or asked and not answered yet.
    case unknown
}

/// The order in which the helper raises its privacy prompts at launch.
///
/// macOS shows one TCC prompt at a time: asking for Accessibility while the Input Monitoring
/// request is still on its way loses the second one, which then never registers — the app is not
/// even listed under Input Monitoring. So when touch needs Input Monitoring and it has not been
/// answered yet, it is asked alone, and Accessibility only once that answer is in (or after
/// `timeout`, so a lost or ignored prompt never holds Accessibility back for good).
///
/// The touch driver is started at the same moment Accessibility is asked: opening the HID manager
/// before Input Monitoring is answered could raise an implicit request of its own.
///
/// Pure: the caller feeds it the current status and the time, and performs the actions.
public struct PermissionSequencer {
    public enum Action: Equatable {
        case requestInputMonitoring
        case requestAccessibility
        case startTouch
    }

    /// How long Accessibility waits for the Input Monitoring answer.
    public static let defaultTimeout: TimeInterval = 60

    private enum Phase: Equatable {
        case idle
        case awaitingInputMonitoring(since: TimeInterval)
        case done
    }

    private let touch: Bool
    private let wantsAccessibility: Bool
    private let timeout: TimeInterval
    private var phase: Phase = .idle

    /// `touch`, `fence` and `dock` are the config flags at launch. A helper with all three off
    /// asks for nothing: a copy run beside the installed one for testing, typically, whose answer
    /// would count for the bundle id both share.
    public init(touch: Bool, fence: Bool, dock: Bool, timeout: TimeInterval = PermissionSequencer.defaultTimeout) {
        self.touch = touch
        self.wantsAccessibility = touch || fence || dock
        self.timeout = timeout
    }

    /// True while Accessibility is held back for the Input Monitoring answer.
    public var isWaiting: Bool {
        if case .awaitingInputMonitoring = phase { return true }
        return false
    }

    /// The first actions, at launch. Called once; later calls return nothing.
    public mutating func begin(inputMonitoring: PermissionStatus, now: TimeInterval) -> [Action] {
        guard phase == .idle else { return [] }
        if touch && inputMonitoring == .unknown {
            phase = .awaitingInputMonitoring(since: now)
            return [.requestInputMonitoring]
        }
        return finish()
    }

    /// Called periodically while `isWaiting`; returns the remaining actions once the wait is over.
    public mutating func poll(inputMonitoring: PermissionStatus, now: TimeInterval) -> [Action] {
        guard case let .awaitingInputMonitoring(since) = phase else { return [] }
        guard inputMonitoring != .unknown || now - since >= timeout else { return [] }
        return finish()
    }

    private mutating func finish() -> [Action] {
        phase = .done
        var actions: [Action] = []
        if touch { actions.append(.startTouch) }
        if wantsAccessibility { actions.append(.requestAccessibility) }
        return actions
    }
}
