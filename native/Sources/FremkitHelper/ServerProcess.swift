import Darwin
import Foundation
import FremkitCore

/// What the dashboard server is doing, as shown in the status menu.
enum ServerState: Equatable {
    /// The port already answered at startup: someone else's `pnpm dev` owns the server.
    case external
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
        case .starting: return L10n.string(.serverStarting)
        case .running: return L10n.string(.serverRunning)
        case .stopped: return L10n.string(.serverStopped)
        case let .restarting(seconds): return L10n.string(.serverRestarting, seconds)
        }
    }
}

/// Supervises `pnpm --filter server start` in the repo, or steps aside when the port is already taken.
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
    /// Set once the startup probe found someone else on the port. While it is set we keep probing:
    /// if that server goes away (a `pnpm dev` stopped, or a previous helper's child that was still
    /// dying when we probed), we take over and spawn our own.
    private var isExternal = false
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

    init(config: HelperConfig) {
        self.config = config
    }

    /// `~/Library/Logs/Fremkit/server.log`. Never rotated.
    static var logURL: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Logs/Fremkit/server.log")
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
            self.probe { [weak self] alive in
                guard let self, self.managed else { return }
                if alive {
                    self.isExternal = true
                    self.state = .external
                    self.watchExternal()
                    return
                }
                self.isExternal = false
                self.spawn()
            }
        }
    }

    /// Keeps probing an external server; after two consecutive misses (~10 s) we spawn our own.
    private func watchExternal() {
        externalWatch?.cancel()
        externalMisses = 0
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.managed, self.isExternal else { return }
            self.probe { [weak self] alive in
                guard let self, self.managed, self.isExternal else { return }
                if alive {
                    self.externalMisses = 0
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
            state = isExternal ? .external : .stopped
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
            state = isExternal ? .external : .stopped
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
        probe { alive in
            guard alive else { return }
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

    /// GETs `/api/config` on the configured port; `alive` is called on the main thread.
    func probe(_ alive: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(config.port)/api/config") else {
            DispatchQueue.main.async { alive(false) }
            return
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = Self.probeTimeout
        configuration.timeoutIntervalForResource = Self.probeTimeout
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.underlyingQueue = probeQueue
        let session = URLSession(configuration: configuration, delegate: nil, delegateQueue: queue)

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = Self.probeTimeout

        session.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse).map { (200..<500).contains($0.statusCode) } ?? false
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async { alive(ok) }
        }.resume()
    }

    // MARK: - Spawning

    private func spawn() {
        let process = Process()
        // Run the server itself, not a pnpm wrapper around it: the supervised process must be
        // the one that binds the port, so its death (or a stray kill) is what we observe.
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["tsx", "src/index.ts"]
        process.currentDirectoryURL = URL(fileURLWithPath: config.repoPath).appendingPathComponent("server")

        var environment = ProcessInfo.processInfo.environment
        // A login item inherits a bare PATH; node lives in the usual Homebrew spots and tsx in the
        // server package's own bin directory.
        let extra = "\(config.repoPath)/server/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/Library/pnpm"
        environment["PATH"] = extra + ":" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        process.environment = environment

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

        probe { [weak self] alive in
            guard let self, self.managed, self.state == .starting,
                  let running = self.process, running === child, running.isRunning else { return }
            if alive {
                self.state = .running
                self.watchHealth(child)
                return
            }
            if let startedAt = self.startedAt,
               Date().timeIntervalSince(startedAt) >= Self.healthyAfter {
                NSLog("fremkit: server child alive for %.0f s but /api/config never answered; reporting it as running",
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
            self.probe { [weak self] alive in
                guard let self, self.managed, let running = self.process, running === child else { return }
                self.healthMisses = alive ? 0 : self.healthMisses + 1
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
            self.spawn()
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

        let command = Self.commandLine(of: pid)
        guard command.contains("server"),
              command.contains(config.repoPath) || command.contains("pnpm") || command.contains("node")
        else {
            NSLog("fremkit: pid %d from server.pid is an unrelated process (%@), leaving it alone",
                  pid, command)
            Self.removePidFile()
            return
        }

        NSLog("fremkit: killing orphaned server process tree %d (%@)", pid, command)
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

    // MARK: - Log

    private static func openLog() -> FileHandle? {
        let url = logURL
        let directory = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: url.path) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    private func closeLog() {
        try? logHandle?.close()
        logHandle = nil
    }
}
