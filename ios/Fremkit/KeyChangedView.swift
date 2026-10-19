import SwiftUI

/// The Mac answered with a key other than the one this iPad pinned: its certificate was reset in
/// Fremkit, or another machine holds its address. `RootView` keeps retrying (a transient mismatch
/// recovers by itself); **Pair again** forgets the pairing, which only the user decides.
struct KeyChangedView: View {
    let name: String
    let isRetrying: Bool
    let pairAgain: () -> Void
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "key.slash")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text(verbatim: name)
                .font(.title.bold())
            Text("This Mac’s key has changed")
                .font(.title3)
            Text("If you reset its certificate in Fremkit, pair this iPad again. Otherwise, check you are on the right network.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(action: pairAgain) {
                Text("Pair again")
                    .frame(minWidth: 200, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            Button(action: retry) {
                Text("Try again")
                    .frame(minWidth: 200, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(isRetrying)
            ProgressView()
                .opacity(isRetrying ? 1 : 0)
        }
        .padding(40)
        .frame(maxWidth: 640)
    }
}
