import Foundation
import Observation

/// What the app shows.
public enum AppState: Equatable, Sendable {
    /// Not paired (or the stored pairing could not be read): scan or type a code.
    case welcome
    /// Looking for the paired Mac, nothing to show yet.
    case connecting
    /// The dashboard, served by `host` (the candidate that answered).
    case dashboard(host: String, info: DeviceInfo)
    /// The paired Mac did not answer at any address. Retried by the app on its own.
    case unreachable(name: String)
    /// The Mac answered and no longer knows this iPad.
    case unauthorized
    /// The Mac (or something at its address) answered with a key other than the pinned one. The
    /// pairing is kept: the app retries on its own, and the user can pair again.
    case keyChanged(name: String)
}

/// The app's state machine, with no UI: it loads the pairing, finds the Mac with `Connector`,
/// and moves between the screens. The views and the platform pieces (Bonjour, the network
/// monitor, the web view) call into it; it never calls out to them.
@Observable @MainActor
public final class AppModel {
    public private(set) var state: AppState = .connecting
    /// The pairing in use, nil when there is none.
    public private(set) var mac: PairedMac?
    /// True while a connection attempt or a check is running, so a screen that stays up during
    /// a retry (unreachable, key changed, unauthorized) can say so.
    public private(set) var isConnecting = false
    /// True when the keychain held something it could not give back at launch. The welcome screen
    /// shows, the stored pairing is left alone (a keychain failure is not "not paired"), and
    /// `resume()` reads it again when the app comes back to the foreground.
    public private(set) var credentialsUnreadable = false

    @ObservationIgnored private let store: any CredentialStore
    @ObservationIgnored private let connector: Connector
    @ObservationIgnored private let discovered: @MainActor () -> [String]
    @ObservationIgnored private var running: Task<Void, Never>?
    /// What `running` is. A periodic check or a relocation gives way to anything else rather than
    /// being joined: both leave the dashboard up when the Mac does not answer, which a reconnect or
    /// a resume must not.
    @ObservationIgnored private var runningWork: Work?
    /// Periodic checks in a row that found nobody at the host in use. Reset by any answer.
    @ObservationIgnored private var unansweredChecks = 0
    /// An address was announced while a check or a relocation ran on the dashboard: look again when
    /// it ends rather than drop it.
    @ObservationIgnored private var relocationPending = false

    private enum Work {
        case connect, check, periodicCheck, relocate
        /// Runs behind the dashboard: anything the user or the page asks for comes first.
        var isBackground: Bool { self == .periodicCheck || self == .relocate }
    }
    /// Bumped by `pair(with:)` and `forget()`, so the result of an attempt started for another
    /// pairing is dropped.
    @ObservationIgnored private var generation = 0

    /// - Parameter discovered: the addresses Bonjour resolved for `_fremkit._tcp`, read at the
    ///   start of each attempt.
    public init(store: any CredentialStore, connector: Connector = Connector(),
                discovered: @escaping @MainActor () -> [String] = { [] }) {
        self.store = store
        self.connector = connector
        self.discovered = discovered
    }

    /// Loads the pairing and connects, or shows the welcome screen.
    @discardableResult
    public func start() -> Task<Void, Never>? {
        let stored: PairedMac?
        do {
            stored = try store.load()
            credentialsUnreadable = false
        } catch {
            credentialsUnreadable = true
            stored = nil
        }
        guard let stored else {
            mac = nil
            state = .welcome
            return nil
        }
        mac = stored
        state = .connecting
        return reconnect()
    }

    /// Stores a new pairing (replacing any other) and connects to it. Throws when the keychain
    /// refuses it: a pairing that would be gone at the next launch is not a pairing.
    @discardableResult
    public func pair(with mac: PairedMac) throws -> Task<Void, Never> {
        try store.save(mac)
        cancelRunning()
        self.mac = mac
        credentialsUnreadable = false
        state = .connecting
        return reconnect()
    }

    /// Drops the pairing, here and in the keychain.
    public func forget() {
        store.clear()
        cancelRunning()
        mac = nil
        credentialsUnreadable = false
        state = .welcome
    }

