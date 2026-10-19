// Registry of the disk scanner's tests, kept apart from main.swift so the suites other branches add
// there and these do not touch the same lines. Same rule as main.swift: every test method is listed,
// and scripts/test-helper.sh counts the entries of every file in this folder.

import XCTest

let scanSuites: [(String, () -> XCTestCase, [TestMethod])] = [
    ("DiskTreeTests", { DiskTreeTests() }, [
        ("testSizesAddUpThroughTheTree", { ($0 as! DiskTreeTests).testSizesAddUpThroughTheTree() }),
        ("testHardLinkedFileCountsOnce", { ($0 as! DiskTreeTests).testHardLinkedFileCountsOnce() }),
        ("testSmallEntriesAndTheTailGoIntoOthers", { ($0 as! DiskTreeTests).testSmallEntriesAndTheTailGoIntoOthers() }),
        ("testTheBudgetMarksMoreWhenItDropsSomethingWorthDrawing", { ($0 as! DiskTreeTests).testTheBudgetMarksMoreWhenItDropsSomethingWorthDrawing() }),
        ("testCandidatesAreTrimmedWhileTheFolderIsWalked", { ($0 as! DiskTreeTests).testCandidatesAreTrimmedWhileTheFolderIsWalked() }),
        ("testEntriesBelowTheDepthAreNotHeldButCounted", { ($0 as! DiskTreeTests).testEntriesBelowTheDepthAreNotHeldButCounted() }),
        ("testUnreadableDirectoriesAreKeptAndCountedNeverAsSmall", { ($0 as! DiskTreeTests).testUnreadableDirectoriesAreKeptAndCountedNeverAsSmall() }),
        ("testBudgetKeepsTheLargestNodesAndFoldsTheRest", { ($0 as! DiskTreeTests).testBudgetKeepsTheLargestNodesAndFoldsTheRest() }),
        ("testJSONEscapesNamesAndLeavesDefaultsOut", { ($0 as! DiskTreeTests).testJSONEscapesNamesAndLeavesDefaultsOut() }),
        ("testArgumentsParseWithDefaults", { try ($0 as! DiskTreeTests).testArgumentsParseWithDefaults() }),
        ("testArgumentsRefuseWhatIsOutOfBounds", { ($0 as! DiskTreeTests).testArgumentsRefuseWhatIsOutOfBounds() }),
    ]),
    ("DiskWalkerTests", { DiskWalkerTests() }, [
        ("testCountsAllocatedSizesLikeLstat", { try ($0 as! DiskWalkerTests).testCountsAllocatedSizesLikeLstat() }),
        ("testHardLinksCountOnce", { try ($0 as! DiskWalkerTests).testHardLinksCountOnce() }),
        ("testSymlinksAreNeverFollowedEvenInALoop", { try ($0 as! DiskWalkerTests).testSymlinksAreNeverFollowedEvenInALoop() }),
        ("testUnreadableDirectoryIsReportedNotCountedAsEmpty", { try ($0 as! DiskWalkerTests).testUnreadableDirectoryIsReportedNotCountedAsEmpty() }),
        ("testAnotherDeviceIsNotCrossed", { try ($0 as! DiskWalkerTests).testAnotherDeviceIsNotCrossed() }),
        ("testCancellationStopsTheWalk", { ($0 as! DiskWalkerTests).testCancellationStopsTheWalk() }),
        ("testMissingRootIsAnError", { ($0 as! DiskWalkerTests).testMissingRootIsAnError() }),
        ("testTooDeepIsUnreadableNotEntered", { try ($0 as! DiskWalkerTests).testTooDeepIsUnreadableNotEntered() }),
        ("testFinishedDirectoriesAreReportedDownToTheProgressDepth", { try ($0 as! DiskWalkerTests).testFinishedDirectoriesAreReportedDownToTheProgressDepth() }),
    ]),
    ("DirectoryOpenerTests", { DirectoryOpenerTests() }, [
        ("testABlockedOpenIsReportedThenGivenUpAndTheWalkGoesOn", { try ($0 as! DirectoryOpenerTests).testABlockedOpenIsReportedThenGivenUpAndTheWalkGoesOn() }),
        ("testAnOpenAnsweredAfterTheGraceIsUsed", { try ($0 as! DirectoryOpenerTests).testAnOpenAnsweredAfterTheGraceIsUsed() }),
        ("testCancellationWhileWaitingStopsTheWalk", { ($0 as! DirectoryOpenerTests).testCancellationWhileWaitingStopsTheWalk() }),
        ("testABlockedRootIsUnreadable", { ($0 as! DirectoryOpenerTests).testABlockedRootIsUnreadable() }),
        ("testAnAbandonedOpenIsClosedWhenItFinallyReturns", { ($0 as! DirectoryOpenerTests).testAnAbandonedOpenIsClosedWhenItFinallyReturns() }),
        ("testWhileAPromptIsUnansweredLaterOpensGiveUpAfterTheGrace", { try ($0 as! DirectoryOpenerTests).testWhileAPromptIsUnansweredLaterOpensGiveUpAfterTheGrace() }),
        ("testOnlyTheTopOfTheTreeGoesThroughTheOpener", { try ($0 as! DirectoryOpenerTests).testOnlyTheTopOfTheTreeGoesThroughTheOpener() }),
        ("testPastTheCapTheWalkWaitsForAnAnswerRatherThanLeaveAThread", { try ($0 as! DirectoryOpenerTests).testPastTheCapTheWalkWaitsForAnAnswerRatherThanLeaveAThread() }),
    ]),
]
