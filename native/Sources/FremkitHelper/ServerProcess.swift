import Darwin
import Foundation
import FremkitCore

/// What the dashboard server is doing, as shown in the status menu.
enum ServerState: Equatable {
    /// The port already answered at startup: someone else's `pnpm dev` owns the server.
    case external
    /// Something that is not our server holds the port: it could not prove it holds the secret
    /// (`AccessProof`). Nothing is sent to it and nothing it serves is shown; the helper keeps
    /// watching and starts its own server once the port is free.
    case foreign(Int)
    /// A child process has been spawned but has not answered `/api/config` yet.
    case starting
    /// The child process is up and serving.
    case running
    /// Nothing is running and nothing is scheduled.
    case stopped
    /// The child died; a relaunch is scheduled in this many seconds.
    case restarting(Int)

    /// Menu label, in the language the helper picked at launch.
    var label: String {
        switch self {
        case .external: return L10n.string(.serverExternal)
        case let .foreign(port): return L10n.string(.serverForeign, port)
        case .starting: return L10n.string(.serverStarting)
        case .running: return L10n.string(.serverRunning)
        case .stopped: return L10n.string(.serverStopped)
        case let .restarting(seconds): return L10n.string(.serverRestarting, seconds)
        }
    }
}

/// Supervises the dashboard server — the checkout's under tsx, or the one bundled in the app (see
/// `ServerLaunch`) — or steps aside when the port is already taken.
///
/// All mutable state is touched on the main thread only: the probe and the termination handler hop
/// back before changing anything.
final class ServerProcess {
    /// Backoff schedule between relaunches, in seconds; the last value repeats.
    private static let backoff: [Int] = [2, 4, 8, 16, 30]
    /// A child that stayed up this long is considered healthy and resets the backoff.
    private static let healthyAfter: TimeInterval = 60
    /// How long a probe waits before deciding the port is dead.
    private static let probeTimeout: TimeInterval = 1
    /// Grace period between SIGTERM and SIGKILL.
    private static let killAfter: TimeInterval = 3
    /// Delay between two readiness probes.
    private static let readyInterval: TimeInterval = 1
    /// How long `start()` waits for a previous child to actually die.
    private static let quietTimeout: TimeInterval = 4

    private let config: HelperConfig
    /// The access secret this helper hands its servers and presents to whichever one answers.
    private let access: ServerAccess
    /// Checkout or bundle, decided once at launch from `repoPath` and what the bundle carries.
    let launch: ServerLaunch
    private let probeQueue = DispatchQueue(label: "dev.fremkit.helper.server.probe")

    /// The child we currently supervise. Cleared the moment we ask it to die, so a rapid
    /// stop/start cannot confuse the new child with the old one.
    private var process: Process?
    /// Children that were signalled and have not reported their exit yet. Holding the `Process`
    /// keeps the termination handler alive and lets `start()` wait for a clean slate.
    private var terminating: [Process] = []
    private var logHandle: FileHandle?
    /// True while the helper is responsible for the process; false disables relaunching.
    private var managed = false
    private var backoffIndex = 0
    private var startedAt: Date?
    private var restartWork: DispatchWorkItem?
    /// Set once a probe found someone else on the port — a server of ours we did not start, or a
    /// foreign listener. While it is set we keep probing: if it goes away (a `pnpm dev` stopped, a
    /// previous helper's child that was still dying when we probed), we take over and spawn our own.
    private var isExternal = false
    /// What stands on the port while `isExternal` is set: `.external` or `.foreign`.
    private var asideState: ServerState = .external
    private var externalWatch: DispatchWorkItem?
    private var healthWatch: DispatchWorkItem?
    private var healthMisses = 0
    private static let healthInterval: TimeInterval = 10
    private static let healthMissesBeforeRestart = 3
    /// Consecutive failed probes of an external server before we take the port over.
    private var externalMisses = 0
    private static let externalWatchInterval: TimeInterval = 5
    private static let externalMissesBeforeTakeover = 2

    /// Called on the main thread on every state change.
    var onStateChange: ((ServerState) -> Void)?

    private(set) var state: ServerState = .stopped {
        didSet {
            guard state != oldValue else { return }
            let current = state
            DispatchQueue.main.async { [weak self] in self?.onStateChange?(current) }
        }
    }