    /// Finds the Mac again: its name, its last address, then whatever Bonjour resolved. The
    /// unreachable, key-changed and unauthorized screens stay up while it tries; the dashboard
    /// gives way to `.connecting`. One attempt at a time: a call during an attempt joins it.
    @discardableResult
    public func reconnect() -> Task<Void, Never> {
        if let running {
            guard runningWork?.isBackground == true else { return running }
            cancelRunning()
        }
        guard let mac else {
            state = .welcome
            return Task {}
        }
        if case .dashboard = state { state = .connecting }
        let generation = generation
        let candidates = discovered()
        // This attempt reads every address known now: one announced earlier needs no relocation.
        relocationPending = false
        isConnecting = true
        let task = Task { [connector] in
            let result = await connector.connect(mac: mac, discovered: candidates)
            self.finish(result, for: mac, generation: generation)
        }
        running = task
        runningWork = .connect
        return task
    }

    /// The page said the device was revoked.
    public func pageSaidUnauthorized() {
        guard case .dashboard = state else { return }
        cancelRunning()
        state = .unauthorized
    }

    /// The web view could not load the page, or its content process died. Always goes through
    /// `.connecting`, so the dashboard comes back in a new web view: a check that was running
    /// (`resume()`) is dropped rather than joined, since its `.ok` would keep the dead view.
    public func dashboardFailed() {
        guard case .dashboard = state else { return }
        cancelRunning()
        state = .connecting
        reconnect()
    }

    /// The app is in the foreground again. On the dashboard, asks the Mac whether it still knows
    /// this iPad (`/api/devices/me` on the host in use); elsewhere, tries to connect again.
    @discardableResult
    public func resume() -> Task<Void, Never>? {
        if mac == nil {
            return credentialsUnreadable ? start() : nil
        }
        guard case let .dashboard(host, _) = state, let mac else { return reconnect() }
        if let running {
            guard runningWork?.isBackground == true else { return running }
            cancelRunning()
        }
        return check(host: host, mac: mac, periodic: false)
    }

    private func finish(_ result: ConnectResult, for mac: PairedMac, generation: Int) {
        guard generation == self.generation else { return }
        running = nil
        runningWork = nil
        isConnecting = false
        switch result {
        case let .connected(host, info):
            remember(host, addresses: info.addresses, for: mac)
            unansweredChecks = 0
            state = .dashboard(host: host, info: info)
        case .unauthorized:
            state = .unauthorized
        case .keyChanged:
            state = .keyChanged(name: mac.name)
        case .unreachable:
            state = .unreachable(name: mac.name)
        }
    }

    /// The address that answered (nil for a check of the host in use) and the other addresses the Mac
    /// listed, remembered for the next search and the next launch; if the keychain refuses, this
    /// session still has them.
    private func remember(_ host: String?, addresses: [String], for mac: PairedMac) {
        var updated = mac.updating(addresses: addresses)
        if let host { updated = updated.updating(address: host) }
        guard updated != mac else { return }
        try? store.save(updated)
        self.mac = updated
    }

    /// How often the dashboard asks the Mac whether it still knows this iPad (`checkAuthorization()`).
    public static let authorizationCheckInterval: Duration = .seconds(30)

    /// Periodic checks in a row that must find nobody at the host in use before the app looks for
    /// the Mac elsewhere (`relocate`): about a minute, so one lost request moves nothing.
    public static let unansweredChecksBeforeRelocating = 2

    /// The dashboard's safety net: asks the Mac whether it still knows this iPad, so a revocation
    /// shows the app's screen even when the page does not say so. `unauthorized`, or a wrong key
    /// (which reconnects), changes the screen. A Mac that does not answer is first the page's to
    /// wait for, as it reconnects by itself, but only to the address it was loaded from: after
    /// `unansweredChecksBeforeRelocating` such checks in a row, the app looks for the Mac at its
    /// other addresses behind the dashboard (`relocate`), in case it moved.
    /// Nil when not on the dashboard or while another attempt or check runs (never two at once).
    @discardableResult
    public func checkAuthorization() -> Task<Void, Never>? {
        guard case let .dashboard(host, _) = state, let mac, running == nil else { return nil }
        return check(host: host, mac: mac, periodic: true)
    }

