import Darwin
import Foundation

/// What became of one guarded open.
public enum GuardedOpenResult: Equatable {
    case opened(Int32)
    /// The open returned an error (`errno`).
    case failed(Int32)
    /// The open had not returned when the timeout ran out; it was given up and the walk goes on.
    case timedOut
    case cancelled
}

/// Opens directories on one long-lived worker thread, so that an open macOS holds while it asks
/// the user for permission cannot hold the walk with it.
///
/// On a fresh Mac, opening `~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive, another app's
/// container or a removable volume makes TCC show "Fremkit would like to access…", and `openat`
/// does not return until somebody answers. The prompt can be hidden behind the full-screen
/// dashboard, and the scan then looked stuck forever. Here an open that has not returned after
/// `grace` is reported (`onWaiting(true)`), waited for up to `timeout`, and then given up: the
/// caller counts that directory as unreadable and walks on.
///
/// A given-up open still occupies its thread until the prompt is answered. That worker is left to
/// finish on its own (it closes the descriptor if the open eventually succeeds, then exits) and a
/// fresh one takes over. While a given-up open is still blocked, a prompt is evidently still on
/// screen: later opens that block are given up after `grace` only, so a folder full of protected
/// subfolders does not cost `timeout` each. At most `maxAbandoned` blocked workers are kept; past
/// that the walk waits for an answer (or a cancellation) rather than leaving one more thread
/// behind.
///
/// The fast path is one hand-off to the worker and back, a few microseconds per directory.
public final class DirectoryOpener {
    /// One `openat`, retried on EINTR. Injectable so the tests can make it block.
    public typealias OpenCall = (_ parent: Int32, _ path: String, _ flags: Int32) -> (fd: Int32, error: Int32)

    public static let system: OpenCall = { parent, path, flags in
        while true {
            let fd = openat(parent, path, flags)
            if fd >= 0 { return (fd, 0) }
            let code = errno
            if code != EINTR { return (-1, code) }
        }
    }

    public static let defaultGrace: TimeInterval = 2
    public static let defaultTimeout: TimeInterval = 30
    public static let defaultMaxAbandoned = 16

    let grace: TimeInterval
    let timeout: TimeInterval
    let maxAbandoned: Int
    private let call: OpenCall
    private var current: OpenWorker?
    private var abandoned: [OpenWorker] = []

    public init(grace: TimeInterval = DirectoryOpener.defaultGrace,
                timeout: TimeInterval = DirectoryOpener.defaultTimeout,
                maxAbandoned: Int = DirectoryOpener.defaultMaxAbandoned,
                open: @escaping OpenCall = DirectoryOpener.system) {
        self.grace = grace
        self.timeout = max(grace, timeout)
        self.maxAbandoned = max(0, maxAbandoned)
        self.call = open
    }

    deinit { current?.stop() }

    /// Given-up opens whose thread is still blocked.
    var blockedCount: Int {
        abandoned.removeAll { $0.isFinished }
        return abandoned.count
    }

    /// Opens `path` relative to `parent` (`AT_FDCWD` for an absolute path). `onWaiting(true)` is
    /// called once the open has taken longer than the grace, `onWaiting(false)` once it is over,
    /// whatever its outcome.
    public func open(parent: Int32, path: String, flags: Int32,
                     isCancelled: () -> Bool = { false },
                     onWaiting: (Bool) -> Void = { _ in }) -> GuardedOpenResult {
        let blocked = abandoned.isEmpty ? 0 : blockedCount
        let worker = current ?? OpenWorker(call: call)
        current = worker
        worker.submit(parent: parent, path: path, flags: flags)

        // nil: no limit, the walk waits for an answer (see the type's comment).
        let limit: TimeInterval? = blocked >= maxAbandoned ? nil : blocked > 0 ? grace : timeout
        let slice = min(0.1, max(0.001, grace))
        let start = DispatchTime.now().uptimeNanoseconds
        var waiting = false
        defer { if waiting { onWaiting(false) } }
        while true {
            if let result = worker.wait(upTo: slice) { return Self.outcome(result) }
            if isCancelled() {
                if let result = give(up: worker) { if result.fd >= 0 { close(result.fd) } }
                return .cancelled
            }
            let elapsed = TimeInterval(DispatchTime.now().uptimeNanoseconds - start) / 1e9
            if !waiting && elapsed >= grace {
                waiting = true
                onWaiting(true)
            }
            if let limit, elapsed >= limit {
                // It may have returned between the last wait and now: then it is used after all.
                if let result = give(up: worker) { return Self.outcome(result) }
                return .timedOut
            }
        }
    }

