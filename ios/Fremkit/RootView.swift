import FremkitKit
import SwiftUI

/// One screen per `AppState`, or the pairing screen while pairing runs, and the app-wide
/// reactions: back from the background, the unreachable and key-changed screens'
/// retries, a link that would replace the pairing.
///
/// Every screen is laid out in the same region: the safe area with the status bar and the home
/// indicator hidden, the dashboard's web view included. That region is what pairing reports as
/// the viewport (`ViewportMeter`), so it is measured here, on the container itself.
struct RootView: View {
    let model: AppModel
    let flow: PairingFlow
    let network: LocalNetwork
    let meter: ViewportMeter
    let brightness: BrightnessSync
    @Environment(\.scenePhase) private var scenePhase
    @State private var wasInBackground = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            screen
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background {
                    // The keyboard of the code field shrinks the safe area; the dashboard never
                    // has it up when it loads, so it is left out of the measure.
                    Color.clear
                        .ignoresSafeArea(.keyboard)
                        .onGeometryChange(for: CGSize.self) { $0.size } action: { meter.measured($0) }
                }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .preferredColorScheme(.dark)
        .alert(replaceTitle, isPresented: replacing, presenting: flow.pendingLink) { _ in
            Button("Replace", role: .destructive) { flow.confirmReplace() }
            Button("Cancel", role: .cancel) { flow.declineReplace() }
        } message: { link in
            Text("This iPad will show the dashboard of \(link.macName) instead.")
        }
        // A new pairing (or none) starts brightness over; an address update keeps the token.
        .onChange(of: model.mac?.token) { brightness.reset() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                wasInBackground = true
            case .active where wasInBackground:
                wasInBackground = false
                model.resume()
            default:
                break
            }
        }
    }

    /// Shown while a link waits for the user to agree to replace the pairing. Dismissal goes
    /// through the alert's buttons, which clear the link themselves.
    private var replacing: Binding<Bool> {
        Binding(get: { flow.pendingLink != nil }, set: { _ in })
    }

    private var replaceTitle: Text {
        Text("Replace the pairing with \(model.mac?.name ?? "")?")
    }

    @ViewBuilder private var screen: some View {
        switch flow.step {
        case .idle:
            appScreen
        case .scanning:
            ScannerView(flow: flow)
        case let .link(link):
            LinkPairingView(flow: flow, link: link)
        case .manualList, .manualKey, .manualCode:
            ManualPairView(flow: flow, network: network)
        }
    }

    @ViewBuilder private var appScreen: some View {
        switch model.state {
        case .welcome:
            WelcomeView(credentialsUnreadable: model.credentialsUnreadable,
                        scan: { flow.scan() }, enterCode: { flow.enterCode() })
        case .connecting:
            ConnectingView(name: model.mac?.name)
        case let .dashboard(host, _):
            if let mac = model.mac {
                DashboardScreen(host: host, mac: mac, model: model, brightness: brightness)
                    .id(host)
            }
        case let .unreachable(name):
            UnreachableView(name: name, isRetrying: model.isConnecting) { model.reconnect() }
                .task {
                    // Every 5 s while the screen is up; the task ends with the screen.
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(5))
                        if Task.isCancelled { break }
                        model.reconnect()
                    }
                }
        case let .keyChanged(name):
            KeyChangedView(name: name, isRetrying: model.isConnecting,
                           pairAgain: { model.forget() }, retry: { model.reconnect() })
                .task {
                    // Same retries as the unreachable screen: a mismatch that was only another
                    // machine on the old address goes away by itself.
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(5))
                        if Task.isCancelled { break }
                        model.reconnect()
                    }
                }
        case .unauthorized:
            UnauthorizedView { model.forget() }
        }
    }
}

/// The dashboard: the screen kept awake, the page inside the safe area (the status bar and the
/// home indicator are hidden by `RootView` on every screen).
private struct DashboardScreen: View {
    let host: String
    let mac: PairedMac
    let model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    let brightness: BrightnessSync

    var body: some View {
        DashboardView(host: host, port: mac.port, mac: mac,
                      onMessage: { message in
                          switch message {
                          case .unauthorized: model.pageSaidUnauthorized()
                          case let .brightness(target, seq): brightness.receive(target: target, seq: seq)
                          case .screen: break
                          }
                      },
                      onFailure: { model.dashboardFailed() })
            .task(id: scenePhase) {
                // The safety net for a revocation the page does not report: while the dashboard is
                // up and the app active, ask the Mac every 30 s whether it still knows this iPad.
                // The task ends with the dashboard and restarts with the scene phase.
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: AppModel.authorizationCheckInterval)
                    if Task.isCancelled { break }
                    await model.checkAuthorization()?.value
                }
            }
            .task(id: scenePhase) {
                // Heartbeat: the level goes to the Mac every 10 s while the dashboard is shown and
                // the app not in the background, which is what keeps the screen from going `no-device`.
                // `.inactive` (Control Center open) keeps reporting, so the Mac follows the level the
                // user is setting; only the background stops.
                guard scenePhase != .background else {
                    brightness.stop()
                    return
                }
                await brightness.run()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIScreen.brightnessDidChangeNotification)) { _ in
                if scenePhase != .background { brightness.levelChanged() }
            }
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear {
                UIApplication.shared.isIdleTimerDisabled = false
                brightness.stop()
            }
    }
}

/// The brightness of the screen the app's window scene is on (`UIScreen.main` is deprecated).
@MainActor
enum ScreenBrightness {
    private static var screen: UIScreen? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first?.screen
    }

    static var level: Double {
        get { screen.map { Double($0.brightness) } ?? 0.5 }
        set { screen?.brightness = CGFloat(newValue) }
    }
}

private struct ConnectingView: View {
    let name: String?

    var body: some View {
        VStack(spacing: 16) {
            ProgressView().controlSize(.large)
            if let name {
                Text("Connecting to \(name)…")
            } else {
                Text("Connecting…")
            }
        }
        .foregroundStyle(.secondary)
    }
}
