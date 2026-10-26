import FluidAudio
import Foundation
import VoiceCore

/// Parakeet TDT on the Neural Engine through FluidAudio's Core ML builds.
///
/// Models live in FluidAudio's shared cache (~/Library/Application Support/
/// FluidAudio/Models) and download from Hugging Face on first use: about 480 MB
/// for v3, 630 MB for Ultra. One model stays loaded; switching releases the other.
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

    private func manager(for model: String) async throws -> AsrManager {
        if let loaded, loaded.model == model { return loaded.manager }
        if let loading, loading.model == model { return try await loading.task.value }
        let version: AsrModelVersion
        switch model {
        case "parakeet-v3": version = .v3
        case "parakeet-ultra": version = .ultra
        default: throw TranscriptionError.modelUnavailable(model: model, detail: "Unknown on-device model")
        }
        let task = Task {
            let started = Date()
            let models = try await AsrModels.downloadAndLoad(version: version)
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)
            Log.transcription.info("parakeet \(model, privacy: .public) loaded in \(Int(Date().timeIntervalSince(started) * 1000))ms")
            return manager
        }
        loading = (model, task)
        do {
            let manager = try await task.value
            if loading?.model == model { loading = nil }
            if let previous = loaded, previous.model != model { await previous.manager.cleanup() }
            loaded = (model, manager)
            return manager
        } catch {
            if loading?.model == model { loading = nil }
            Log.transcription.error("parakeet \(model, privacy: .public) failed to load: \(error.localizedDescription, privacy: .public)")
            throw TranscriptionError.modelUnavailable(model: model, detail: error.localizedDescription)
        }
    }
}
