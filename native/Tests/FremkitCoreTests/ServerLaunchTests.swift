import Foundation
import XCTest
@testable import FremkitCore

final class ServerLaunchTests: XCTestCase {
    private let resources = "/Applications/Fremkit.app/Contents/Resources"
    private var bundledServer: String { resources + "/server/fremkit-server" }

    func testRepoPathAlwaysMeansTheCheckout() {
        // Even inside a bundle that ships a server: the developer setup must not move.
        let launch = ServerLaunch.decide(repoPath: "/Volumes/Dev/fremkit", resourcesPath: resources) { _ in true }
        XCTAssertEqual(launch, .checkout(repoPath: "/Volumes/Dev/fremkit"))
    }

    func testNoRepoPathRunsTheBundledServer() {
        let launch = ServerLaunch.decide(repoPath: nil, resourcesPath: resources) { $0 == self.bundledServer }
        XCTAssertEqual(launch, .bundled(resourcesPath: resources))
    }

    func testEmptyRepoPathCountsAsAbsent() {
        let launch = ServerLaunch.decide(repoPath: "", resourcesPath: resources) { $0 == self.bundledServer }
        XCTAssertEqual(launch, .bundled(resourcesPath: resources))
    }

    func testNoRepoPathAndNoBundledServerFallsBackToTheDefaultCheckout() {
        let launch = ServerLaunch.decide(repoPath: nil, resourcesPath: resources) { _ in false }
        XCTAssertEqual(launch, .checkout(repoPath: HelperConfig.defaultRepoPath))
        XCTAssertEqual(ServerLaunch.decide(repoPath: nil, resourcesPath: nil) { _ in true },
                       .checkout(repoPath: HelperConfig.defaultRepoPath))
    }

    func testCheckoutGuardNeedsBothTheRepoAndTheEntryPoint() {
        let launch = ServerLaunch.checkout(repoPath: "/Volumes/Dev/fremkit")
        let node = "/opt/homebrew/bin/node"
        XCTAssertTrue(launch.isOwnServer(commandLine:
            "\(node) /Volumes/Dev/fremkit/server/node_modules/tsx/dist/cli.mjs src/index.ts", executablePath: node))
        XCTAssertFalse(launch.isOwnServer(commandLine: "\(node) /Volumes/Dev/fremkit/other.js", executablePath: node))
        XCTAssertFalse(launch.isOwnServer(commandLine: "\(node) /elsewhere/src/index.ts", executablePath: node))
        XCTAssertFalse(ServerLaunch.checkout(repoPath: "").isOwnServer(commandLine: "node src/index.ts", executablePath: node))
    }

    func testBundledGuardNeedsTheBundleExecutableItself() {
        let launch = ServerLaunch.bundled(resourcesPath: resources)
        XCTAssertTrue(launch.isOwnServer(commandLine: bundledServer, executablePath: bundledServer))
        // Another copy of the app, or a process merely naming the path, is not ours.
        XCTAssertFalse(launch.isOwnServer(commandLine: "x", executablePath:
            "/Users/someone/Downloads/Fremkit.app/Contents/Resources/server/fremkit-server"))
        XCTAssertFalse(launch.isOwnServer(commandLine: "/bin/cat " + bundledServer, executablePath: "/bin/cat"))
        XCTAssertFalse(launch.isOwnServer(commandLine: bundledServer, executablePath: bundledServer + "-old"))
        XCTAssertFalse(launch.isOwnServer(commandLine: bundledServer, executablePath: nil))
        XCTAssertFalse(ServerLaunch.bundled(resourcesPath: "").isOwnServer(commandLine: "", executablePath: "/server/fremkit-server"))
    }

    func testCheckoutEnvironmentKeepsTheDeveloperPath() {
        let env = ServerLaunch.checkout(repoPath: "/r").environment(
            inheriting: ["PATH": "/usr/bin:/bin", "NODE_OPTIONS": "--max-old-space-size=512"],
            port: 4242, dataDirectory: "/support", home: "/Users/u")
        XCTAssertEqual(env["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin:/r/server/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:/Users/u/Library/pnpm")
        XCTAssertEqual(env["FREMKIT_PORT"], "4242")
        XCTAssertNil(env["FREMKIT_ROOT"])
        XCTAssertNil(env["FREMKIT_DATA_DIR"])
        XCTAssertEqual(env["NODE_OPTIONS"], "--max-old-space-size=512")
    }

    func testSystemFoldersComeFirstAndRelativeEntriesGo() {
        let env = ServerLaunch.bundled(resourcesPath: resources).environment(
            inheriting: ["PATH": "/evil/bin:.::/usr/bin:relative:/opt/x"],
            port: 4242, dataDirectory: "/d", home: "/Users/u")
        XCTAssertEqual(env["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/evil/bin:/opt/x")
    }

    func testBundledEnvironmentNamesTheBundleAndTheData() {
        let env = ServerLaunch.bundled(resourcesPath: resources).environment(
            inheriting: ["NODE_OPTIONS": "--inspect", "HOME": "/Users/u"],
            port: 4301, dataDirectory: "/Users/u/Library/Application Support/Fremkit", home: "/Users/u")
        XCTAssertEqual(env["FREMKIT_ROOT"], resources)
        XCTAssertEqual(env["FREMKIT_DATA_DIR"], "/Users/u/Library/Application Support/Fremkit")
        XCTAssertEqual(env["FREMKIT_PORT"], "4301")
        XCTAssertEqual(env["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
        XCTAssertNil(env["NODE_OPTIONS"])
        XCTAssertEqual(env["HOME"], "/Users/u")
        XCTAssertNil(env["FREMKIT_SCANNER"])
    }

    func testBothLaunchesNameTheDiskScannerWhenThereIsOne() {
        let scanner = "/Applications/Fremkit.app/Contents/MacOS/fremkit-scan"
        for launch in [ServerLaunch.checkout(repoPath: "/r"), .bundled(resourcesPath: resources)] {
            let env = launch.environment(inheriting: [:], port: 4242, dataDirectory: "/support",
                                         home: "/Users/u", scanner: scanner)
            XCTAssertEqual(env["FREMKIT_SCANNER"], scanner)
            XCTAssertNil(launch.environment(inheriting: [:], port: 4242, dataDirectory: "/support",
                                            home: "/Users/u", scanner: "")["FREMKIT_SCANNER"])
        }
    }

    func testPassesTheHelpersAccessSecretAndNoOther() {
        let mine = AccessToken.generate()
        for launch in [ServerLaunch.checkout(repoPath: "/r"), .bundled(resourcesPath: resources)] {
            let inherited = ["FREMKIT_ACCESS_TOKEN": AccessToken.generate()]
            let env = launch.environment(inheriting: inherited, port: 4242, dataDirectory: "/support",
                                         home: "/Users/u", accessToken: mine)
            XCTAssertEqual(env["FREMKIT_ACCESS_TOKEN"], mine)
            XCTAssertNil(launch.environment(inheriting: inherited, port: 4242, dataDirectory: "/support",
                                            home: "/Users/u")["FREMKIT_ACCESS_TOKEN"])
            XCTAssertNil(launch.environment(inheriting: [:], port: 4242, dataDirectory: "/support",
                                            home: "/Users/u", accessToken: "weak")["FREMKIT_ACCESS_TOKEN"])
        }
    }
}
