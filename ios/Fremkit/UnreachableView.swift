import SwiftUI

/// The paired Mac answers at none of its addresses. `RootView` retries every 5 s and when the
/// network comes back; the button retries now.
struct UnreachableView: View {
    let name: String
    let isRetrying: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text(verbatim: name)
                .font(.title.bold())
            Text("Can’t reach the Mac")
                .font(.title3)
            Text("Check that it is on, on the same network, and that “Allow an iPad on the local network” is turned on.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(action: retry) {
                Text("Try again")
                    .frame(minWidth: 200, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isRetrying)
            ProgressView()
                .opacity(isRetrying ? 1 : 0)
        }
        .padding(40)
        .frame(maxWidth: 640)
    }
}
