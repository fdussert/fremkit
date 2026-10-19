// Registry of the brightness tests, kept apart from main.swift like ScanSuites.swift so branches
// adding suites do not touch the same lines. Every test method is listed; scripts/test-helper.sh
// counts the entries of every file in this folder.

import XCTest

let brightnessSuites: [(String, () -> XCTestCase, [TestMethod])] = [
    ("DDCTests", { DDCTests() }, [
        ("testGetRequestMatchesTheProbe", { ($0 as! DDCTests).testGetRequestMatchesTheProbe() }),
        ("testSetRequestCarriesTheValueBigEndianWithItsChecksum", { ($0 as! DDCTests).testSetRequestCarriesTheValueBigEndianWithItsChecksum() }),
        ("testParsesTheEdgeReply", { ($0 as! DDCTests).testParsesTheEdgeReply() }),
        ("testANullMessageIsNotReady", { ($0 as! DDCTests).testANullMessageIsNotReady() }),
        ("testRefusesAGarbledOrForeignReply", { ($0 as! DDCTests).testRefusesAGarbledOrForeignReply() }),
        ("testAnUnsupportedCodeIsSaidSo", { ($0 as! DDCTests).testAnUnsupportedCodeIsSaidSo() }),
        ("testConvertsBetweenPercentAndRaw", { ($0 as! DDCTests).testConvertsBetweenPercentAndRaw() }),
    ]),
    ("DDCMatcherTests", { DDCMatcherTests() }, [
        ("testMatchesByFramebufferLocation", { ($0 as! DDCMatcherTests).testMatchesByFramebufferLocation() }),
        ("testTwinsWithoutLocationOrSerialAreAmbiguous", { ($0 as! DDCMatcherTests).testTwinsWithoutLocationOrSerialAreAmbiguous() }),
        ("testFallsBackToTheSerialWhenTheLocationIsUnknown", { ($0 as! DDCMatcherTests).testFallsBackToTheSerialWhenTheLocationIsUnknown() }),
        ("testAKnownLocationWithNoServiceUnderItMatchesNothing", { ($0 as! DDCMatcherTests).testAKnownLocationWithNoServiceUnderItMatchesNothing() }),
    ]),
    ("BrightnessThrottleTests", { BrightnessThrottleTests() }, [
        ("testFirstValueGoesOutAtOnceAndTheLastOfABurstAfterTheInterval", { ($0 as! BrightnessThrottleTests).testFirstValueGoesOutAtOnceAndTheLastOfABurstAfterTheInterval() }),
        ("testAValueAfterAQuietSpellGoesOutAtOnce", { ($0 as! BrightnessThrottleTests).testAValueAfterAQuietSpellGoesOutAtOnce() }),
    ]),
    ("BrightnessChannelTests", { BrightnessChannelTests() }, [
        ("testReadsTheKiosksDirective", { ($0 as! BrightnessChannelTests).testReadsTheKiosksDirective() }),
        ("testANullTargetMeansLeaveItAlone", { ($0 as! BrightnessChannelTests).testANullTargetMeansLeaveItAlone() }),
        ("testIgnoresOtherMessages", { ($0 as! BrightnessChannelTests).testIgnoresOtherMessages() }),
        ("testBuildsAReportTheServerAccepts", { ($0 as! BrightnessChannelTests).testBuildsAReportTheServerAccepts() }),
        ("testSetMessageClampsTheLevel", { ($0 as! BrightnessChannelTests).testSetMessageClampsTheLevel() }),
        ("testReadsTheScreenFromTheKioskURL", { ($0 as! BrightnessChannelTests).testReadsTheScreenFromTheKioskURL() }),
    ]),
]
