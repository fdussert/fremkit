import Foundation

/// One Dock item as the accessibility API handed it over, before any interpretation.
///
/// Deliberately free of AX and AppKit types: reading the Dock is the helper's job, deciding what
/// the values mean is this module's, and only the second half is testable without a Dock.
public struct RawDockItem: Equatable {
    public var title: String?
    /// `AXStatusLabel`: the badge text, absent when the app shows none.
    public var statusLabel: String?
    public var isRunning: Bool
    public var bundleIdentifier: String?

    public init(title: String?, statusLabel: String?, isRunning: Bool, bundleIdentifier: String?) {
        self.title = title
        self.statusLabel = statusLabel
        self.isRunning = isRunning
        self.bundleIdentifier = bundleIdentifier
    }
}

/// One app of the Dock, as the server receives it.
public struct DockApp: Equatable, Encodable {
    public var bundleId: String
    public var name: String
    public var badge: String?
    public var running: Bool

    public init(bundleId: String, name: String, badge: String?, running: Bool) {
        self.bundleId = bundleId
        self.name = name
        self.badge = badge
        self.running = running
    }
}

public enum DockBadgeParser {
    /// Turns raw Dock items into apps, keeping the Dock's own order.
    ///
    /// Items without a bundle identifier are dropped: separators, stacks, the Trash and minimised
    /// windows are not apps the dashboard can activate. A bundle that appears twice keeps its
    /// first entry, which is the one the Dock draws the badge on.
    public static func parse(_ items: [RawDockItem]) -> [DockApp] {
        var seen = Set<String>()
        var apps: [DockApp] = []
        for item in items {
            guard let bundleId = item.bundleIdentifier, !bundleId.isEmpty, !seen.contains(bundleId) else { continue }
            seen.insert(bundleId)
            let trimmed = item.statusLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
            apps.append(DockApp(
                bundleId: bundleId,
                name: item.title?.isEmpty == false ? item.title! : bundleId,
                badge: (trimmed?.isEmpty == false) ? trimmed : nil,
                running: item.isRunning
            ))
        }
        return apps
    }

    /// What is worth a POST: the identity, the badge and the running flag of each app, in order.
    /// The display name is left out, so renaming an app does not wake the server up.
    ///
    /// An unchanged signature only suppresses the *extra* reports: the helper still sends one
    /// every four seconds as a heartbeat, because the server drops the Dock to unavailable after
    /// ten seconds of silence and a quiet Dock is not a missing helper.
    public static func signature(_ apps: [DockApp]) -> String {
        apps.map { "\($0.bundleId)|\($0.badge ?? "")|\($0.running ? "1" : "0")" }.joined(separator: "\n")
    }
}
