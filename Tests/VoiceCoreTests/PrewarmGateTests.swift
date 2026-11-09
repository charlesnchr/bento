import Foundation
import Testing
@testable import VoiceCore

/// When the idle capture-graph build may run, and what happens when one hangs.
/// The 2026-11-09 hang was a prewarm build that raced a device change and spun
/// in AVFAudio for four days; these are the rules that keep it from recurring.
struct PrewarmGateTests {

    @Test func firstBuildAfterLaunchWaitsForAQuietHAL() {
        let gate = PrewarmGate(quietPeriod: 2, now: 100)
        #expect(gate.decide(at: 100) == .wait(2))
        #expect(gate.decide(at: 101.5) == .wait(0.5))
        #expect(gate.decide(at: 102) == .build)
    }

    @Test func everyChangeInABurstPushesTheBuildBack() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        for t in [5.0, 5.25, 5.5, 5.75, 6.0] { gate.noteActivity(at: t) }
        #expect(gate.decide(at: 7) == .wait(1))
        #expect(gate.decide(at: 8) == .build)
    }

    @Test func noBuildWhileSuspendedEvenWhenQuiet() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.setSuspended(true)
        #expect(gate.decide(at: 60) == .hold(.suspended))
        gate.setSuspended(false)
        #expect(gate.decide(at: 60) == .build)
    }

    @Test func noBuildBesideARunningCapture() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.setCaptureActive(true)
        #expect(gate.decide(at: 60) == .hold(.captureActive))
        gate.setCaptureActive(false)
        #expect(gate.decide(at: 60) == .build)
    }

    @Test func noBuildInsideARouteChange() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.noteActivity(at: 50)
        #expect(gate.decide(at: 50.5) == .wait(1.5))
    }

    @Test func oneBuildAtATime() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.buildStarted()
        #expect(gate.decide(at: 60) == .hold(.building))
        // A route change mid-build must not start a second, racing build.
        gate.noteActivity(at: 61)
        #expect(gate.decide(at: 70) == .hold(.building))
    }

    @Test func aCleanBuildIsKeptAndHoldsFurtherBuilds() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.buildStarted()
        let kept = gate.buildFinished(.built)
        #expect(kept)
        #expect(gate.decide(at: 60) == .hold(.warm))
        gate.spareGone()
        #expect(gate.decide(at: 60) == .build)
    }

    @Test func aBuildThatOverlappedAChangeIsDiscardedAndRetriedOnceQuiet() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.buildStarted()
        gate.noteActivity(at: 10)
        let kept = gate.buildFinished(.built)
        #expect(!kept)
        #expect(gate.decide(at: 11) == .wait(1))
        #expect(gate.decide(at: 12) == .build)
        // The flag belongs to that build only.
        gate.buildStarted()
        let kept2 = gate.buildFinished(.built)
        #expect(kept2)
    }

    @Test func aBuildThatLandsAfterSuspendIsDiscarded() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.buildStarted()
        gate.setSuspended(true)
        let kept = gate.buildFinished(.built)
        #expect(!kept)
        #expect(!gate.hasSpare)
    }

    @Test func anUnsettledDeviceWaitsForTheHALInsteadOfPolling() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.buildStarted()
        let kept = gate.buildFinished(.unsettled)
        #expect(!kept)
        #expect(gate.decide(at: 600) == .hold(.unsettled))
        gate.noteActivity(at: 600)
        #expect(gate.decide(at: 602) == .build)
    }

    @Test func aFailedBuildIsNotRetriedInALoop() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.buildStarted()
        let kept = gate.buildFinished(.failed)
        #expect(!kept)
        #expect(gate.decide(at: 600) == .hold(.unsettled))
    }

    @Test func aFailureThatOverlappedAChangeIsRetriedOnceQuiet() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.buildStarted()
        gate.noteActivity(at: 10)
        let kept = gate.buildFinished(.failed)
        #expect(!kept)
        #expect(gate.decide(at: 12) == .build)
    }

    @Test func disabledAfterAHangWinsOverEverything() {
        var gate = PrewarmGate(quietPeriod: 2, now: 0)
        gate.buildStarted()
        gate.disable()
        #expect(gate.decide(at: 600) == .hold(.disabled))
        // Should the hung build ever return, it is not used.
        let kept = gate.buildFinished(.built)
        #expect(!kept)
        gate.noteActivity(at: 700)
        #expect(gate.decide(at: 800) == .hold(.disabled))
    }
}

struct BuildWatchdogTests {

    @Test func aNormalBuildReportsNothing() {
        var dog = BuildWatchdog(slowAfter: 1, hungAfter: 10)
        dog.begin(at: 0)
        let verdict = dog.check(at: 0.13)
        #expect(verdict == nil)
        let duration = dog.finish(at: 0.135)
        #expect(duration == 0.135)
        #expect(!dog.isTiming)
        #expect(!dog.hung)
    }

    @Test func slowThenHungEachReportedOnce() {
        var dog = BuildWatchdog(slowAfter: 1, hungAfter: 10)
        dog.begin(at: 0)
        let verdict = dog.check(at: 0.5)
        #expect(verdict == nil)
        let verdict2 = dog.check(at: 1.5)
        #expect(verdict2 == .slow(1.5))
        let verdict3 = dog.check(at: 2)
        #expect(verdict3 == nil)
        let verdict4 = dog.check(at: 10.5)
        #expect(verdict4 == .hung(10.5))
        let verdict5 = dog.check(at: 3600)
        #expect(verdict5 == nil)
        #expect(dog.hung)
    }

    @Test func aBuildFirstCheckedPastTheBoundIsHungNotSlow() {
        var dog = BuildWatchdog(slowAfter: 1, hungAfter: 10)
        dog.begin(at: 0)
        let verdict = dog.check(at: 30)
        #expect(verdict == .hung(30))
        let verdict2 = dog.check(at: 31)
        #expect(verdict2 == nil)
    }

    @Test func nothingToReportWhenIdle() {
        var dog = BuildWatchdog()
        let verdict = dog.check(at: 1000)
        #expect(verdict == nil)
        let duration = dog.finish(at: 1000)
        #expect(duration == nil)
    }

    @Test func aNewBuildResetsTheVerdicts() {
        var dog = BuildWatchdog(slowAfter: 1, hungAfter: 10)
        dog.begin(at: 0)
        _ = dog.check(at: 2)
        _ = dog.finish(at: 3)
        dog.begin(at: 100)
        let verdict = dog.check(at: 101.5)
        #expect(verdict == .slow(1.5))
    }
}

/// Serialized because the tests share one private defaults suite.
@Suite(.serialized) struct PrewarmHangRecordTests {
    private let suite = PrivateDefaults("prewarm-hang")

    @Test func noRecordMeansNoHang() {
        #expect(PrewarmHangRecord(defaults: suite.defaults).recentHang(now: Date()) == nil)
    }

    @Test func aHangKeepsPrewarmOffForTheCooldownOnly() {
        let record = PrewarmHangRecord(defaults: suite.defaults)
        let hang = Date(timeIntervalSince1970: 1_800_000_000)
        record.record(at: hang)
        #expect(record.recentHang(now: hang.addingTimeInterval(60)) == hang)
        #expect(record.recentHang(now: hang.addingTimeInterval(PrewarmHangRecord.cooldown - 1)) == hang)
        #expect(record.recentHang(now: hang.addingTimeInterval(PrewarmHangRecord.cooldown)) == nil)
    }
}
