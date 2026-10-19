import FremkitKit
import SwiftUI

@main
struct FremkitApp: App {
    @State private var network: LocalNetwork
    @State private var model: AppModel
    @State private var flow: PairingFlow
    @State private var brightness: BrightnessSync
    @State private var launched = false
    private let meter: ViewportMeter

    init() {
        let network = LocalNetwork()
        let meter = ViewportMeter()
        let model = AppModel(store: KeychainCredentialStore(), discovered: {
            network.refresh()
            return network.addresses
        })
        _network = State(initialValue: network)
        _model = State(initialValue: model)
        _flow = State(initialValue: PairingFlow.live(model: model, meter: meter))
        self.meter = meter
        // Lives as long as the app, not the dashboard: what it has applied survives a rebuild of the
        // web view, so a level set in Control Center is not overwritten by the next push. The Mac
        // and the host in use are read when a report is sent.
        _brightness = State(initialValue: BrightnessSync(
            read: { ScreenBrightness.level },
            write: { ScreenBrightness.level = $0 },
            send: { level, applied in
                let target: (PairedMac, String)? = await MainActor.run {
                    guard let mac = model.mac, case let .dashboard(host, _) = model.state else { return nil }
                    return (mac, host)
                }
                guard let (mac, host) = target else { return .failed }
                return await BrightnessReporter(mac: mac, host: host)
                    .send(brightness: level, applied: applied, transport: BrightnessReporter.pinnedTransport())
            },
            // Same path as the probe's 401: the pairing was removed on the Mac.
            unauthorized: { model.pageSaidUnauthorized() }))
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model, flow: flow, network: network, meter: meter, brightness: brightness)
                .task { launch() }
                // `fremkit://pair?…` from the Camera app or anywhere else. Anything that is not a
                // valid pairing link is ignored.
                .onOpenURL { url in flow.handle(url: url) }
        }
    }

    private func launch() {
        guard !launched else { return }
        launched = true
        let model = model
        // A newly resolved Bonjour address or the network coming back is a reason to try again
        // right away rather than at the next 5 s tick. On the dashboard it is a reason to check the
        // Mac is still where the page was loaded from, and to follow it if it moved.
        network.onChange = {
            switch model.state {
            case .unreachable, .keyChanged: model.reconnect()
            case .dashboard: model.addressesChanged()
            default: break
            }
        }
        // Browsing is also what asks for Local Network access, the first time.
        network.start()
        model.start()
        #if DEBUG
        flow.seedFromInstall()
        #endif
    }
}
