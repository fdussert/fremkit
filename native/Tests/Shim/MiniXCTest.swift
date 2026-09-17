// Minimal stand-in for Apple's XCTest, compiled as a module named XCTest.
//
// The Command Line Tools on this machine ship no XCTest.framework and SwiftPM is broken,
// so the committed XCTest-syntax tests are linked against this instead. Assertions record
// failures into a global report rather than aborting, so a whole suite runs in one pass.

// Apple's XCTest re-exports Foundation; mirror that so test files that rely on it
// (TimeInterval, URL, FileManager...) compile here exactly as they would there.
@_exported import Foundation

/// One recorded assertion failure.
public struct TestFailure {
    public let message: String
    public let file: String
    public let line: UInt

    public init(message: String, file: String, line: UInt) {
        self.message = message
        self.file = file
        self.line = line
    }
}

/// Collects the failures of the test currently running.
public final class TestReport {
    public static let shared = TestReport()

    private(set) public var failures: [TestFailure] = []

    private init() {}

    public func record(_ message: String, file: StaticString, line: UInt) {
        failures.append(TestFailure(message: message, file: "\(file)", line: line))
    }

    /// Clears the buffer and returns what it held, so the runner can report per test.
    public func drain() -> [TestFailure] {
        let collected = failures
        failures = []
        return collected
    }
}

/// Base class of a test suite, mirroring the hooks the Fremkit tests use.
open class XCTestCase {
    public init() {}
    open func setUp() {}
    open func tearDown() {}
    open func setUpWithError() throws {}
    open func tearDownWithError() throws {}
}

/// Thrown by XCTUnwrap when the value is nil.
public struct XCTestUnwrapError: Error, CustomStringConvertible {
    public let description: String
}

private func record(_ message: String,
                    _ custom: String,
                    _ file: StaticString,
                    _ line: UInt) {
    let suffix = custom.isEmpty ? "" : " - \(custom)"
    TestReport.shared.record(message + suffix, file: file, line: line)
}

public func XCTFail(_ message: String = "",
                    file: StaticString = #filePath,
                    line: UInt = #line) {
    record("failed", message, file, line)
}

public func XCTAssertTrue(_ expression: @autoclosure () throws -> Bool,
                          _ message: @autoclosure () -> String = "",
                          file: StaticString = #filePath,
                          line: UInt = #line) rethrows {
    if try !expression() { record("XCTAssertTrue failed", message(), file, line) }
}

public func XCTAssertFalse(_ expression: @autoclosure () throws -> Bool,
                           _ message: @autoclosure () -> String = "",
                           file: StaticString = #filePath,
                           line: UInt = #line) rethrows {
    if try expression() { record("XCTAssertFalse failed", message(), file, line) }
}

public func XCTAssertEqual<T: Equatable>(_ expression1: @autoclosure () throws -> T,
                                         _ expression2: @autoclosure () throws -> T,
                                         _ message: @autoclosure () -> String = "",
                                         file: StaticString = #filePath,
                                         line: UInt = #line) rethrows {
    let lhs = try expression1(), rhs = try expression2()
    if lhs != rhs {
        record("XCTAssertEqual failed: (\"\(lhs)\") is not equal to (\"\(rhs)\")", message(), file, line)
    }
}

public func XCTAssertEqual<T: FloatingPoint>(_ expression1: @autoclosure () throws -> T,
                                             _ expression2: @autoclosure () throws -> T,
                                             accuracy: T,
                                             _ message: @autoclosure () -> String = "",
                                             file: StaticString = #filePath,
                                             line: UInt = #line) rethrows {
    let lhs = try expression1(), rhs = try expression2()
    if !(abs(lhs - rhs) <= accuracy) {
        record("XCTAssertEqual failed: (\"\(lhs)\") is not equal to (\"\(rhs)\") +/- (\"\(accuracy)\")",
               message(), file, line)
    }
}

public func XCTAssertNotEqual<T: Equatable>(_ expression1: @autoclosure () throws -> T,
                                            _ expression2: @autoclosure () throws -> T,
                                            _ message: @autoclosure () -> String = "",
                                            file: StaticString = #filePath,
                                            line: UInt = #line) rethrows {
    let lhs = try expression1(), rhs = try expression2()
    if lhs == rhs {
        record("XCTAssertNotEqual failed: (\"\(lhs)\") is equal to (\"\(rhs)\")", message(), file, line)
    }
}

public func XCTAssertNil(_ expression: @autoclosure () throws -> Any?,
                         _ message: @autoclosure () -> String = "",
                         file: StaticString = #filePath,
                         line: UInt = #line) rethrows {
    if let value = try expression() {
        record("XCTAssertNil failed: value is (\"\(value)\")", message(), file, line)
    }
}

public func XCTAssertNotNil(_ expression: @autoclosure () throws -> Any?,
                            _ message: @autoclosure () -> String = "",
                            file: StaticString = #filePath,
                            line: UInt = #line) rethrows {
    if try expression() == nil { record("XCTAssertNotNil failed", message(), file, line) }
}

public func XCTAssertNoThrow<T>(_ expression: @autoclosure () throws -> T,
                                _ message: @autoclosure () -> String = "",
                                file: StaticString = #filePath,
                                line: UInt = #line) {
    do {
        _ = try expression()
    } catch {
        record("XCTAssertNoThrow failed: threw \(error)", message(), file, line)
    }
}

public func XCTAssertThrowsError<T>(_ expression: @autoclosure () throws -> T,
                                    _ message: @autoclosure () -> String = "",
                                    file: StaticString = #filePath,
                                    line: UInt = #line,
                                    _ errorHandler: (Error) -> Void = { _ in }) {
    do {
        _ = try expression()
        record("XCTAssertThrowsError failed: did not throw", message(), file, line)
    } catch {
        errorHandler(error)
    }
}

public func XCTUnwrap<T>(_ expression: @autoclosure () throws -> T?,
                         _ message: @autoclosure () -> String = "",
                         file: StaticString = #filePath,
                         line: UInt = #line) throws -> T {
    guard let value = try expression() else {
        record("XCTUnwrap failed: value is nil", message(), file, line)
        throw XCTestUnwrapError(description: "XCTUnwrap failed at \(file):\(line)")
    }
    return value
}
