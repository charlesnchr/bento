import AppKit
import Foundation
import VoiceCore

/// Gets the CPU back after a capture-graph build hangs inside AVFAudio.
///
/// A thread stuck in `engine.inputNode` cannot be cancelled or killed from
/// inside the process, and while it spins it keeps coreaudiod busy too (the
/// 2026-11-09 hang cost ~35% CPU in Bento and ~70% in coreaudiod for four
/// days). Ending the process is the only reliable release, so this relaunches
/// Bento, but only once nothing is recording, transcribing or in a call:
/// dictation recordings are crash-safe, a voice call or meeting interrupted
/// mid-sentence is not something to do to anyone. The relaunched process
/// starts with prewarming off (PrewarmHangRecord).
@MainActor
final class AudioHangRecovery {
    private let isQuiescent: () -> Bool
    private let relaunch: @MainActor () -> Void
    private let pollInterval: TimeInterval
    private var waiting: Task<Void, Never>?
    private(set) var relaunched = false

    init(
        pollInterval: TimeInterval = 15,
        isQuiescent: @escaping () -> Bool,
        relaunch: @escaping @MainActor () -> Void = { AudioHangRecovery.relaunchApp() }
    ) {
        self.pollInterval = pollInterval
        self.isQuiescent = isQuiescent
        self.relaunch = relaunch
    }

    /// Relaunches now if nothing is active, otherwise as soon as nothing is.
    func begin() {
        guard waiting == nil, !relaunched else { return }
        waiting = Task { [weak self] in
            while let self, !Task.isCancelled {
                if self.isQuiescent() {
                    self.relaunched = true
                    self.waiting = nil
                    Log.audio.fault("prewarm hang: relaunching Bento to release the stuck audio thread")
                    self.relaunch()
                    return
                }
                Log.audio.info("prewarm hang: waiting for the current dictation, call or meeting to end before relaunching")
                try? await Task.sleep(nanoseconds: UInt64(self.pollInterval * 1_000_000_000))
            }
        }
    }

    /// Opens this same app bundle once this process has exited, then quits.
    /// BENTO_* variables carry over, as in Updater.restart().
    static func relaunchApp() {
        let bundle = Bundle.main.bundleURL
        guard bundle.pathExtension == "app" else {
            // DevVoice and other bare binaries have nothing to reopen.
            Log.audio.error("prewarm hang: not running from an app bundle — quit and restart to recover the CPU")
            return
        }
        let carried = ProcessInfo.processInfo.environment.filter { $0.key.hasPrefix("BENTO_") }.sorted { $0.key < $1.key }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", """
            pid=$1; shift
            i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done
            kill -0 "$pid" 2>/dev/null || exec /usr/bin/open "$@"
            """, "bento-relaunch", String(getpid())] + carried.flatMap { ["--env", "\($0.key)=\($0.value)"] }
            + ["-g", bundle.path, "--args", "--background"]
        do {
            try p.run()
        } catch {
            Log.audio.error("prewarm hang: couldn't start the relaunch helper: \(error.localizedDescription, privacy: .public)")
            return
        }
        // A normal quit flushes notes and config. If teardown itself wedges on
        // the stuck audio stack, leave anyway: the helper gives up after 30s.
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 10) { _exit(0) }
        NSApp.terminate(nil)
    }
}
