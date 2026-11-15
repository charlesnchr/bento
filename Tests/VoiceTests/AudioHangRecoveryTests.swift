import Foundation
import Testing
@testable import Voice

/// After a hung prewarm build, Bento relaunches to release the stuck audio
/// thread, but never in the middle of a dictation, call or meeting.
@MainActor
struct AudioHangRecoveryTests {
    final class Probe {
        var busy = false
        var relaunches = 0
    }

    @Test func relaunchesStraightAwayWhenIdle() async {
        let probe = Probe()
        let recovery = AudioHangRecovery(pollInterval: 0.01, isQuiescent: { !probe.busy }, relaunch: { probe.relaunches += 1 })
        recovery.begin()
        await waitUntil { probe.relaunches > 0 }
        #expect(probe.relaunches == 1)
        #expect(recovery.relaunched)
    }

    @Test func waitsForTheActiveSessionToEnd() async throws {
        let probe = Probe()
        probe.busy = true
        let recovery = AudioHangRecovery(pollInterval: 0.01, isQuiescent: { !probe.busy }, relaunch: { probe.relaunches += 1 })
        recovery.begin()
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(probe.relaunches == 0)
        probe.busy = false
        await waitUntil { probe.relaunches > 0 }
        #expect(probe.relaunches == 1)
    }

    @Test func relaunchesOnceHoweverOftenItIsAsked() async throws {
        let probe = Probe()
        let recovery = AudioHangRecovery(pollInterval: 0.01, isQuiescent: { !probe.busy }, relaunch: { probe.relaunches += 1 })
        recovery.begin()
        recovery.begin()
        await waitUntil { probe.relaunches > 0 }
        recovery.begin()
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(probe.relaunches == 1)
    }

    @Test func reopensTheRunningBundleWhenItIsThere() {
        let bundle = URL(fileURLWithPath: "/Users/me/workspace/bento/dist/Bento.app")
        #expect(AudioHangRecovery.relaunchTarget(bundle: bundle, exists: { _ in true }) == bundle)
    }

    @Test func reopensTheHomebrewAppWhenAnUpgradeRemovedTheKeg() {
        let keg = URL(fileURLWithPath: "/opt/homebrew/Cellar/bento/0.7.8/Bento.app")
        let target = AudioHangRecovery.relaunchTarget(bundle: keg, exists: { $0 == "/opt/homebrew/opt/bento/Bento.app" })
        #expect(target?.path == "/opt/homebrew/opt/bento/Bento.app")
    }

    @Test func doesNotQuitWithNothingToReopen() {
        let bare = URL(fileURLWithPath: "/Users/me/workspace/bento/.build/debug")
        #expect(AudioHangRecovery.relaunchTarget(bundle: bare, exists: { _ in true }) == nil)
        let gone = URL(fileURLWithPath: "/tmp/Bento.app")
        #expect(AudioHangRecovery.relaunchTarget(bundle: gone, exists: { _ in false }) == nil)
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
