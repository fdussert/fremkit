import FremkitKit
import SwiftUI

/// Pairing without the camera: pick the Mac Bonjour found (or type its address when Bonjour finds
/// none), check that it shows the same four words as this screen, type the code it shows.
struct ManualPairView: View {
    let flow: PairingFlow
    let network: LocalNetwork

    var body: some View {
        switch flow.step {
        case let .manualAddress(typed):
            AddressEntry(flow: flow, typed: typed)
                // A new field for each return, so an address that did not answer comes back in it.
                .id(typed)
        case let .manualKey(service):
            VStack(spacing: 16) {
                ProgressView().controlSize(.large)
                Text("Connecting to \(service.name)…")
                    .foregroundStyle(.secondary)
                Button("Cancel", role: .cancel) { flow.cancel() }
                    .frame(minHeight: 44)
            }
        case let .manualCode(service, _):
            CodeEntry(flow: flow, service: service)
        default:
            MacList(flow: flow, network: network)
        }
    }
}

/// The Macs advertising Fremkit, by name, listed as soon as Bonjour sees them; one whose address
/// is not known yet shows so and cannot be picked. Typing the Mac's address is always offered, and
/// becomes the main button, with a hint, when none has turned up after 5 s: multicast does not
/// cross every network.
private struct MacList: View {
    let flow: PairingFlow
    let network: LocalNetwork
    @State private var waitedLong = false

    private var macs: [DiscoveredMac] {
        network.macs.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        VStack(spacing: 20) {
            Text("Choose your Mac")
                .font(.title.bold())
            if macs.isEmpty {
                ProgressView().controlSize(.large)
                if waitedLong {
                    Text("No Mac found yet. In Fremkit on the Mac, turn on “Allow a tablet on the local network” (Settings → Devices), or enter its address.")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            } else {
                VStack(spacing: 12) {
                    ForEach(macs, id: \.name) { mac in
                        MacRow(mac: mac) { if let service = mac.service { flow.choose(service) } }
                    }
                }
            }
            ProblemLine(problem: flow.problem)
            if macs.isEmpty && waitedLong {
                Button { flow.typeAddress() } label: {
                    Text("Enter the Mac’s address")
                        .frame(minWidth: 200, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            } else {
                Button("Enter the Mac’s address") { flow.typeAddress() }
                    .frame(minHeight: 44)
            }
            Button("Cancel", role: .cancel) { flow.cancel() }
                .frame(minHeight: 44)
        }
        .padding(40)
        .frame(maxWidth: 640)
        .task {
            try? await Task.sleep(for: .seconds(5))
            waitedLong = true
        }
        .task {
            // A Mac whose address is still pending is checked again every few seconds.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                if Task.isCancelled { break }
                if network.macs.values.contains(where: { $0.service == nil }) { network.refresh() }
            }
        }
    }
}

/// The Mac's address, as Settings → Devices shows it. **Connect** reads the key of whatever answers
/// there and shows its four words, as for a Mac from the list: the address is not a secret, and
/// nothing typed here is kept but what a pairing stores.
private struct AddressEntry: View {
    let flow: PairingFlow
    @State private var address: String

    init(flow: PairingFlow, typed: String) {
        self.flow = flow
        _address = State(initialValue: typed)
    }

    private var canConnect: Bool { !flow.isWorking && TypedAddress(typed: address) != nil }

    var body: some View {
        VStack(spacing: 20) {
            Text("Enter the Mac’s address")
                .font(.title.bold())
            Text("Fremkit shows it on the Mac in Settings → Devices, beside the code: a name ending in .local, or four numbers separated by dots.")
                .font(.title3)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            TextField("Address", text: $address)
                .font(.system(size: 24, weight: .medium, design: .monospaced))
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .submitLabel(.go)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 480)
                .onChange(of: address) { _, typed in
                    if typed.count > 300 { address = String(typed.prefix(300)) }
                }
                .onSubmit { if canConnect { flow.connect(typed: address) } }
            Button { flow.connect(typed: address) } label: {
                Text("Connect")
                    .frame(minWidth: 200, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!canConnect)
            ProgressView()
                .opacity(flow.isWorking ? 1 : 0)
            ProblemLine(problem: flow.problem)
            HStack(spacing: 24) {
                Button("Back to the list") { flow.enterCode() }
                Button("Cancel", role: .cancel) { flow.cancel() }
            }
            .frame(minHeight: 44)
        }
        .padding(40)
        .frame(maxWidth: 640)
    }
}

private struct MacRow: View {
    let mac: DiscoveredMac
    let pick: () -> Void

    var body: some View {
        Button(action: pick) {
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                Text(verbatim: mac.name)
                Spacer()
                if mac.service == nil {
                    Text("Looking for its address…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    ProgressView()
                }
            }
            .font(.title3)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        }
        .buttonStyle(.bordered)
        .disabled(mac.service == nil)
    }
}

/// The Mac's four words, big, and the code field. **Pair** sends the code with the key those
/// words came from as the pin.
private struct CodeEntry: View {
    let flow: PairingFlow
    let service: MacService
    @State private var code = ""

    private var canPair: Bool { !flow.isWorking && normaliseCode(code) != nil }

    var body: some View {
        VStack(spacing: 20) {
            Text(verbatim: service.name)
                .font(.title.bold())
            Text(verbatim: flow.words.joined(separator: "  "))
                .font(.system(size: 44, weight: .semibold, design: .rounded))
                .foregroundStyle(.tint)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.5)
                .lineLimit(2)
            Text("Check that the Mac shows the same words.")
                .font(.title3)
                .multilineTextAlignment(.center)
            TextField("Code", text: $code)
                .font(.system(size: 32, weight: .medium, design: .monospaced))
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .submitLabel(.go)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 360)
                .onChange(of: code) { _, typed in
                    // Upper case as it is typed; a dash or spaces may stay, normaliseCode drops them.
                    let upper = String(typed.uppercased().prefix(12))
                    if upper != typed { code = upper }
                }
                .onSubmit { if canPair { flow.submit(code: code) } }
            Button { flow.submit(code: code) } label: {
                Text("Pair")
                    .frame(minWidth: 200, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!canPair)
            ProgressView()
                .opacity(flow.isWorking ? 1 : 0)
            ProblemLine(problem: flow.problem)
            HStack(spacing: 24) {
                Button("Other Mac") { flow.enterCode() }
                Button("Cancel", role: .cancel) { flow.cancel() }
            }
            .frame(minHeight: 44)
        }
        .padding(40)
        .frame(maxWidth: 640)
    }
}
