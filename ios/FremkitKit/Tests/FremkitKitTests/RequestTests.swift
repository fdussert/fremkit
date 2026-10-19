import XCTest
@testable import FremkitKit

final class HTTPProberTests: XCTestCase {
    private let me = #"{"id":"d1","name":"iPad","screenId":"s1","brightness":{"target":40,"seq":3}}"#

    func testOkOnA200WithTheDeviceRecord() async throws {
        StubProtocol.answer("192.0.2.21", with: .status(200, me))
        let outcome = await HTTPProber(configuration: StubProtocol.configuration).probe(host: "192.0.2.21", port: 4243, mac: sampleMac)
        XCTAssertEqual(outcome, .ok(sampleInfo))

        let seen = try XCTUnwrap(StubProtocol.requests(to: "192.0.2.21").first)
        // `addresses=1`: the app asks for the Mac's other addresses, which the page never does.
        XCTAssertEqual(seen.request.url?.absoluteString, "https://192.0.2.21:4243/api/devices/me?addresses=1")
        XCTAssertEqual(seen.request.httpMethod, "GET")
        XCTAssertEqual(seen.request.value(forHTTPHeaderField: "Cookie"), "fremkit_device=device-token")
        XCTAssertEqual(seen.request.timeoutInterval, 5)
    }