    static func outcome(_ result: (fd: Int32, error: Int32)) -> GuardedOpenResult {
        result.fd >= 0 ? .opened(result.fd) : .failed(result.error)
    }

    /// Abandons the current worker, unless its open completed meanwhile (then returns its result).
    private func give(up worker: OpenWorker) -> (fd: Int32, error: Int32)? {
        if let result = worker.abandon() { return result }
        current = nil
        abandoned.append(worker)
        return nil
    }
}

/// The thread behind `DirectoryOpener`: takes one request at a time, hands the result back.
final class OpenWorker {
    private enum State { case idle, requested, running, done, abandoned, finished, stopping }

    private let mutex = UnsafeMutablePointer<pthread_mutex_t>.allocate(capacity: 1)
    private let cond = UnsafeMutablePointer<pthread_cond_t>.allocate(capacity: 1)
    private var state = State.idle
    private var parent: Int32 = -1
    private var path = ""
    private var flags: Int32 = 0
    private var result: (fd: Int32, error: Int32) = (-1, 0)
    private let call: DirectoryOpener.OpenCall

    init(call: @escaping DirectoryOpener.OpenCall) {
        self.call = call
        pthread_mutex_init(mutex, nil)
        pthread_cond_init(cond, nil)
        // The thread holds the worker until it returns, which is what keeps an abandoned one alive.
        let thread = Thread { [self] in self.run() }
        thread.stackSize = 128 * 1024
        thread.qualityOfService = .utility
        thread.start()
    }

    deinit {
        pthread_cond_destroy(cond)
        pthread_mutex_destroy(mutex)
        cond.deallocate()
        mutex.deallocate()
    }

    private func run() {
        pthread_mutex_lock(mutex)
        while true {
            while state == .idle || state == .done { pthread_cond_wait(cond, mutex) }
            if state == .stopping || state == .abandoned {
                // Stopped, or given up before the request was even picked up.
                state = .finished
                pthread_mutex_unlock(mutex)
                return
            }
            state = .running
            let (p, n, f) = (parent, path, flags)
            pthread_mutex_unlock(mutex)
            let r = call(p, n, f)
            pthread_mutex_lock(mutex)
            if state == .abandoned {
                // Nobody is waiting any more: the descriptor is ours to close, the thread's to end.
                if r.fd >= 0 { close(r.fd) }
                state = .finished
                pthread_mutex_unlock(mutex)
                return
            }
            result = r
            state = .done
            pthread_cond_broadcast(cond)
        }
    }

    func submit(parent: Int32, path: String, flags: Int32) {
        pthread_mutex_lock(mutex)
        self.parent = parent
        self.path = path
        self.flags = flags
        state = .requested
        pthread_cond_broadcast(cond)
        pthread_mutex_unlock(mutex)
    }

    /// The result, if it arrives within `seconds`; nil otherwise (or on a spurious wake-up).
    func wait(upTo seconds: TimeInterval) -> (fd: Int32, error: Int32)? {
        pthread_mutex_lock(mutex)
        defer { pthread_mutex_unlock(mutex) }
        if state != .done {
            var span = timespec(tv_sec: Int(seconds), tv_nsec: Int((seconds - floor(seconds)) * 1e9))
            pthread_cond_timedwait_relative_np(cond, mutex, &span)
        }
        guard state == .done else { return nil }
        state = .idle
        return result
    }

    /// Marks the request abandoned, or returns its result if it completed meanwhile.
    func abandon() -> (fd: Int32, error: Int32)? {
        pthread_mutex_lock(mutex)
        defer { pthread_mutex_unlock(mutex) }
        if state == .done {
            state = .idle
            return result
        }
        state = .abandoned
        return nil
    }

    var isFinished: Bool {
        pthread_mutex_lock(mutex)
        defer { pthread_mutex_unlock(mutex) }
        return state == .finished
    }

    func stop() {
        pthread_mutex_lock(mutex)
        if state == .idle || state == .done { state = .stopping }
        pthread_cond_broadcast(cond)
        pthread_mutex_unlock(mutex)
    }
}
