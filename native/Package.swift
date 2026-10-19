// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Fremkit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "FremkitCore", targets: ["FremkitCore"]),
        .executable(name: "FremkitHelper", targets: ["FremkitHelper"]),
        .executable(name: "fremkit-scan", targets: ["FremkitScan"]),
    ],
    targets: [
        // Pure logic, no AppKit/IOKit: unit tested with `swift test`.
        .target(name: "FremkitCore"),
        // AppKit/IOKit shell around FremkitCore, verified manually.
        .executableTarget(name: "FremkitHelper", dependencies: ["FremkitCore"]),
        // The disk map's scanner, run by the server; its logic is in FremkitCore.
        .executableTarget(name: "FremkitScan", dependencies: ["FremkitCore"]),
        .testTarget(name: "FremkitCoreTests", dependencies: ["FremkitCore"]),
    ],
    swiftLanguageVersions: [.v5]
)