    func testOkWithoutAScreenOrABrightness() async {
        StubProtocol.answer("192.0.2.22", with: .status(200, #"{"id":"d1","name":"iPad","screenId":null,"brightness":null}"#))
        let outcome = await HTTPProber(configuration: StubProtocol.configuration).probe(host: "192.0.2.22", port: 4243, mac: sampleMac)
        XCTAssertEqual(outcome, .ok(DeviceInfo(id: "d1", name: "iPad", screenId: nil, brightness: nil)))
    }

    func testUnauthorizedOnA401() async {
        StubProtocol.answer("192.0.2.23", with: .status(401, #"{"error":"no"}"#))
        let outcome = await HTTPProber(configuration: StubProtocol.configuration).probe(host: "192.0.2.23", port: 4243, mac: sampleMac)
        XCTAssertEqual(outcome, .unauthorized)
    }

    func testUnreachableOnA500() async {
        StubProtocol.answer("192.0.2.24", with: .status(500, "{}"))
        let outcome = await HTTPProber(configuration: StubProtocol.configuration).probe(host: "192.0.2.24", port: 4243, mac: sampleMac)
        XCTAssertEqual(outcome, .unreachable)
    }

    func testUnreachableOnATimeout() async {
        StubProtocol.answer("192.0.2.25", with: .failure(.timedOut))
        let outcome = await HTTPProber(configuration: StubProtocol.configuration).probe(host: "192.0.2.25", port: 4243, mac: sampleMac)
        XCTAssertEqual(outcome, .unreachable)
    }

    func testUnreachableOnA200ThatIsNotADeviceRecord() async {
        StubProtocol.answer("192.0.2.26", with: .status(200, "<html></html>"))
        let outcome = await HTTPProber(configuration: StubProtocol.configuration).probe(host: "192.0.2.26", port: 4243, mac: sampleMac)
        XCTAssertEqual(outcome, .unreachable)
    }

    func testUnreachableOnARedirectItDoesNotFollow() async {
        StubProtocol.answer("192.0.2.28", with: .redirect("https://198.51.100.28:4243/api/devices/me"))
        StubProtocol.answer("198.51.100.28", with: .status(200, me))
        let outcome = await HTTPProber(configuration: StubProtocol.configuration).probe(host: "192.0.2.28", port: 4243, mac: sampleMac)
        XCTAssertEqual(outcome, .unreachable)
        XCTAssertTrue(StubProtocol.requests(to: "198.51.100.28").isEmpty)
    }

    func testPinMismatchWhenThePinRejectsTheKey() async {
        let outcome = await HTTPProber(transport: { _, _ in .pinRejected }).probe(host: "192.0.2.27", port: 4243, mac: sampleMac)
        XCTAssertEqual(outcome, .pinMismatch)
    }

    func testPinsTheMacsKeyForTheProbedHostAndTheMacsOwnNames() async {
        let policies = Recorder<PinPolicy>()
        _ = await HTTPProber(transport: { _, policy in policies.add(policy); return .failed })
            .probe(host: "198.51.100.7", port: 4243, mac: sampleMac)
        XCTAssertEqual(policies.items, [PinPolicy(keyHash: SPKIFixture.keyHash, hosts: ["198.51.100.7", "studio.local", "192.0.2.10"])])
    }

    func testBracketsAnIPv6Host() {
        XCTAssertEqual(Endpoint.url(host: "2001:db8::1", port: 4243, path: "/api/devices/me")?.absoluteString,
                       "https://[2001:db8::1]:4243/api/devices/me")
        XCTAssertEqual(Endpoint.url(host: "fe80::1%en0", port: 4243, path: "/x")?.absoluteString, "https://[fe80::1%25en0]:4243/x")
        XCTAssertEqual(Endpoint.url(host: "studio.local", port: 4243, path: "/x")?.absoluteString, "https://studio.local:4243/x")
    }
}

final class Recorder<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [T] = []
    func add(_ item: T) { lock.withLock { stored.append(item) } }
    var items: [T] { lock.withLock { stored } }
}

final class PairClientTests: XCTestCase {
    private let viewport = Viewport(width: 1180, height: 820)

    private func pair(_ client: PairClient, hosts: [String]) async throws -> PairedMac {
        try await client.pair(hosts: hosts, port: 4243, keyHash: SPKIFixture.keyHash, code: "ABCDEFGH", name: "iPad",
                              viewport: viewport, macName: "studio")
    }

    func testPairsAndBuildsTheRecord() async throws {
        StubProtocol.answer("192.0.2.31", with: .status(200, #"{"token":"tok-1","deviceId":"d9"}"#))
        let mac = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: ["studio.local", "192.0.2.31"])
        XCTAssertEqual(mac, PairedMac(host: "studio.local", address: "192.0.2.31", port: 4243, keyHash: SPKIFixture.keyHash,
                                      token: "tok-1", deviceId: "d9", name: "studio"))

        let seen = try XCTUnwrap(StubProtocol.requests(to: "192.0.2.31").first)
        XCTAssertEqual(seen.request.url?.absoluteString, "https://192.0.2.31:4243/api/pair")
        XCTAssertEqual(seen.request.httpMethod, "POST")
        XCTAssertEqual(seen.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(seen.body)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        // The code goes as its proof for the pinned key, never as itself.
        XCTAssertEqual(json["proof"] as? String, CodeProof.proof(code: "ABCDEFGH", keyHash: SPKIFixture.keyHash))
        XCTAssertNil(json["code"])
        XCTAssertFalse(String(decoding: body, as: UTF8.self).contains("ABCDEFGH"))
        XCTAssertNil(json["secret"], "no secret, no field")
        XCTAssertEqual(json["name"] as? String, "iPad")
        XCTAssertEqual(json["viewport"] as? [String: Int], ["width": 1180, "height": 820])
    }

    func testSendsTheSecretInsteadOfTheCode() async throws {
        let secret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
        let bodies = Recorder<Data>()
        let client = PairClient(transport: { request, _ in
            if let body = request.httpBody { bodies.add(body) }
            return .response(status: 200, body: Data(#"{"token":"t","deviceId":"d"}"#.utf8))
        })
        _ = try await client.pair(hosts: ["192.0.2.35"], port: 4243, keyHash: SPKIFixture.keyHash, code: "ABCDEFGH",
                                  secret: secret, name: "iPad", viewport: viewport, macName: "studio")
        let body = try XCTUnwrap(bodies.items.first)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["secret"] as? String, secret)
        XCTAssertNil(json["proof"], "the Mac takes one or the other, never both")
        XCTAssertNil(json["code"])
        XCTAssertEqual(json["name"] as? String, "iPad")
    }

    func testKeepsTheLinksAddressWhenTheNameAnswers() async throws {
        let client = PairClient(transport: { request, _ in
            request.url?.host == "studio.local" ? .response(status: 200, body: Data(#"{"token":"t","deviceId":"d"}"#.utf8)) : .failed
        })
        let mac = try await pair(client, hosts: ["studio.local", "192.0.2.32"])
        XCTAssertEqual(mac.host, "studio.local")
        XCTAssertEqual(mac.address, "192.0.2.32")
    }

    func testRejectedCarriesTheServersMessage() async {
        StubProtocol.answer("192.0.2.33", with: .status(403, #"{"error":"Code expiré"}"#))
        do {
            _ = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: ["192.0.2.33"])
            XCTFail("paired")
        } catch {
            XCTAssertEqual(error as? PairError, .rejected("Code expiré"))
        }
    }

    func testLimitedCarriesTheServersMessage() async {
        StubProtocol.answer("192.0.2.34", with: .status(429, #"{"error":"Too many tries"}"#))
        do {
            _ = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: ["192.0.2.34"])
            XCTFail("paired")
        } catch {
            XCTAssertEqual(error as? PairError, .limited("Too many tries"))
        }
    }

    func testA429OnOneAddressTriesTheNext() async throws {
        StubProtocol.answer("192.0.2.45", with: .status(429, #"{"error":"Too many tries"}"#))
        StubProtocol.answer("192.0.2.46", with: .status(200, #"{"token":"t","deviceId":"d"}"#))
        let mac = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: ["192.0.2.45", "192.0.2.46"])
        XCTAssertEqual(mac.token, "t")
        XCTAssertEqual(StubProtocol.requests(to: "192.0.2.46").count, 1)
    }

    func testLimitedOnlyWhenNoAddressPairs() async {
        StubProtocol.answer("192.0.2.47", with: .status(429, #"{"error":"Too many tries"}"#))
        StubProtocol.answer("192.0.2.48", with: .status(429, #"{"error":"Trop d’essais"}"#))
        StubProtocol.answer("192.0.2.49", with: .failure(.timedOut))
        for hosts in [["192.0.2.47", "192.0.2.48"], ["192.0.2.47", "192.0.2.49"], ["192.0.2.49", "192.0.2.47"]] {
            do {
                _ = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: hosts)
                XCTFail("paired")
            } catch {
                XCTAssertEqual(error as? PairError, .limited("Too many tries"), "\(hosts)")
            }
        }
    }

    func testARefusedCodeStillStopsAtOnce() async {
        StubProtocol.answer("192.0.2.50", with: .status(429, #"{"error":"Too many tries"}"#))
        StubProtocol.answer("192.0.2.51", with: .status(403, #"{"error":"Wrong code"}"#))
        StubProtocol.answer("192.0.2.52", with: .status(200, #"{"token":"t","deviceId":"d"}"#))
        do {
            _ = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: ["192.0.2.50", "192.0.2.51", "192.0.2.52"])
            XCTFail("paired")
        } catch {
            XCTAssertEqual(error as? PairError, .rejected("Wrong code"))
        }
        XCTAssertEqual(StubProtocol.requests(to: "192.0.2.52").count, 0)
    }

    func testNoCodeWhenTheMacAnswers404() async {
        StubProtocol.answer("192.0.2.44", with: .status(404, #"{"statusCode":404,"error":"Not Found"}"#))
        do {
            _ = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: ["192.0.2.44"])
            XCTFail("paired")
        } catch {
            XCTAssertEqual(error as? PairError, .noCode)
        }
    }

    func testUnreachableWhenNoHostAnswers() async {
        StubProtocol.answer("192.0.2.35", with: .failure(.timedOut))
        do {
            _ = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: ["192.0.2.35", "192.0.2.36"])
            XCTFail("paired")
        } catch {
            XCTAssertEqual(error as? PairError, .unreachable)
        }
        XCTAssertEqual(StubProtocol.requests(to: "192.0.2.36").count, 1)
    }

    func testWrongMacWhenAHostFailsThePinAndNoneAnswers() async {
        let client = PairClient(transport: { request, _ in request.url?.host == "studio.local" ? .pinRejected : .failed })
        do {
            _ = try await pair(client, hosts: ["studio.local", "192.0.2.37"])
            XCTFail("paired")
        } catch {
            XCTAssertEqual(error as? PairError, .wrongMac)
        }
    }

    func testMovesPastAWrongMacToTheRightOne() async throws {
        let client = PairClient(transport: { request, _ in
            switch request.url?.host {
            case "studio.local": .failed
            case "192.0.2.38": .pinRejected
            default: .response(status: 200, body: Data(#"{"token":"t","deviceId":"d"}"#.utf8))
            }
        })
        let mac = try await pair(client, hosts: ["studio.local", "192.0.2.38", "198.51.100.38"])
        XCTAssertEqual(mac.address, "198.51.100.38")
        XCTAssertEqual(mac.host, "studio.local")
    }

    func testPinsEveryHostItTries() async {
        let policies = Recorder<PinPolicy>()
        _ = try? await pair(PairClient(transport: { _, policy in policies.add(policy); return .failed }), hosts: ["studio.local", "192.0.2.39"])
        XCTAssertEqual(policies.items.map(\.keyHash), [SPKIFixture.keyHash, SPKIFixture.keyHash])
        XCTAssertEqual(policies.items.first?.hosts, ["studio.local", "192.0.2.39"])
    }

    func testErrorsCarryOnlyTheServersMessage() async {
        let secret = "tok-secret-0451"
        StubProtocol.answer("192.0.2.40", with: .status(403, #"{"error":"Wrong code","token":"\#(secret)","deviceId":"d"}"#))
        StubProtocol.answer("192.0.2.41", with: .status(429, #"{"token":"\#(secret)","error":"Too many tries"}"#))
        for (host, expected) in [("192.0.2.40", PairError.rejected("Wrong code")), ("192.0.2.41", .limited("Too many tries"))] {
            do {
                _ = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: [host])
                XCTFail("paired")
            } catch {
                XCTAssertEqual(error as? PairError, expected)
                XCTAssertFalse("\(error)".contains(secret))
                XCTAssertFalse(String(reflecting: error).contains(secret))
            }
        }
    }

    func testDropsATrailingDotFromTheMacsName() async throws {
        StubProtocol.answer("192.0.2.42", with: .status(200, #"{"token":"t","deviceId":"d"}"#))
        let policies = Recorder<PinPolicy>()
        let client = PairClient(transport: { request, policy in
            policies.add(policy)
            return await PinnedTransport.send(request, policy: policy, configuration: StubProtocol.configuration)
        })
        let mac = try await pair(client, hosts: ["Studio.local.", "192.0.2.42"])
        XCTAssertEqual(mac.host, "Studio.local")
        XCTAssertEqual(policies.items.first?.hosts, ["Studio.local", "192.0.2.42"])
    }

    func testRefusesARedirect() async {
        StubProtocol.answer("192.0.2.43", with: .redirect("https://198.51.100.43:4243/api/pair"))
        StubProtocol.answer("198.51.100.43", with: .status(200, #"{"token":"t","deviceId":"d"}"#))
        do {
            _ = try await pair(PairClient(configuration: StubProtocol.configuration), hosts: ["192.0.2.43"])
            XCTFail("followed the redirect")
        } catch {
            XCTAssertEqual(error as? PairError, .unreachable)
        }
        XCTAssertTrue(StubProtocol.requests(to: "198.51.100.43").isEmpty)
    }

    func testPolicyPrintingNeverShowsThePin() {
        let policy = PinPolicy(keyHash: SPKIFixture.keyHash, hosts: ["studio.local"])
        var dumped = ""
        dump(policy, to: &dumped)
        let text = "\(policy) \(String(reflecting: policy)) \(dumped)"
        XCTAssertFalse(text.contains(SPKIFixture.keyHash))
        XCTAssertTrue(text.contains("studio.local"))
    }

    func testViewportClampsToTheServersBounds() {
        XCTAssertEqual(Viewport(width: 0, height: 20000), Viewport(width: 1, height: 10000))
    }
}

final class BrightnessReporterTests: XCTestCase {
    func testBuildsTheReportRequest() throws {
        let reporter = BrightnessReporter(mac: sampleMac, host: "192.0.2.10")
        let request = try XCTUnwrap(reporter.request(brightness: 0.426, applied: 7))
        XCTAssertEqual(request.url?.absoluteString, "https://192.0.2.10:4243/api/devices/me/brightness")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "fremkit_device=device-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Int])
        XCTAssertEqual(json, ["value": 43, "applied": 7])
    }

    func testOmitsAppliedWhenNothingWasApplied() throws {
        let request = try XCTUnwrap(BrightnessReporter(mac: sampleMac, host: "studio.local").request(brightness: 1, applied: nil))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Int])
        XCTAssertEqual(json, ["value": 100])
    }

    func testClampsTheValue() {
        XCTAssertEqual(BrightnessReporter.value(for: -0.2), 0)
        XCTAssertEqual(BrightnessReporter.value(for: 1.7), 100)
        XCTAssertEqual(BrightnessReporter.value(for: 0.005), 1)
        XCTAssertEqual(BrightnessReporter.value(for: .nan), 0)
    }
}