    init(config: HelperConfig, access: ServerAccess) {
        self.config = config
        self.access = access
        // Resolved like proc_pidpath resolves the child's executable, for the orphan guard.
        let resources = Bundle.main.resourcePath.map(Self.realPath)
        launch = ServerLaunch.decide(repoPath: config.repoPath, resourcesPath: resources) {
            FileManager.default.isExecutableFile(atPath: $0)
        }
    }

    /// `~/Library/Logs/Fremkit/server.log`, rolled over by `openLog`.
    static var logURL: URL {
        HelperPaths.logDirectory().appendingPathComponent("server.log")
    }

    /// `~/Library/Application Support/Fremkit/server.pid`, holding the pid of the live child.
    static var pidURL: URL {
        HelperConfig.defaultURL.deletingLastPathComponent().appendingPathComponent("server.pid")
    }

    // MARK: - Managed flag

    /// Turns supervision on or off; this is what the "Manage the server" menu item drives.
    func setManaged(_ enabled: Bool) {
        guard managed != enabled else { return }
        if enabled {
            start()
        } else {
            stop()
        }
    }

    var isManaged: Bool { managed }

    // MARK: - Lifecycle

    /// Waits for any dying child, probes the port, then either steps aside or spawns the server.
    func start() {
        guard !managed else { return }
        managed = true

        // Probing while our own previous child is still shutting down would see the port answer
        // and wrongly declare an external server, so settle first.
        waitForQuiet(deadline: Date().addingTimeInterval(Self.quietTimeout)) { [weak self] in
            guard let self, self.managed else { return }
            self.probe { [weak self] verdict in
                guard let self, self.managed else { return }
                if verdict != .absent {
                    self.standAside(verdict)
                    return
                }
                self.isExternal = false
                self.spawn()
            }
        }
    }

    /// Something else holds the port: our server under someone else's hand, or a foreign listener.
    private func standAside(_ verdict: AccessProof.Verdict) {
        access.forgetSpawn()
        isExternal = true
        noteAside(verdict)
        watchExternal()
    }

    private func noteAside(_ verdict: AccessProof.Verdict) {
        if verdict == .foreign {
            NSLog("fremkit: port %d is held by a listener that cannot prove it is our server", config.port)
        }
        asideState = verdict == .foreign ? .foreign(config.port) : .external
        state = asideState
    }

