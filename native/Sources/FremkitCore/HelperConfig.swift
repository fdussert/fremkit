import Foundation

/// Persisted settings of the helper, stored as JSON in Application Support.
public struct HelperConfig: Codable, Equatable {
    public struct DisplaySize: Codable, Equatable {
        public var width: Int
        public var height: Int

        public init(width: Int, height: Int) {
            self.width = width
            self.height = height
        }
    }

    public var repoPath: String
    public var url: String
    public var adminUrl: String
    public var port: Int
    public var display: DisplaySize
    public var touch: Bool
    public var fence: Bool
    public var manageServer: Bool
    public var launchAtLogin: Bool
    /// Flips the scroll direction of the touch panel, so the user can change it without a rebuild.
    public var scrollInvert: Bool
    /// Reads the Dock's badges and posts them to the server. Needs Accessibility.
    public var dock: Bool

    public init(repoPath: String,
                url: String,
                adminUrl: String,
                port: Int,
                display: DisplaySize,
                touch: Bool,
                fence: Bool,
                manageServer: Bool,
                launchAtLogin: Bool,
                scrollInvert: Bool = false,
                dock: Bool = true) {
        self.repoPath = repoPath
        self.url = url
        self.adminUrl = adminUrl
        self.port = port
        self.display = display
        self.touch = touch
        self.fence = fence
        self.manageServer = manageServer
        self.launchAtLogin = launchAtLogin
        self.scrollInvert = scrollInvert
        self.dock = dock
    }

    /// Where the checkout is expected when nothing says otherwise. There is no way to guess it
    /// from inside an installed bundle, so `scripts/setup.sh` writes the real path into
    /// `helper.json` at install time and this is only the fallback for a hand-made config.
    public static let defaultRepoPath = NSHomeDirectory() + "/fremkit"

    public static let `default` = HelperConfig(
        repoPath: defaultRepoPath,
        url: "http://127.0.0.1:4242/?kiosk=1",
        adminUrl: "http://127.0.0.1:4242/admin",
        port: 4242,
        display: DisplaySize(width: 2560, height: 720),
        touch: true,
        fence: true,
        manageServer: true,
        launchAtLogin: false,
        scrollInvert: false,
        dock: true
    )

    /// `~/Library/Application Support/Fremkit/helper.json`.
    public static var defaultURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Fremkit/helper.json")
    }

    /// Every field optional, so a partial or older file still decodes.
    private struct Partial: Decodable {
        struct PartialDisplay: Decodable {
            var width: Int?
            var height: Int?
        }

        var repoPath: String?
        var url: String?
        var adminUrl: String?
        var port: Int?
        var display: PartialDisplay?
        var touch: Bool?
        var fence: Bool?
        var manageServer: Bool?
        var launchAtLogin: Bool?
        var scrollInvert: Bool?
        var dock: Bool?
    }

    /// Reads the config, falling back to `default` for a missing, corrupt or partial file.
    public static func load(from url: URL) -> HelperConfig {
        guard let data = try? Data(contentsOf: url),
              let partial = try? JSONDecoder().decode(Partial.self, from: data)
        else { return .default }

        var config = HelperConfig.default
        if let v = partial.repoPath { config.repoPath = v }
        if let v = partial.url { config.url = v }
        if let v = partial.adminUrl { config.adminUrl = v }
        if let v = partial.port { config.port = v }
        if let v = partial.display?.width { config.display.width = v }
        if let v = partial.display?.height { config.display.height = v }
        if let v = partial.touch { config.touch = v }
        if let v = partial.fence { config.fence = v }
        if let v = partial.manageServer { config.manageServer = v }
        if let v = partial.launchAtLogin { config.launchAtLogin = v }
        if let v = partial.scrollInvert { config.scrollInvert = v }
        if let v = partial.dock { config.dock = v }
        return config
    }

    /// Writes pretty JSON atomically: temporary file in the same directory, then rename.
    public func save(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(self)

        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        try data.write(to: temporary)
        do {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }
}
