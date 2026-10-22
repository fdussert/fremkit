import Darwin
import Foundation
import XCTest
@testable import FremkitCore

final class ProcArgsTests: XCTestCase {
    func testProcargsCommandParsesAPid() throws {
        let procargs = try ScanCommand.parse(["procargs", "123"])
        XCTAssertEqual(procargs, .procargs(123))
        let disk = try ScanCommand.parse(["/Users/example"])
        let expected = try DiskScanArguments.parse(["/Users/example"])
        XCTAssertEqual(disk, .disk(expected))
    }

    func testProcargsCommandRefusesABadPid() {
        XCTAssertThrowsError(try ScanCommand.parse(["procargs"]))
        XCTAssertThrowsError(try ScanCommand.parse(["procargs", "x"]))
        XCTAssertThrowsError(try ScanCommand.parse(["procargs", "0"]))
        XCTAssertThrowsError(try ScanCommand.parse(["procargs", "-5"]))
        XCTAssertThrowsError(try ScanCommand.parse(["procargs", "99999999999"]))
        XCTAssertThrowsError(try ScanCommand.parse(["procargs", "1", "2"]))
    }

    func testReadsTheCurrentProcess() throws {
        let args = try ProcArgs.read(pid: getpid())
        XCTAssertFalse(args.argv.first?.isEmpty ?? true)
        XCTAssertTrue(args.exe.hasPrefix("/"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: args.exe))
        XCTAssertEqual(args.env["PATH"], ProcessInfo.processInfo.environment["PATH"])
    }

    func testAnArgumentWithASpaceStaysOneElement() throws {
        // The kernel hides the environment of Apple's own platform binaries (/bin/sh included), so the
        // child is a re-signed copy of the shell, which is an ordinary program as far as it goes.
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("procargs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let shell = folder.appendingPathComponent("sh")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/bin/sh"), to: shell)
        let sign = Process()
        sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        sign.arguments = ["--force", "--sign", "-", shell.path]
        sign.standardError = FileHandle.nullDevice
        try sign.run()
        sign.waitUntilExit()
        XCTAssertEqual(sign.terminationStatus, 0)

        let child = Process()
        child.executableURL = shell
        // The trailing ":" keeps the shell from exec-ing sleep directly, so its own argv stays visible.
        child.arguments = ["-c", "sleep 5; :", "a b"]
        child.environment = ["PATH": "/usr/bin:/bin", "FREMKIT_TEST_VAR": "x=y z"]
        try child.run()
        defer { child.terminate(); child.waitUntilExit() }
        let args = try ProcArgs.read(pid: child.processIdentifier)
        XCTAssertEqual(Array(args.argv.dropFirst()), ["-c", "sleep 5; :", "a b"])
        XCTAssertEqual(args.env["FREMKIT_TEST_VAR"], "x=y z")
        XCTAssertEqual(args.env["PATH"], "/usr/bin:/bin")
    }

    func testAMissingProcessThrows() {
        XCTAssertThrowsError(try ProcArgs.read(pid: 999_999)) { error in
            XCTAssertEqual(error as? ProcArgsError, .noSuchProcess)
        }
    }

    func testAProcessOfAnotherUserIsDenied() {
        // launchd (pid 1) belongs to root; nothing to prove when the tests themselves run as root.
        guard getuid() != 0 else { return }
        XCTAssertThrowsError(try ProcArgs.read(pid: 1)) { error in
            XCTAssertEqual(error as? ProcArgsError, .denied)
        }
    }

    func testTheOutputLineEscapesAndKeepsTheShape() throws {
        let line = ProcArgs(exe: "/bin/x", argv: ["x", "a \"b\""], env: ["K": "v"]).jsonLine
        XCTAssertEqual(line, "{\"type\":\"procargs\",\"exe\":\"/bin/x\",\"argv\":[\"x\",\"a \\\"b\\\"\"],\"env\":{\"K\":\"v\"}}")
        XCTAssertEqual(ProcArgsError.denied.jsonLine, "{\"type\":\"error\",\"code\":\"denied\"}")
        XCTAssertEqual(ProcArgsError.noSuchProcess.jsonLine, "{\"type\":\"error\",\"code\":\"no-such-process\"}")
    }
}
