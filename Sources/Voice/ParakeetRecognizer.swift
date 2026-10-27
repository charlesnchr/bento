import FluidAudio
import Foundation
import VoiceCore

/// Parakeet TDT on the Neural Engine through FluidAudio's Core ML builds.
///
/// Models live in FluidAudio's shared cache (~/Library/Application Support/
/// FluidAudio/Models) and download from Hugging Face on first use: about 480 MB
/// for v3, 630 MB for Ultra. One model stays loaded; switching releases the other.
/// Every load reports to ParakeetModels, which Settings and the menu show.
actor ParakeetRecognizer: LocalSpeechRecognizing {
    private var loaded: (model: String, manager: AsrManager)?
    private var loading: (model: String, task: Task<AsrManager, Error>)?

    func prepare(model: String) async throws {
        _ = try await manager(for: model)
    }

    func transcribe(audioURL: URL, model: String) async throws -> String {
        let manager = try await manager(for: model)
        var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
        let result = try await manager.transcribe(audioURL, decoderState: &state)
        Log.transcription.info("parakeet \(model, privacy: .public): \(String(format: "%.2f", result.duration))s audio in \(Int(result.processingTime * 1000))ms, confidence \(String(format: "%.2f", result.confidence))")
        return result.text
    }

    /// Forwards download progress to Settings and the menu. The main queue, not
    /// a Task per update: it keeps the updates in order.
    private static func reportProgress(of engine: SettingsStore.TranscriptionEngine) -> ProgressHandler {
        { update in
            DispatchQueue.main.async { MainActor.assumeIsolated { ParakeetModels.shared.progress(engine, update) } }
        }
    }

    private func manager(for model: String) async throws -> AsrManager {
        if let loaded, loaded.model == model { return loaded.manager }
        if let loading, loading.model == model { return try await loading.task.value }
        let version: AsrModelVersion
        switch model {
        case "parakeet-v3": version = .v3
        case "parakeet-ultra": version = .ultra
        default: throw TranscriptionError.modelUnavailable(model: model, detail: "Unknown on-device model")
        }
        let engine = SettingsStore.TranscriptionEngine(rawValue: model) ?? .parakeetV3
        // Only a real download is worth a progress bar; loading a cached model is a second or two.
        let fetching = !ParakeetModels.isOnDisk(engine)
        let progress = fetching ? Self.reportProgress(of: engine) : nil
        let task = Task {
            let started = Date()
            let models = try await AsrModels.downloadAndLoad(version: version, progressHandler: progress)
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)
            Log.transcription.info("parakeet \(model, privacy: .public) loaded in \(Int(Date().timeIntervalSince(started) * 1000))ms")
            return manager
        }
        loading = (model, task)
        // After `loading` is set: this await lets a second caller in, and it must join, not reload.
        if fetching { await ParakeetModels.shared.began(engine) }
        do {
            let manager = try await task.value
            if loading?.model == model { loading = nil }
            if let previous = loaded, previous.model != model { await previous.manager.cleanup() }
            loaded = (model, manager)
            await ParakeetModels.shared.finished(engine, error: nil)
            return manager
        } catch {
            if loading?.model == model { loading = nil }
            Log.transcription.error("parakeet \(model, privacy: .public) failed to load: \(error.localizedDescription, privacy: .public)")
            await ParakeetModels.shared.finished(engine, error: error.localizedDescription)
            throw TranscriptionError.modelUnavailable(model: model, detail: error.localizedDescription)
        }
    }
}
