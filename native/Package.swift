// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Fremkit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "FremkitCore", targets: ["FremkitCore"]),
        .executable(name: "FremkitHelper", targets: ["FremkitHelper"]),
    ],
    targets: [
        // Pure logic, no AppKit/IOKit: unit tested with `swift test`.
        .target(name: "FremkitCore"),
        // AppKit/IOKit shell around FremkitCore, verified manually.
        .executableTarget(name: "FremkitHelper", dependencies: ["FremkitCore"]),
        .testTarget(name: "FremkitCoreTests", dependencies: ["FremkitCore"]),
    ],
    swiftLanguageVersions: [.v5]
)