    /// Keeps probing what holds the port; after two consecutive misses (~10 s) we spawn our own.
    /// A listener that proves itself later (a `pnpm dev` that had not written its token file yet)
    /// moves from foreign to external, and the other way round.
    private func watchExternal() {
        externalWatch?.cancel()
        externalMisses = 0
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.managed, self.isExternal else { return }
            self.probe { [weak self] verdict in
                guard let self, self.managed, self.isExternal else { return }
                if verdict != .absent {
                    self.externalMisses = 0
                    self.noteAside(verdict)
                } else {
                    self.externalMisses += 1
                    if self.externalMisses >= Self.externalMissesBeforeTakeover {
                        NSLog("fremkit: external server on port %d is gone; starting our own", self.config.port)
                        self.isExternal = false
                        self.externalWatch = nil
                        self.spawn()
                        return
                    }
                }
                self.watchExternal()
            }
        }
        externalWatch = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.externalWatchInterval, execute: work)
    }

    /// Stops supervising: cancels any pending relaunch and takes the whole process tree down.
    func stop() {
        managed = false
        Self.removePidFile()
        access.forgetSpawn()
        restartWork?.cancel()
        restartWork = nil
        externalWatch?.cancel()
        externalWatch = nil
        healthWatch?.cancel()
        healthWatch = nil
        startedAt = nil

        guard let child = process, child.isRunning else {
            process = nil
            closeLog()
            state = isExternal ? asideState : .stopped
            return
        }

        // Forget the child immediately: from here on it is only a corpse to be disposed of, and a
        // start() arriving right behind must not mistake it for the live one.
        process = nil
        closeLog()
        terminating.append(child)

        let pid = child.processIdentifier
        Self.killTree(pid, signal: SIGTERM)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.killAfter) { [weak self] in
            if child.isRunning { Self.killTree(pid, signal: SIGKILL) }
            self?.verifyPortReleased()
        }
        state = .stopped
    }

    /// Like `stop()`, but blocks the caller for up to `timeout`, polling every 100 ms, so a
    /// caller such as `applicationWillTerminate` can let the existing SIGKILL escalation run its
    /// course before the app itself disappears. A quit latency of up to `timeout` is accepted.
    func stopAndWait(timeout: TimeInterval) {
        managed = false
        Self.removePidFile()
        access.forgetSpawn()
        restartWork?.cancel()
        restartWork = nil
        externalWatch?.cancel()
        externalWatch = nil
        healthWatch?.cancel()
        healthWatch = nil
        startedAt = nil

        guard let child = process, child.isRunning else {
            process = nil
            closeLog()
            state = isExternal ? asideState : .stopped
            return
        }

        process = nil
        closeLog()

        let pid = child.processIdentifier
        Self.killTree(pid, signal: SIGTERM)

        let deadline = Date().addingTimeInterval(timeout)
        while child.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }

        if child.isRunning { Self.killTree(pid, signal: SIGKILL) }
        state = .stopped
    }

    /// Polls until every signalled child has exited, or until `deadline`.
    private func waitForQuiet(deadline: Date, _ done: @escaping () -> Void) {
        terminating.removeAll { !$0.isRunning }
        guard !terminating.isEmpty, Date() < deadline else {
            done()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self else { return }
            self.waitForQuiet(deadline: deadline, done)
        }
    }

    /// After a stop, checks the port really went quiet; a survivor means the tree kill missed one.
    private func verifyPortReleased() {
        let port = config.port
        probe { verdict in
            guard verdict != .absent else { return }
            NSLog("fremkit: something still answers port %d after stopping the server", port)
        }
    }

    // MARK: - Process tree

    /// Sends `signal` to every descendant of `pid`, deepest first, then to `pid` itself.
    ///
    /// `pnpm --filter server start` is a wrapper around pnpm around node: signalling only the direct
    /// child leaves the node process holding the port. Children go first so the parent cannot
    /// outlive them and orphan the tree.
    static func killTree(_ pid: pid_t, signal: Int32) {
        for descendant in descendants(of: pid).reversed() {
            kill(descendant, signal)
        }
        kill(pid, signal)
    }

    /// Breadth-first list of every descendant of `pid`, nearest generation first.
    private static func descendants(of pid: pid_t) -> [pid_t] {
        var found: [pid_t] = []
        var frontier: [pid_t] = [pid]
        // A pid table that loops (it should not) must not hang the main thread.
        var visited: Set<pid_t> = [pid]
        var rounds = 0

        while !frontier.isEmpty, rounds < 16 {
            rounds += 1
            var next: [pid_t] = []
            for parent in frontier {
                for child in childPids(of: parent) where !visited.contains(child) {
                    visited.insert(child)
                    found.append(child)
                    next.append(child)
                }
            }
            frontier = next
        }
        return found
    }

    /// Direct children of `pid`, via `pgrep -P`. Returns nothing when pgrep fails or finds none.
    private static func childPids(of pid: pid_t) -> [pid_t] {
        let pgrep = Process()
        pgrep.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        pgrep.arguments = ["-P", String(pid)]
        let pipe = Pipe()
        pgrep.standardOutput = pipe
        pgrep.standardError = FileHandle.nullDevice

        do {
            try pgrep.run()
        } catch {
            return []
        }
        // pgrep prints at most a handful of pids, so the pipe cannot fill and deadlock the read.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        pgrep.waitUntilExit()

        return String(decoding: data, as: UTF8.self)
            .split(whereSeparator: { $0.isNewline || $0 == " " })
            .compactMap { pid_t($0) }
            .filter { $0 > 1 }
    }

    // MARK: - Probe

    /// Asks the listener on the configured port to prove it is our server (see `AccessProof` and
    /// `ServerAccess.probe`); `done` is called on the main thread. No credential is sent: a
    /// listener that cannot answer is `.foreign`, and is never handed the secret.
    func probe(_ done: @escaping (AccessProof.Verdict) -> Void) {
        access.probe(timeout: Self.probeTimeout, queue: probeQueue, done)
    }

    // MARK: - Spawning

    private func spawn() {
        let process = Process()
        switch launch {
        case let .checkout(repoPath):
            guard configureCheckout(process, repoPath: repoPath) else { return }
        case let .bundled(resourcesPath):
            // Nothing to look for: decide() only picks this when the executable is there.
            process.executableURL = URL(fileURLWithPath: resourcesPath)
                .appendingPathComponent(ServerLaunch.bundledExecutable)
            process.arguments = []
            process.currentDirectoryURL = URL(fileURLWithPath: resourcesPath)
        }
        process.environment = launch.environment(
            inheriting: ProcessInfo.processInfo.environment,
            port: config.port,
            dataDirectory: HelperPaths.supportDirectory().path,
            home: NSHomeDirectory(),
            scanner: Self.diskScanner(),
            accessToken: access.newSpawnToken())

        // The handle has to exist before run(), so a failed launch closes it again rather than
        // leaking a descriptor on every retry of the backoff loop.
        let handle = Self.openLog()
        if let handle {
            process.standardOutput = handle
            process.standardError = handle
        }

        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { self?.childDidExit(finished) }
        }

        do {
            try process.run()
        } catch {
            try? handle?.close()
            access.forgetSpawn()
            NSLog("fremkit: cannot start server: %@", String(describing: error))
            scheduleRestart()
            return
        }

        logHandle = handle
        self.process = process
        startedAt = Date()
        state = .starting
        Self.writePidFile(process.processIdentifier)
        pollReady()
    }

    /// Points `process` at `node tsx src/index.ts` in the checkout, or says why it cannot and
    /// returns false.
    private func configureCheckout(_ process: Process, repoPath: String) -> Bool {
        let server = URL(fileURLWithPath: repoPath).appendingPathComponent("server")
        let entry = server.appendingPathComponent("src/index.ts")
        // A repoPath that is not a checkout — never configured, renamed, on an unmounted volume —
        // used to be spawned anyway, failing once a second for ever behind the backoff. Say so
        // once and stop instead.
        guard FileManager.default.fileExists(atPath: entry.path) else {
            NSLog("fremkit: no server/src/index.ts under repoPath; not starting a server. "
                + "Fix repoPath in helper.json and relaunch the helper — this does not retry on its own.")
            state = .stopped
            return false
        }
        let tsx = server.appendingPathComponent("node_modules/tsx/dist/cli.mjs")
        guard FileManager.default.fileExists(atPath: tsx.path) else {
            NSLog("fremkit: tsx is not installed in the checkout; run pnpm install, then relaunch "
                + "the helper — this does not retry on its own.")
            state = .stopped
            return false
        }
        guard let node = Self.resolveNode() else {
            NSLog("fremkit: no node executable found; install Node 22 or later, then relaunch the "
                + "helper — this does not retry on its own.")
            state = .stopped
            return false
        }

        // Run the server itself, not a pnpm wrapper around it: the supervised process must be
        // the one that binds the port, so its death (or a stray kill) is what we observe. node and
        // tsx are named by absolute path rather than looked up through `env` and PATH, so a login
        // item's environment cannot decide which interpreter runs the dashboard.
        process.executableURL = node
        process.arguments = [tsx.path, "src/index.ts"]
        process.currentDirectoryURL = server
        return true
    }

    /// Asks the port whether the fresh child is serving yet, once a second.
    ///
    /// `pnpm start` reports nothing on readiness, and mere survival is not proof that it bound the
    /// port, so the answer has to come from an HTTP round trip. There is no deadline: polling
    /// stops when the child dies (the termination handler takes over) or when the answer arrives,
    /// because a menu stuck on "starting…" for a server that is in fact serving is worse than a
    /// probe that keeps asking. A child that outlives `healthyAfter` without ever answering is
    /// reported as running anyway: it clearly did not crash, and the probe is what is wrong.
    private func pollReady() {
        guard managed, state == .starting, let child = process, child.isRunning else { return }

        probe { [weak self] verdict in
            guard let self, self.managed, self.state == .starting,
                  let running = self.process, running === child, running.isRunning else { return }
            if verdict == .ours {
                self.state = .running
                self.watchHealth(child)
                return
            }
            if let startedAt = self.startedAt,
               Date().timeIntervalSince(startedAt) >= Self.healthyAfter {
                NSLog("fremkit: server child alive for %.0f s but never proved itself on /auth/proof; reporting it as running",
                      Self.healthyAfter)
                self.state = .running
                self.watchHealth(child)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.readyInterval) { [weak self] in
                self?.pollReady()
            }
        }
    }

    /// Keeps probing a running child; a child that stays alive but stops answering (its real
    /// server died underneath it, or it wedged) is killed so the normal restart path runs.
    private func watchHealth(_ child: Process) {
        healthWatch?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.managed, self.state == .running,
                  let running = self.process, running === child, running.isRunning else { return }
            self.probe { [weak self] verdict in
                guard let self, self.managed, let running = self.process, running === child else { return }
                self.healthMisses = verdict == .ours ? 0 : self.healthMisses + 1
                if self.healthMisses >= Self.healthMissesBeforeRestart {
                    NSLog("fremkit: server child no longer answers on port %d; restarting it", self.config.port)
                    self.healthMisses = 0
                    Self.killTree(running.processIdentifier, signal: SIGTERM)
                    return
                }
                self.watchHealth(child)
            }
        }
        healthWatch = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.healthInterval, execute: work)
    }

    private func childDidExit(_ finished: Process) {
        // A child we already gave up on: just drop our reference to it.
        guard let current = process, current === finished else {
            terminating.removeAll { $0 === finished }
            return
        }
        process = nil
        closeLog()
        // Its secret dies with it: nothing is presented until the next listener proves itself.
        access.forgetSpawn()

        guard managed else {
            state = .stopped
            return
        }

        // A child that ran long enough was healthy; start the backoff over.
        if let startedAt, Date().timeIntervalSince(startedAt) >= Self.healthyAfter {
            backoffIndex = 0
        }
        startedAt = nil
        scheduleRestart()
    }

    private func scheduleRestart() {
        let delay = Self.backoff[min(backoffIndex, Self.backoff.count - 1)]
        backoffIndex += 1
        state = .restarting(delay)

        restartWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.managed else { return }
            self.restartWork = nil
            // The port may have been taken while ours was down — by a `pnpm dev`, or by a
            // listener that is not ours at all. Look before spawning onto it.
            self.probe { [weak self] verdict in
                guard let self, self.managed, self.restartWork == nil, self.process == nil else { return }
                if verdict == .absent { self.spawn() } else { self.standAside(verdict) }
            }
        }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(delay), execute: work)
    }

    // MARK: - Pid file

    private static func writePidFile(_ pid: pid_t) {
        let url = pidURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? Data(String(pid).utf8).write(to: url, options: .atomic)
    }

    private static func removePidFile() {
        try? FileManager.default.removeItem(at: pidURL)
    }

    /// Kills a server left behind by a helper that died without stopping its child.
    ///
    /// Call once at launch, before the first probe: an orphan still holding the port would
    /// otherwise look like somebody else's `pnpm dev` and put the helper into `.external` for
    /// the rest of the session. Only a pid whose command line still looks like our own server is
    /// touched — pids are recycled, and the one in the file may belong to anything by now.
    func reapOrphan() {
        let url = Self.pidURL
        guard let text = try? String(contentsOf: url, encoding: .utf8),
              let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 1
        else { return }

        guard kill(pid, 0) == 0 else {
            NSLog("fremkit: stale server.pid %d is not running, removing the file", pid)
            Self.removePidFile()
            return
        }

        // The match is ServerLaunch's: both the repo path and the entry point for a checkout,
        // the bundle's own executable for the app. "contains server and (repoPath or pnpm or
        // node)" once matched almost any Node process on the machine — the pid file is stale
        // often enough that this was a real way to kill something else entirely.
        let command = Self.commandLine(of: pid)
        guard launch.isOwnServer(commandLine: command, executablePath: Self.executablePath(of: pid)) else {
            // The command line is not logged: it is another process's, and the log is a file the
            // user may hand to someone else.
            NSLog("fremkit: pid %d from server.pid is not our server, leaving it alone", pid)
            Self.removePidFile()
            return
        }

        NSLog("fremkit: killing orphaned server process tree %d", pid)
        Self.killTree(pid, signal: SIGTERM)
        let deadline = Date().addingTimeInterval(Self.killAfter)
        while kill(pid, 0) == 0, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if kill(pid, 0) == 0 {
            NSLog("fremkit: orphaned server %d ignored SIGTERM, sending SIGKILL", pid)
            Self.killTree(pid, signal: SIGKILL)
        }
        Self.removePidFile()
    }

    /// The executable `pid` runs, as the kernel knows it (symlinks resolved), or nil.
    /// The disk map's scanner, built into `Contents/MacOS` beside this executable, if it is there.
    private static func diskScanner() -> String? {
        guard let scanner = Bundle.main.executableURL?.deletingLastPathComponent()
            .appendingPathComponent("fremkit-scan"),
            FileManager.default.isExecutableFile(atPath: scanner.path) else { return nil }
        return scanner.path
    }

    private static func executablePath(of pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(cString: buffer)
    }

    /// `path` with every symlink resolved, or `path` itself when it cannot be.
    private static func realPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Full command line of `pid` via `ps`, or an empty string when it cannot be read.
    private static func commandLine(of pid: pid_t) -> String {
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-o", "command=", "-p", String(pid)]
        let pipe = Pipe()
        ps.standardOutput = pipe
        ps.standardError = FileHandle.nullDevice

        do {
            try ps.run()
        } catch {
            return ""
        }
        // One short line at most, so the pipe cannot fill and deadlock the read.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        ps.waitUntilExit()
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /**
     The first `node` that exists among the usual places, by absolute path.

     A login item inherits a bare `PATH`, so the interpreter has to be found rather than looked
     up. Package managers first, then the version managers — which is where most people's Node
     actually lives — and a login shell as the last resort, because that is the only way to ask a
     setup this does not know about.
     */
    private static func resolveNode() -> URL? {
        let home = NSHomeDirectory()
        let manager = FileManager.default
        var candidates = [
            "/opt/homebrew/bin/node",   // Homebrew, Apple silicon
            "/usr/local/bin/node",      // Homebrew, Intel
            "/opt/local/bin/node",      // MacPorts
            "\(home)/.volta/bin/node",  // volta
            "\(home)/.local/share/fnm/aliases/default/bin/node", // fnm
            "\(home)/.asdf/shims/node", // asdf
            "\(home)/.local/bin/node",
            "\(home)/Library/pnpm/node",
            "/usr/bin/node",
        ]
        // nvm keeps one directory per version; take the newest by name.
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? manager.contentsOfDirectory(atPath: nvm) {
            for version in versions.sorted(by: NodeVersionOrder.newer).prefix(4) {
                candidates.append("\(nvm)/\(version)/bin/node")
            }
        }
        for path in candidates where manager.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        // Last resort: ask a login shell, which sources the profile a version manager hooks into.
        if let found = nodeFromLoginShell(), manager.isExecutableFile(atPath: found.path) {
            return found
        }
        return nil
    }

    /// `node` as a login shell resolves it, or nil.
    private static func nodeFromLoginShell() -> URL? {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        shell.standardOutput = pipe
        shell.standardError = FileHandle.nullDevice
        do { try shell.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        shell.waitUntilExit()
        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard shell.terminationStatus == 0, path.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: path)
    }

    // MARK: - Log

    /// Largest the log may be when a server is spawned. Past this it is rolled over.
    static let maxLogBytes: UInt64 = 4 * 1024 * 1024

    /**
     Opens the server log for appending, rolling it over first when it has grown too large.

     Nothing rotated this file: a server that logs a line per request per second filled it for
     months, and it is the file a user would attach when asking for help. One previous generation
     is kept as `server.log.1` — enough to still see what happened before a crash — and the older
     one is dropped.
     */
    private static func openLog() -> FileHandle? {
        let url = logURL
        let directory = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        rollLogIfTooLarge(url)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: url.path) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    /// Moves the log aside when it is past `maxLogBytes`, replacing any previous generation.
    private static func rollLogIfTooLarge(_ url: URL) {
        let manager = FileManager.default
        guard let size = try? manager.attributesOfItem(atPath: url.path)[.size] as? UInt64,
              size > maxLogBytes else { return }
        let previous = url.appendingPathExtension("1")
        try? manager.removeItem(at: previous)
        // A failed move must not stop the server from starting: worst case the log keeps growing.
        try? manager.moveItem(at: url, to: previous)
    }

    private func closeLog() {
        try? logHandle?.close()
        logHandle = nil
    }
}
