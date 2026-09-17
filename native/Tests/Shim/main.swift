// Explicit runner for the FremkitCore tests: no runtime discovery, every test method
// is listed here. Compiled together with the test files, so it can reach them directly.
//
// EVERY NEW TEST METHOD MUST BE REGISTERED HERE, or it is simply never run.
// `scripts/test-helper.sh` compares the number of `func test` declarations in
// native/Tests/FremkitCoreTests with the number of entries below and fails on a mismatch.

import Foundation
import XCTest

typealias TestMethod = (String, (XCTestCase) throws -> Void)

let suites: [(String, () -> XCTestCase, [TestMethod])] = [
    ("TouchReportTests", { TouchReportTests() }, [
        ("testParsesCapturedDownReport", { ($0 as! TouchReportTests).testParsesCapturedDownReport() }),
        ("testParsesUpReportAtMaximumCoordinates", { ($0 as! TouchReportTests).testParsesUpReportAtMaximumCoordinates() }),
        ("testRejectsOtherReportID", { ($0 as! TouchReportTests).testRejectsOtherReportID() }),
        ("testRejectsShortReport", { ($0 as! TouchReportTests).testRejectsShortReport() }),
        ("testAcceptsLongerReport", { ($0 as! TouchReportTests).testAcceptsLongerReport() }),
        ("testEmptyReportIsRejected", { ($0 as! TouchReportTests).testEmptyReportIsRejected() }),
        ("testConstants", { ($0 as! TouchReportTests).testConstants() }),
    ]),
    ("DisplayMapperTests", { DisplayMapperTests() }, [
        ("testMapsOriginCorner", { ($0 as! DisplayMapperTests).testMapsOriginCorner() }),
        ("testMapsOppositeCorner", { ($0 as! DisplayMapperTests).testMapsOppositeCorner() }),
        ("testMapsCentreWithinOnePoint", { ($0 as! DisplayMapperTests).testMapsCentreWithinOnePoint() }),
        ("testClampsOutOfRangeInput", { ($0 as! DisplayMapperTests).testClampsOutOfRangeInput() }),
        ("testBoundsAreExposed", { ($0 as! DisplayMapperTests).testBoundsAreExposed() }),
    ]),
    ("GestureEngineTests", { GestureEngineTests() }, [
        ("testTap", { ($0 as! GestureEngineTests).testTap() }),
        ("testDoubleTap", { ($0 as! GestureEngineTests).testDoubleTap() }),
        ("testTwoTapsFarApartInTimeAreTwoSingleTaps", { ($0 as! GestureEngineTests).testTwoTapsFarApartInTimeAreTwoSingleTaps() }),
        ("testScroll", { ($0 as! GestureEngineTests).testScroll() }),
        ("testScrollGestureEndsWithRestoreCursor", { ($0 as! GestureEngineTests).testScrollGestureEndsWithRestoreCursor() }),
        ("testScrollEmitsDeltaSincePreviousSample", { ($0 as! GestureEngineTests).testScrollEmitsDeltaSincePreviousSample() }),
        ("testDragAfterHold", { ($0 as! GestureEngineTests).testDragAfterHold() }),
        ("testLongPress", { ($0 as! GestureEngineTests).testLongPress() }),
        ("testHoldReleasedBeforeLongPressIsATap", { ($0 as! GestureEngineTests).testHoldReleasedBeforeLongPressIsATap() }),
        ("testJitterBelowThresholdEmitsNothing", { ($0 as! GestureEngineTests).testJitterBelowThresholdEmitsNothing() }),
        ("testTwoTapsFarApartInSpaceAreTwoSingleTaps", { ($0 as! GestureEngineTests).testTwoTapsFarApartInSpaceAreTwoSingleTaps() }),
    ]),
    ("FenceMathTests", { FenceMathTests() }, [
        ("testPointOutsideEdgeIsLeftAlone", { ($0 as! FenceMathTests).testPointOutsideEdgeIsLeftAlone() }),
        ("testPointInsideEdgeReturnsLastKnownOutsidePosition", { ($0 as! FenceMathTests).testPointInsideEdgeReturnsLastKnownOutsidePosition() }),
        ("testLastPositionInsideEdgeIsIgnoredAndTheEdgeIsProjected", { ($0 as! FenceMathTests).testLastPositionInsideEdgeIsIgnoredAndTheEdgeIsProjected() }),
        ("testProjectionOnNearestEdgeWithoutLastPosition", { ($0 as! FenceMathTests).testProjectionOnNearestEdgeWithoutLastPosition() }),
        ("testFallbackLandsInsideTheSafeRectangleWithTheRealLayout", { ($0 as! FenceMathTests).testFallbackLandsInsideTheSafeRectangleWithTheRealLayout() }),
        ("testCornerTieBreakPrefersTheLeftSide", { ($0 as! FenceMathTests).testCornerTieBreakPrefersTheLeftSide() }),
    ]),
    ("HelperConfigTests", { HelperConfigTests() }, [
        ("testDefaults", { ($0 as! HelperConfigTests).testDefaults() }),
        ("testScrollInvertDecodesAndDefaultsToFalseWhenAbsent", { try ($0 as! HelperConfigTests).testScrollInvertDecodesAndDefaultsToFalseWhenAbsent() }),
        ("testDockDecodesAndDefaultsToTrueWhenAbsent", { try ($0 as! HelperConfigTests).testDockDecodesAndDefaultsToTrueWhenAbsent() }),
        ("testMissingFileFallsBackToDefaults", { ($0 as! HelperConfigTests).testMissingFileFallsBackToDefaults() }),
        ("testPartialJSONKeepsDefaultsForMissingFields", { try ($0 as! HelperConfigTests).testPartialJSONKeepsDefaultsForMissingFields() }),
        ("testPartialDisplayKeepsTheOtherDimension", { try ($0 as! HelperConfigTests).testPartialDisplayKeepsTheOtherDimension() }),
        ("testCorruptFileFallsBackToDefaults", { try ($0 as! HelperConfigTests).testCorruptFileFallsBackToDefaults() }),
        ("testSaveThenLoadRoundTrips", { try ($0 as! HelperConfigTests).testSaveThenLoadRoundTrips() }),
        ("testSaveOverwritesAnExistingFile", { try ($0 as! HelperConfigTests).testSaveOverwritesAnExistingFile() }),
        ("testDefaultURL", { ($0 as! HelperConfigTests).testDefaultURL() }),
    ]),
    ("DockBadgeParserTests", { DockBadgeParserTests() }, [
        ("testKeepsTheDockOrderAndReadsEveryField", { ($0 as! DockBadgeParserTests).testKeepsTheDockOrderAndReadsEveryField() }),
        ("testDropsAnItemWithoutABundleIdentifier", { ($0 as! DockBadgeParserTests).testDropsAnItemWithoutABundleIdentifier() }),
        ("testDropsAnItemWithAnEmptyBundleIdentifier", { ($0 as! DockBadgeParserTests).testDropsAnItemWithAnEmptyBundleIdentifier() }),
        ("testFallsBackToTheBundleIdentifierWhenThereIsNoTitle", { ($0 as! DockBadgeParserTests).testFallsBackToTheBundleIdentifierWhenThereIsNoTitle() }),
        ("testTrimsTheBadgeAndTreatsAnEmptyOneAsAbsent", { ($0 as! DockBadgeParserTests).testTrimsTheBadgeAndTreatsAnEmptyOneAsAbsent() }),
        ("testKeepsANonNumericBadgeAsIs", { ($0 as! DockBadgeParserTests).testKeepsANonNumericBadgeAsIs() }),
        ("testKeepsOnlyTheFirstItemOfADuplicatedBundle", { ($0 as! DockBadgeParserTests).testKeepsOnlyTheFirstItemOfADuplicatedBundle() }),
        ("testSignatureChangesWithTheBadgeAndWithTheRunningFlag", { ($0 as! DockBadgeParserTests).testSignatureChangesWithTheBadgeAndWithTheRunningFlag() }),
        ("testSignatureIgnoresTheDisplayNameOnly", { ($0 as! DockBadgeParserTests).testSignatureIgnoresTheDisplayNameOnly() }),
    ]),
    ("AdminPlacementTests", { AdminPlacementTests() }, [
        ("testAFrameOnTheLaptopIsLeftAlone", { ($0 as! AdminPlacementTests).testAFrameOnTheLaptopIsLeftAlone() }),
        ("testAFrameOnTheKioskDisplayIsMovedToTheLaptop", { ($0 as! AdminPlacementTests).testAFrameOnTheKioskDisplayIsMovedToTheLaptop() }),
        ("testAFrameOverlappingTheKioskEvenSlightlyIsMoved", { ($0 as! AdminPlacementTests).testAFrameOverlappingTheKioskEvenSlightlyIsMoved() }),
        ("testAFrameOnNoScreenAtAllIsMoved", { ($0 as! AdminPlacementTests).testAFrameOnNoScreenAtAllIsMoved() }),
        ("testAFrameBarelyOnScreenIsMoved", { ($0 as! AdminPlacementTests).testAFrameBarelyOnScreenIsMoved() }),
        ("testWithoutAnEdgeDisplayOnlyTheScreensMatter", { ($0 as! AdminPlacementTests).testWithoutAnEdgeDisplayOnlyTheScreensMatter() }),
        ("testTargetSkipsTheKioskScreenAndKeepsAppKitOrder", { ($0 as! AdminPlacementTests).testTargetSkipsTheKioskScreenAndKeepsAppKitOrder() }),
        ("testAMacWhoseOnlyScreenIsTheEdgeIsLeftAlone", { ($0 as! AdminPlacementTests).testAMacWhoseOnlyScreenIsTheEdgeIsLeftAlone() }),
        ("testCentringShrinksToFitAndRoundsToWholePoints", { ($0 as! AdminPlacementTests).testCentringShrinksToFitAndRoundsToWholePoints() }),
    ]),
    ("HelperURLTests", { HelperURLTests() }, [
        ("testAdminHostOpensTheAdmin", { ($0 as! HelperURLTests).testAdminHostOpensTheAdmin() }),
        ("testTargetIsCaseInsensitiveAndIgnoresPathAndQuery", { ($0 as! HelperURLTests).testTargetIsCaseInsensitiveAndIgnoresPathAndQuery() }),
        ("testHostlessSpellingIsAccepted", { ($0 as! HelperURLTests).testHostlessSpellingIsAccepted() }),
        ("testAnotherSchemeIsIgnored", { ($0 as! HelperURLTests).testAnotherSchemeIsIgnored() }),
        ("testUnknownTargetIsIgnored", { ($0 as! HelperURLTests).testUnknownTargetIsIgnored() }),
    ]),
    ("L10nTests", { L10nTests() }, [
        ("testPicksFrenchForAFrenchSystem", { ($0 as! L10nTests).testPicksFrenchForAFrenchSystem() }),
        ("testPicksEnglishForEverythingElse", { ($0 as! L10nTests).testPicksEnglishForEverythingElse() }),
        ("testEveryKeyIsWrittenInBothLanguages", { ($0 as! L10nTests).testEveryKeyIsWrittenInBothLanguages() }),
        ("testFormatsTheValuesThatCarryOne", { ($0 as! L10nTests).testFormatsTheValuesThatCarryOne() }),
    ]),
]

var passed = 0
var failed = 0

for (suiteName, make, methods) in suites {
    for (methodName, run) in methods {
        let name = "\(suiteName).\(methodName)"
        _ = TestReport.shared.drain()
        let instance = make()
        var thrown: Error?
        do {
            try instance.setUpWithError()
            instance.setUp()
            try run(instance)
            instance.tearDown()
            try instance.tearDownWithError()
        } catch {
            thrown = error
        }
        var failures = TestReport.shared.drain()
        if let thrown, failures.isEmpty {
            failures.append(TestFailure(message: "threw \(thrown)", file: "<runner>", line: 0))
        }
        if failures.isEmpty {
            passed += 1
            print("PASS \(name)")
        } else {
            failed += 1
            for failure in failures {
                print("FAIL \(name): \(failure.message) @\(failure.file):\(failure.line)")
            }
        }
    }
}

print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
