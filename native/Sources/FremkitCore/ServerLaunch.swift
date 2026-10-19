import Foundation

/// How the helper runs the dashboard server: from a checkout, or from inside the app bundle.
///
/// A `repoPath` in `helper.json` always means the checkout, exactly as before the app existed:
/// that is the developer setup (`pnpm run setup` writes it), and it must not move when the same
/// helper code learns to run a bundled server. Without one, the server shipped in the bundle's
/// `Contents/Resources/server` is used when it is there. Neither means the old fallback checkout,
/// `~/fremkit`, which the spawn then reports as missing.
public enum ServerLaunch: Equatable {
    /// `node <repo>/server/node_modules/tsx/dist/cli.mjs src/index.ts`, run from `<repo>/server`.
    case checkout(repoPath: String)
    /// `<resources>/server/fremkit-server`: Node and the bundled server in one executable.
    case bundled(resourcesPath: String)

    /// The bundled server's executable, relative to `Contents/Resources`. `scripts/build-app.sh`
    /// puts it there.
    public static let bundledExecutable = "server/fremkit-server"

    public static func decide(repoPath: String?,
                              resourcesPath: String?,
                              fileExists: (String) -> Bool) -> ServerLaunch {
        if let repoPath, !repoPath.isEmpty {
            return .checkout(repoPath: repoPath)
        }
        if let resourcesPath, !resourcesPath.isEmpty,
           fileExists(resourcesPath + "/" + bundledExecutable) {
            return .bundled(resourcesPath: resourcesPath)
        }
        return .checkout(repoPath: HelperConfig.defaultRepoPath)
    }

    /**
     Whether a running process is the server this launch starts. It guards the kill of an orphan
     named by a stale pid file: pids are recycled, and the pid may belong to anything by now.

     A checkout's child is `node …/tsx/… src/index.ts` from the repo, so its `commandLine` (as
     `ps -o command=` prints it) must carry both the repo path and the entry point; either alone
     matches far too much. A bundled child is the bundle's own executable, so its
     `executablePath` — the kernel's, from `proc_pidpath`, with symlinks resolved — must be that
     file exactly. `resourcesPath` has to be resolved the same way for the comparison to hold
     (`/tmp` is `/private/tmp`, and `ps` prints whichever spelling the process was started with).
     An empty path never matches: `contains("")` is true for everything.
     */
    public func isOwnServer(commandLine: String, executablePath: String?) -> Bool {
        switch self {
        case let .checkout(repoPath):
            guard !repoPath.isEmpty else { return false }
            return commandLine.contains(repoPath) && commandLine.contains("src/index.ts")
        case let .bundled(resourcesPath):
            guard !resourcesPath.isEmpty, let executablePath else { return false }
            return executablePath == resourcesPath + "/" + Self.bundledExecutable
        }
    }

    /**
     The child's environment, built from the helper's own.

     A login item inherits a bare `PATH`, so the usual Homebrew places are added: the server runs
     tools such as `ffmpeg` from there. They come *after* the system's folders, which always lead.
     The checkout also gets its `node_modules/.bin`.

     The bundled server is told where it is (`FREMKIT_ROOT`) and where the user's data lives
     (`FREMKIT_DATA_DIR`), since it has no checkout to find a `data/` folder in. `NODE_OPTIONS` is
     dropped for it: a user's `--require` or `--inspect` meant for their own Node has no business
     in the app's.

     `scanner` is the disk map's `fremkit-scan`, which ships beside the helper's executable in
     both setups. The server runs it by this absolute path, and falls back to `du` without it;
     nothing goes on `PATH`.

     `accessToken` is the local access secret (`AccessToken`) the helper made for this child; every
     spawn gets a new one. One inherited from the helper's own environment is never passed on:
     the server would take it, and it is not the one the helper presents.
     */
    public func environment(inheriting base: [String: String],
                            port: Int,
                            dataDirectory: String,
                            home: String,
                            scanner: String? = nil,
                            accessToken: String? = nil) -> [String: String] {
        var environment = base
        environment.removeValue(forKey: AccessToken.environmentKey)
        if let accessToken, AccessToken.isWellFormed(accessToken) {
            environment[AccessToken.environmentKey] = accessToken
        }
        // The system's folders first, so a bare-name tool is always Apple's: whoever can write the
        // Homebrew prefix must not be able to plant an `open` or an `osascript` that then runs
        // with the helper's privacy grants. The server orders its own PATH the same way.
        let system = "/usr/bin:/bin:/usr/sbin:/sbin"
        let inherited = (base["PATH"] ?? "").split(separator: ":").map(String.init)
            .filter { $0.hasPrefix("/") && !system.split(separator: ":").map(String.init).contains($0) }
            .joined(separator: ":")
        let tail = inherited.isEmpty ? "" : ":\(inherited)"
        let homebrew = "/opt/homebrew/bin:/usr/local/bin"
        environment["FREMKIT_PORT"] = String(port)
        if let scanner, !scanner.isEmpty {
            environment["FREMKIT_SCANNER"] = scanner
        }
        switch self {
        case let .checkout(repoPath):
            environment["PATH"] = "\(system):\(repoPath)/server/node_modules/.bin:\(homebrew):\(home)/Library/pnpm\(tail)"
        case let .bundled(resourcesPath):
            environment["PATH"] = "\(system):\(homebrew)\(tail)"
            environment["FREMKIT_ROOT"] = resourcesPath
            environment["FREMKIT_DATA_DIR"] = dataDirectory
            environment.removeValue(forKey: "NODE_OPTIONS")
        }
        return environment
    }
}
