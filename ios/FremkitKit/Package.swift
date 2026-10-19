// swift-tools-version: 6.0
// The iPad app's logic with no UI: pairing links, the key pin, the fingerprint words, the stored
// pairing, and the requests the app makes to the Mac. Tested on the Mac with `swift test`.
import PackageDescription

let package = Package(
    name: "FremkitKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "FremkitKit", targets: ["FremkitKit"]),
    ],
    targets: [
        .target(
            name: "FremkitKit",
            resources: [.copy("Resources/fingerprint-words.txt")]
        ),
        .testTarget(
            name: "FremkitKitTests",
            dependencies: ["FremkitKit"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
