// The app's state machine is `AppModel` in FremkitKit, where it is unit-tested, and so is pairing
// (`PairingFlow`). What lives here is for development builds only.
import FremkitKit
import Foundation

#if DEBUG
extension PairingFlow {
    /// Where `scripts/build-ios.sh install --seed` copies a pairing link, in the app's container.
    static let seedFile = "tmp/FremkitSeedLink"

    /// Debug builds only: a pairing link the install script copied into the app's container is
    /// opened as the Camera app would open it, so a development install can pair without the
    /// camera. The file is read once and deleted before the link is used. It is a file and not a
    /// launch argument because the link carries the code's secret, and every account on the Mac
    /// reads a process's arguments with `ps`. Release builds do not contain this.
    func seedFromInstall() {
        let file = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(Self.seedFile)
        guard let data = try? Data(contentsOf: file) else { return }
        try? FileManager.default.removeItem(at: file)
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text), handle(url: url) else {
            print("Fremkit: the seeded file is not a pairing link")
            return
        }
    }
}
#endif
