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

    /// What to reopen: this bundle, or, when `brew upgrade` has removed the
    /// keg it ran from, the stable Homebrew opt path. Nil means nothing to
    /// reopen, and then Bento must not quit.
    static func relaunchTarget(
        bundle: URL = Bundle.main.bundleURL,
        exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> URL? {
        // DevVoice and other bare binaries have nothing to reopen.
        guard bundle.pathExtension == "app" else { return nil }
        if exists(bundle.path) { return bundle }
        return ["/opt/homebrew/opt/bento/Bento.app", "/usr/local/opt/bento/Bento.app"]
            .first(where: exists).map { URL(fileURLWithPath: $0) }
    }

    /// Opens the app once this process has exited, then quits. BENTO_*
    /// variables carry over, as in Updater.restart().
    static func relaunchApp() {
        guard let bundle = relaunchTarget() else {
            Log.audio.error("prewarm hang: no app bundle to reopen — quit and restart Bento to recover the CPU")
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
