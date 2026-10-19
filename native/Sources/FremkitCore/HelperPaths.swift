import Foundation

/// Where the helper keeps its own files, and where the app keeps the user's data.
///
/// `~/Library/Application Support/Fremkit` holds `helper.json`, `server.pid` and — for the app,
/// which has no checkout to put a `data/` folder in — the dashboard's data itself. The logs go to
/// `~/Library/Logs/Fremkit`.
///
/// `FREMKIT_SUPPORT_DIR` moves all of it, logs included, to another absolute directory. It exists
/// so a second copy of the helper can be run beside the installed one — a build under test on
/// another port — without reading the installed one's config, killing its server through the pid
/// file or writing into its log. A relative or empty value is ignored.
public enum HelperPaths {
    public static let supportOverride = "FREMKIT_SUPPORT_DIR"

    public static func supportDirectory(environment: [String: String] = ProcessInfo.processInfo.environment,
                                        home: String = NSHomeDirectory()) -> URL {
        if let override = overridden(environment) { return override }
        return URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/Fremkit")
    }

    public static func logDirectory(environment: [String: String] = ProcessInfo.processInfo.environment,
                                    home: String = NSHomeDirectory()) -> URL {
        if let override = overridden(environment) { return override.appendingPathComponent("Logs") }
        return URL(fileURLWithPath: home).appendingPathComponent("Library/Logs/Fremkit")
    }

    private static func overridden(_ environment: [String: String]) -> URL? {
        guard let value = environment[supportOverride], value.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: value)
    }
}
