import FluidAudio
import Foundation
import VoiceCore

extension Notification.Name {
    /// Posted on the main actor when a Parakeet model starts, progresses past a
    /// step, finishes or fails its download. `object` is the engine's raw value.
    static let voiceLocalModelDidChange = Notification.Name("BentoVoiceLocalModelDidChange")
}

/// Whether each Parakeet model is on this Mac, and the one-time download that
/// puts it there. "Ready" is read from FluidAudio's cache on every ask, so a
/// model fetched by another app, or deleted from Finder, shows truthfully;
/// only an in-flight download or its failure is remembered here. Progress
/// comes from ParakeetRecognizer, whichever caller started the load.
@MainActor
final class ParakeetModels: ObservableObject {
    typealias Engine = SettingsStore.TranscriptionEngine
    static let shared = ParakeetModels()

    enum Status: Equatable {
        case notDownloaded
        /// The share of bytes fetched; nil once they're in and Core ML is compiling.
        case downloading(Double?)
        case ready
        case failed(String)
    }

    @Published private var inFlight: [Engine: Status] = [:]
    /// Loaded this run: ready even if the cache check ever disagreed, so it can't block dictation.
    private var loaded: Set<Engine> = []

    func status(_ engine: Engine) -> Status {
        if case .downloading = inFlight[engine] { return inFlight[engine]! }
        if loaded.contains(engine) || Self.isOnDisk(engine) { return .ready }
        return inFlight[engine] ?? .notDownloaded
    }

    func isReady(_ engine: Engine) -> Bool { status(engine) == .ready }

    /// Starts the download (and the load, so the first dictation doesn't wait
    /// for it). A second call while one runs joins it. Downloading the
    /// fallback makes it the user's choice: a Gemini key added later (for the
    /// assistant, say) mustn't switch dictation away from a model they fetched.
    func download(_ engine: Engine) {
        guard engine.isLocal, status(engine) != .ready else { return }
        if case .downloading = status(engine) { return }
        let settings = SettingsStore()
        if settings.usesLocalFallback, settings.transcriptionEngine == engine { settings.setTranscriptionEngine(engine) }
        guard let recognizer = LocalSpeech.recognizer else {
            finished(engine, error: "On-device speech isn't available in this build")
            return
        }
        began(engine)
        Task.detached(priority: .userInitiated) { try? await recognizer.prepare(model: engine.rawValue) }
    }

    // MARK: Reports from the recognizer

    func began(_ engine: Engine) {
        if case .downloading = inFlight[engine] { return }
        inFlight[engine] = .downloading(0)
        announce(engine)
    }

    /// FluidAudio weighs a repo load half download, half compile, and reports a
    /// cached repo as a download of zero files; only real bytes move the bar.
    func progress(_ engine: Engine, _ progress: DownloadProgress) {
        guard case .downloading(let shown) = inFlight[engine] else { return }
        let next: Double?
        switch progress.phase {
        case .listing: next = shown
        case .downloading(_, let totalFiles):
            guard totalFiles > 0, let shown else { return }
            next = max(shown, min(progress.fractionCompleted * 2, 1))
        case .compiling: next = nil
        }
        guard next != shown else { return }
        let step = { (value: Double?) in value.map { Int($0 * 100) } ?? -1 }
        inFlight[engine] = .downloading(next)
        // The menu status line needn't hear every byte: whole percents only.
        if step(next) != step(shown) { announce(engine) }
    }

    func finished(_ engine: Engine, error: String?) {
        inFlight[engine] = error.map { .failed($0) }
        if error == nil { loaded.insert(engine) }
        announce(engine)
    }

    private func announce(_ engine: Engine) {
        NotificationCenter.default.post(name: .voiceLocalModelDidChange, object: engine.rawValue)
    }

    // MARK: Cache

    nonisolated static func version(of engine: Engine) -> AsrModelVersion? {
        switch engine {
        case .parakeetV3: return .v3
        case .parakeetUltra: return .ultra
        default: return nil
        }
    }

    /// Every file FluidAudio needs is in its cache.
    nonisolated static func isOnDisk(_ engine: Engine) -> Bool {
        guard let version = version(of: engine) else { return false }
        return AsrModels.modelsExist(at: AsrModels.defaultCacheDirectory(for: version), version: version)
    }

    /// Where FluidAudio keeps the model, for Show in Finder.
    nonisolated static func cacheDirectory(of engine: Engine) -> URL {
        AsrModels.defaultCacheDirectory(for: version(of: engine) ?? .v3)
    }

    /// What the one-time download costs, for buttons and offers.
    nonisolated static func downloadSize(of engine: Engine) -> String {
        engine == .parakeetUltra ? "630 MB" : "480 MB"
    }

    /// One line for menus and the status bar: "Downloading Parakeet v3… 42%".
    func progressLine(_ engine: Engine) -> String? {
        guard case .downloading(let fraction) = status(engine) else { return nil }
        guard let fraction else { return "Preparing \(engine.displayName)…" }
        return "Downloading \(engine.displayName)… \(Int(fraction * 100))%"
    }
}
