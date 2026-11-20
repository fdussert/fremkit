import SwiftUI

/// The paired Mac answers at none of its addresses. `RootView` retries every 5 s and when the
/// network comes back; **Try again** retries now. **Forget this Mac** is the way out when the Mac
/// is not coming back (sold, erased, Fremkit removed): without it the app stayed on this screen
/// for good. It asks first, because a Mac that is only asleep would have to be paired again.
struct UnreachableView: View {
    let name: String
    let isRetrying: Bool
    let retry: () -> Void
    let forget: () -> Void
    @State private var confirmingForget = false

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text(verbatim: name)
                .font(.title.bold())
            Text("Can’t reach the Mac")
                .font(.title3)
            Text("Check that it is on, on the same network, and that “Allow a tablet on the local network” is turned on.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(action: retry) {
                Text("Try again")
                    .frame(minWidth: 200, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isRetrying)
            Button(role: .destructive) { confirmingForget = true } label: {
                Text("Forget this Mac")
                    .frame(minWidth: 200, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            ProgressView()
                .opacity(isRetrying ? 1 : 0)
        }
        .padding(40)
        .frame(maxWidth: 640)
        .alert(Text("Forget \(name)?"), isPresented: $confirmingForget) {
            Button("Forget this Mac", role: .destructive, action: forget)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This iPad will have to be paired again to show a dashboard.")
        }
    }
}
