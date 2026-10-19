import SwiftUI

/// The Mac answered and no longer knows this iPad: it was removed in the admin.
struct UnauthorizedView: View {
    let pairAgain: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.ipad")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("This iPad is no longer allowed")
                .font(.title.bold())
                .multilineTextAlignment(.center)
            Text("It was removed on the Mac. Pair it again to show the dashboard.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(action: pairAgain) {
                Text("Pair again")
                    .frame(minWidth: 200, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(40)
        .frame(maxWidth: 640)
    }
}
