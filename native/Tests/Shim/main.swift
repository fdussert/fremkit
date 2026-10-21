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
        ("testCancelReleasesDragAndStartsNextTouchAsFreshGesture", { ($0 as! GestureEngineTests).testCancelReleasesDragAndStartsNextTouchAsFreshGesture() }),
        ("testLongPress", { ($0 as! GestureEngineTests).testLongPress() }),
        ("testHoldReleasedBeforeLongPressIsATap", { ($0 as! GestureEngineTests).testHoldReleasedBeforeLongPressIsATap() }),
        ("testJitterBelowThresholdEmitsNothing", { ($0 as! GestureEngineTests).testJitterBelowThresholdEmitsNothing() }),
        ("testTwoTapsFarApartInSpaceAreTwoSingleTaps", { ($0 as! GestureEngineTests).testTwoTapsFarApartInSpaceAreTwoSingleTaps() }),
    ]),
    ("TouchDigitizerDecoderTests", { TouchDigitizerDecoderTests() }, [
        ("testSelectsILITEKTouchscreenWithoutMatchingItsMouseInterface", { ($0 as! TouchDigitizerDecoderTests).testSelectsILITEKTouchscreenWithoutMatchingItsMouseInterface() }),
        ("testHardwareProfileRequiresItsDeviceAndPrefersReadyEdge", { ($0 as! TouchDigitizerDecoderTests).testHardwareProfileRequiresItsDeviceAndPrefersReadyEdge() }),
        ("testSelectedProfileNeverFallsBackToAnotherDisplaysBounds", { ($0 as! TouchDigitizerDecoderTests).testSelectedProfileNeverFallsBackToAnotherDisplaysBounds() }),
        ("testMapsNormalizedTouchToConfiguredDisplayBounds", { ($0 as! TouchDigitizerDecoderTests).testMapsNormalizedTouchToConfiguredDisplayBounds() }),
        ("testNormalizesILITEKContactCoordinatesAndTip", { ($0 as! TouchDigitizerDecoderTests).testNormalizesILITEKContactCoordinatesAndTip() }),
        ("testIgnoresRelativeMouseAxesAndSecondaryFinger", { ($0 as! TouchDigitizerDecoderTests).testIgnoresRelativeMouseAxesAndSecondaryFinger() }),
        ("testClampsOutOfRangeDigitizerValues", { ($0 as! TouchDigitizerDecoderTests).testClampsOutOfRangeDigitizerValues() }),
        ("testDecodesAbsoluteMouseInterfaceCoordinatesAndPrimaryButton", { ($0 as! TouchDigitizerDecoderTests).testDecodesAbsoluteMouseInterfaceCoordinatesAndPrimaryButton() }),
        ("testMouseDecoderIgnoresRelativeAxesAndUnrelatedButtons", { ($0 as! TouchDigitizerDecoderTests).testMouseDecoderIgnoresRelativeAxesAndUnrelatedButtons() }),
        ("testOneSourceOwnsEachPhysicalContactUntilRelease", { ($0 as! TouchDigitizerDecoderTests).testOneSourceOwnsEachPhysicalContactUntilRelease() }),
        ("testSiblingInterfaceRequiresSamePhysicalDeviceLocation", { ($0 as! TouchDigitizerDecoderTests).testSiblingInterfaceRequiresSamePhysicalDeviceLocation() }),
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
        ("testRepoPathDecodesAndStaysAbsentWhenUnset", { try ($0 as! HelperConfigTests).testRepoPathDecodesAndStaysAbsentWhenUnset() }),
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
    ("NodeVersionOrderTests", { NodeVersionOrderTests() }, [
        ("testComparesVersionsNumericallyNotAsText", { ($0 as! NodeVersionOrderTests).testComparesVersionsNumericallyNotAsText() }),
        ("testTreatsAMissingPartAsZero", { ($0 as! NodeVersionOrderTests).testTreatsAMissingPartAsZero() }),
        ("testIsFalseForEqualVersions", { ($0 as! NodeVersionOrderTests).testIsFalseForEqualVersions() }),
        ("testSurvivesSomethingThatIsNotAVersion", { ($0 as! NodeVersionOrderTests).testSurvivesSomethingThatIsNotAVersion() }),
    ]),
    ("AccessTokenTests", { AccessTokenTests() }, [
        ("testGeneratesThirtyTwoByteBase64URLSecrets", { ($0 as! AccessTokenTests).testGeneratesThirtyTwoByteBase64URLSecrets() }),
        ("testWellFormedMatchesTheServer", { ($0 as! AccessTokenTests).testWellFormedMatchesTheServer() }),
        ("testReadsTheTokenFileForAPort", { try ($0 as! AccessTokenTests).testReadsTheTokenFileForAPort() }),
        ("testReadsTheCodeOutOfTheServersAnswer", { ($0 as! AccessTokenTests).testReadsTheCodeOutOfTheServersAnswer() }),
        ("testSignInURLStaysOnTheTargetsOrigin", { ($0 as! AccessTokenTests).testSignInURLStaysOnTheTargetsOrigin() }),
    ]),
    ("AccessProofTests", { AccessProofTests() }, [
        ("testMatchesTheServersVector", { ($0 as! AccessProofTests).testMatchesTheServersVector() }),
        ("testNoncesAreFreshAndWellFormed", { ($0 as! AccessProofTests).testNoncesAreFreshAndWellFormed() }),
        ("testOnlyTheRightProofIsOurs", { ($0 as! AccessProofTests).testOnlyTheRightProofIsOurs() }),
        ("testAnythingElseThatAnswersIsForeign", { ($0 as! AccessProofTests).testAnythingElseThatAnswersIsForeign() }),
        ("testNothingAnsweringIsAbsent", { ($0 as! AccessProofTests).testNothingAnsweringIsAbsent() }),
    ]),
    ("WidgetFramesTests", { WidgetFramesTests() }, [
        ("testAllowsAWidgetDocumentOnTheSameOrigin", { ($0 as! WidgetFramesTests).testAllowsAWidgetDocumentOnTheSameOrigin() }),
        ("testRefusesEverythingElse", { ($0 as! WidgetFramesTests).testRefusesEverythingElse() }),
        ("testFollowsThePagesOwnOrigin", { ($0 as! WidgetFramesTests).testFollowsThePagesOwnOrigin() }),
    ]),
    ("AdminOriginTests", { AdminOriginTests() }, [
        ("testAllowsTheAdminsOwnOriginAndTheSignInLink", { ($0 as! AdminOriginTests).testAllowsTheAdminsOwnOriginAndTheSignInLink() }),
        ("testRefusesEverythingElseInTheMainFrame", { ($0 as! AdminOriginTests).testRefusesEverythingElseInTheMainFrame() }),
    ]),
    ("KioskOriginTests", { KioskOriginTests() }, [
        ("testAllowsTheDashboardsOwnOrigin", { ($0 as! KioskOriginTests).testAllowsTheDashboardsOwnOrigin() }),
        ("testRefusesAnywhereElse", { ($0 as! KioskOriginTests).testRefusesAnywhereElse() }),
        ("testRefusesNothingAtAll", { ($0 as! KioskOriginTests).testRefusesNothingAtAll() }),
    ]),
    ("ExternalLinkTests", { ExternalLinkTests() }, [
        ("testOpensAnotherSiteInTheBrowser", { ($0 as! ExternalLinkTests).testOpensAnotherSiteInTheBrowser() }),
        ("testKeepsTheAdminsOwnPagesInTheWindow", { ($0 as! ExternalLinkTests).testKeepsTheAdminsOwnPagesInTheWindow() }),
        ("testRefusesEveryOtherScheme", { ($0 as! ExternalLinkTests).testRefusesEveryOtherScheme() }),
    ]),
    ("HelperURLTests", { HelperURLTests() }, [
        ("testAdminHostOpensTheAdmin", { ($0 as! HelperURLTests).testAdminHostOpensTheAdmin() }),
        ("testRevealHostLetsTheDialogsBeSeen", { ($0 as! HelperURLTests).testRevealHostLetsTheDialogsBeSeen() }),
        ("testTargetIsCaseInsensitiveAndIgnoresPathAndQuery", { ($0 as! HelperURLTests).testTargetIsCaseInsensitiveAndIgnoresPathAndQuery() }),
        ("testHostlessSpellingIsAccepted", { ($0 as! HelperURLTests).testHostlessSpellingIsAccepted() }),
        ("testAnotherSchemeIsIgnored", { ($0 as! HelperURLTests).testAnotherSchemeIsIgnored() }),
        ("testUnknownTargetIsIgnored", { ($0 as! HelperURLTests).testUnknownTargetIsIgnored() }),
    ]),
    ("HelperDiagnosticsTests", { HelperDiagnosticsTests() }, [
        ("testSectionListsEveryFact", { ($0 as! HelperDiagnosticsTests).testSectionListsEveryFact() }),
        ("testServerReportComesFirstThenTheHelper", { ($0 as! HelperDiagnosticsTests).testServerReportComesFirstThenTheHelper() }),
        ("testServerDownStillGivesTheHelperPartAndSaysSo", { ($0 as! HelperDiagnosticsTests).testServerDownStillGivesTheHelperPartAndSaysSo() }),
        ("testReasonNeverQuotesTheRequest", { ($0 as! HelperDiagnosticsTests).testReasonNeverQuotesTheRequest() }),
    ]),
    ("DashboardVisibilityTests", { DashboardVisibilityTests() }, [
        ("testUserHideSurvivesDisplayReconfiguration", { ($0 as! DashboardVisibilityTests).testUserHideSurvivesDisplayReconfiguration() }),
        ("testShowingWithoutDisplayKeepsWindowAbsent", { ($0 as! DashboardVisibilityTests).testShowingWithoutDisplayKeepsWindowAbsent() }),
        ("testApplicationHideDoesNotClearUserPreference", { ($0 as! DashboardVisibilityTests).testApplicationHideDoesNotClearUserPreference() }),
    ]),
    ("L10nTests", { L10nTests() }, [
        ("testPicksFrenchForAFrenchSystem", { ($0 as! L10nTests).testPicksFrenchForAFrenchSystem() }),
        ("testPicksEnglishForEverythingElse", { ($0 as! L10nTests).testPicksEnglishForEverythingElse() }),
        ("testEveryKeyIsWrittenInBothLanguages", { ($0 as! L10nTests).testEveryKeyIsWrittenInBothLanguages() }),
        ("testFormatsTheValuesThatCarryOne", { ($0 as! L10nTests).testFormatsTheValuesThatCarryOne() }),
    ]),
    ("ServerLaunchTests", { ServerLaunchTests() }, [
        ("testRepoPathAlwaysMeansTheCheckout", { ($0 as! ServerLaunchTests).testRepoPathAlwaysMeansTheCheckout() }),
        ("testNoRepoPathRunsTheBundledServer", { ($0 as! ServerLaunchTests).testNoRepoPathRunsTheBundledServer() }),
        ("testEmptyRepoPathCountsAsAbsent", { ($0 as! ServerLaunchTests).testEmptyRepoPathCountsAsAbsent() }),
        ("testNoRepoPathAndNoBundledServerFallsBackToTheDefaultCheckout", { ($0 as! ServerLaunchTests).testNoRepoPathAndNoBundledServerFallsBackToTheDefaultCheckout() }),
        ("testCheckoutGuardNeedsBothTheRepoAndTheEntryPoint", { ($0 as! ServerLaunchTests).testCheckoutGuardNeedsBothTheRepoAndTheEntryPoint() }),
        ("testBundledGuardNeedsTheBundleExecutableItself", { ($0 as! ServerLaunchTests).testBundledGuardNeedsTheBundleExecutableItself() }),
        ("testCheckoutEnvironmentKeepsTheDeveloperPath", { ($0 as! ServerLaunchTests).testCheckoutEnvironmentKeepsTheDeveloperPath() }),
        ("testSystemFoldersComeFirstAndRelativeEntriesGo", { ($0 as! ServerLaunchTests).testSystemFoldersComeFirstAndRelativeEntriesGo() }),
        ("testBundledEnvironmentNamesTheBundleAndTheData", { ($0 as! ServerLaunchTests).testBundledEnvironmentNamesTheBundleAndTheData() }),
        ("testBothLaunchesNameTheDiskScannerWhenThereIsOne", { ($0 as! ServerLaunchTests).testBothLaunchesNameTheDiskScannerWhenThereIsOne() }),
        ("testPassesTheHelpersAccessSecretAndNoOther", { ($0 as! ServerLaunchTests).testPassesTheHelpersAccessSecretAndNoOther() }),
    ]),
    ("HelperPathsTests", { HelperPathsTests() }, [
        ("testDefaultsAreUnderLibrary", { ($0 as! HelperPathsTests).testDefaultsAreUnderLibrary() }),
        ("testOverrideMovesEverything", { ($0 as! HelperPathsTests).testOverrideMovesEverything() }),
        ("testRelativeOrEmptyOverrideIsIgnored", { ($0 as! HelperPathsTests).testRelativeOrEmptyOverrideIsIgnored() }),
    ]),
    ("PermissionSequencerTests", { PermissionSequencerTests() }, [
        ("testAsksInputMonitoringAloneWhenTouchNeedsIt", { ($0 as! PermissionSequencerTests).testAsksInputMonitoringAloneWhenTouchNeedsIt() }),
        ("testAsksAccessibilityOnceInputMonitoringIsAnswered", { ($0 as! PermissionSequencerTests).testAsksAccessibilityOnceInputMonitoringIsAnswered() }),
        ("testAsksAccessibilityAnywayAfterTheTimeout", { ($0 as! PermissionSequencerTests).testAsksAccessibilityAnywayAfterTheTimeout() }),
        ("testAsksAccessibilityAtOnceWhenInputMonitoringIsAlreadyAnswered", { ($0 as! PermissionSequencerTests).testAsksAccessibilityAtOnceWhenInputMonitoringIsAlreadyAnswered() }),
        ("testTouchOffNeverAsksInputMonitoring", { ($0 as! PermissionSequencerTests).testTouchOffNeverAsksInputMonitoring() }),
        ("testEverythingOffAsksNothing", { ($0 as! PermissionSequencerTests).testEverythingOffAsksNothing() }),
        ("testBeginOnlyActsOnce", { ($0 as! PermissionSequencerTests).testBeginOnlyActsOnce() }),
    ]),
    ("PermissionFixTests", { PermissionFixTests() }, [
        ("testPanesOpenTheirPrivacyAnchor", { ($0 as! PermissionFixTests).testPanesOpenTheirPrivacyAnchor() }),
        ("testTouchWithoutInputMonitoringOpensInputMonitoring", { ($0 as! PermissionFixTests).testTouchWithoutInputMonitoringOpensInputMonitoring() }),
        ("testEveryAccessibilityLineOpensAccessibility", { ($0 as! PermissionFixTests).testEveryAccessibilityLineOpensAccessibility() }),
        ("testLoginApprovalOpensLoginItems", { ($0 as! PermissionFixTests).testLoginApprovalOpensLoginItems() }),
        ("testInformativeLinesDoNothing", { ($0 as! PermissionFixTests).testInformativeLinesDoNothing() }),
    ]),
    ("TouchAccessGateTests", { TouchAccessGateTests() }, [
        ("testNotGrantedIsMissing", { ($0 as! TouchAccessGateTests).testNotGrantedIsMissing() }),
        ("testGrantedButStillRefusedAsksForARelaunch", { ($0 as! TouchAccessGateTests).testGrantedButStillRefusedAsksForARelaunch() }),
        ("testARevokedGrantOrASuccessfulOpenStartsOver", { ($0 as! TouchAccessGateTests).testARevokedGrantOrASuccessfulOpenStartsOver() }),
        ("testRelaunchWaitsForThePidThenOpensTheBundle", { ($0 as! TouchAccessGateTests).testRelaunchWaitsForThePidThenOpensTheBundle() }),
        ("testRelaunchLineRelaunches", { ($0 as! TouchAccessGateTests).testRelaunchLineRelaunches() }),
    ]),
]

var passed = 0
var failed = 0

for (suiteName, make, methods) in suites + scanSuites + brightnessSuites {
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
