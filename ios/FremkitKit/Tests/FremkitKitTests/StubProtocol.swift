import Foundation

/// A `URLProtocol` that answers from a table keyed by host, so each test uses its own hosts and
/// tests can run side by side. Records every request it sees, body included.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    enum Answer: Sendable {
        case status(Int, String)
        case failure(URLError.Code)
        /// A 302 to `location`.
        case redirect(String)
    }

    struct Seen: Sendable {
        let request: URLRequest
        let body: Data?
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var answers: [String: Answer] = [:]
    nonisolated(unsafe) private static var seen: [String: [Seen]] = [:]

    static func answer(_ host: String, with answer: Answer) {
        lock.withLock { answers[host] = answer }
    }

    static func requests(to host: String) -> [Seen] {
        lock.withLock { seen[host] ?? [] }
    }

    static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host ?? ""
        let body = request.httpBody ?? request.httpBodyStream.map(Self.read)
        let answer = Self.lock.withLock { () -> Answer? in
            Self.seen[host, default: []].append(Seen(request: request, body: body))
            return Self.answers[host]
        }
        switch answer {
        case let .status(code, text)?:
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(text.utf8))
            client?.urlProtocolDidFinishLoading(self)
        case let .redirect(location)?:
            let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1",
                                           headerFields: ["Location": location])!
            var next = request
            next.url = URL(string: location)
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        case let .failure(code)?:
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case nil:
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
        }
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