    /// Probes `/api/devices/me` on the host in use. A resume reconnects when the Mac does not
    /// answer there; a periodic check leaves that to the page. A wrong key reconnects in both.
    private func check(host: String, mac: PairedMac, periodic: Bool) -> Task<Void, Never> {
        let generation = generation
        isConnecting = true
        let task = Task { [connector] in
            let outcome = await connector.prober.probe(host: host, port: mac.port, mac: mac)
            self.finishCheck(outcome, host: host, generation: generation, reconnectOnFailure: !periodic)
        }
        running = task
        runningWork = periodic ? .periodicCheck : .check
        return task
    }

    private func finishCheck(_ outcome: ProbeOutcome, host: String, generation: Int, reconnectOnFailure: Bool) {
        guard generation == self.generation else { return }
        running = nil
        runningWork = nil
        isConnecting = false
        guard case .dashboard(host, _) = state, let mac else { return }
        if case .unreachable = outcome {} else { unansweredChecks = 0 }
        switch outcome {
        case let .ok(info):
            remember(nil, addresses: info.addresses, for: mac)
            state = .dashboard(host: host, info: info)
        case .unauthorized: state = .unauthorized
        // A wrong key reconnects even from the periodic check: the Connector then decides between
        // the dashboard (another candidate answers) and the key-changed screen.
        case .pinMismatch: reconnect()
        case .unreachable:
            if reconnectOnFailure {
                reconnect()
            } else {
                unansweredChecks += 1
                if unansweredChecks >= Self.unansweredChecksBeforeRelocating {
                    relocate(from: host, mac: mac)
                    return
                }
            }
        }
        runPendingRelocation()
    }

    /// Runs the relocation an address announced during the job that just ended asked for, if the
    /// dashboard is still up and nothing else started.
    private func runPendingRelocation() {
        guard relocationPending else { return }
        relocationPending = false
        guard case let .dashboard(host, _) = state, let mac, running == nil else { return }
        relocate(from: host, mac: mac)
    }

    /// Bonjour or the network monitor learned a new address. On the dashboard, looks for the Mac
    /// behind it, the host in use first: a page that still works stays where it is, and one whose
    /// Mac moved follows it without waiting for the periodic checks. Elsewhere, the caller's
    /// business (the unreachable and key-changed screens reconnect).
    /// Announced while a check or a relocation runs, it is remembered and acted on when that ends.
    /// Nil when not on the dashboard or while another job runs.
    @discardableResult
    public func addressesChanged() -> Task<Void, Never>? {
        guard case let .dashboard(host, _) = state, let mac else { return nil }
        guard running == nil else {
            relocationPending = true
            return nil
        }
        return relocate(from: host, mac: mac)
    }

    /// Runs the `Connector` without leaving the dashboard, and moves it only when the Mac answers
    /// at another host. A Mac that answers nowhere (asleep, say) leaves the page as it is, so it
    /// does not flicker; a revocation shows its screen, and a wrong key does only when the host in
    /// use presented it (`Connector.relocate`). The host in use is tried first, so a page that
    /// still works stays where it is.
    @discardableResult
    private func relocate(from host: String, mac: PairedMac) -> Task<Void, Never> {
        let generation = generation
        let candidates = discovered()
        relocationPending = false
        isConnecting = true
        let task = Task { [connector] in
            let result = await connector.relocate(mac: mac, discovered: candidates, current: host)
            self.finishRelocate(result, from: host, generation: generation)
        }
        running = task
        runningWork = .relocate
        return task
    }

    private func finishRelocate(_ result: ConnectResult, from host: String, generation: Int) {
        guard generation == self.generation else { return }
        running = nil
        runningWork = nil
        isConnecting = false
        guard case .dashboard(host, _) = state, let mac else { return }
        switch result {
        case let .connected(found, info):
            remember(found, addresses: info.addresses, for: mac)
            unansweredChecks = 0
            // A new host rebuilds the web view (`RootView` keys it by host); the same one keeps it.
            state = .dashboard(host: found, info: info)
        case .unauthorized: state = .unauthorized
        case .keyChanged: state = .keyChanged(name: mac.name)
        case .unreachable: break
        }
        runPendingRelocation()
    }

    private func cancelRunning() {
        generation += 1
        relocationPending = false
        running?.cancel()
        running = nil
        runningWork = nil
        isConnecting = false
    }
}
