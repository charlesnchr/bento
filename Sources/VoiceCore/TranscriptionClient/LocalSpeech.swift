import Foundation

/// An on-device recogniser. The app installs one at launch, so JotCore stays
/// free of Core ML model dependencies.
public protocol LocalSpeechRecognizing: Sendable {
    /// Loads (and on first use downloads) the model, so the next dictation
    /// does not pay for it.
    func prepare(model: String) async throws
    func transcribe(audioURL: URL, model: String) async throws -> String
}

public enum LocalSpeech {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var installed: LocalSpeechRecognizing?

    public static var recognizer: LocalSpeechRecognizing? {
        get { lock.lock(); defer { lock.unlock() }; return installed }
        set { lock.lock(); installed = newValue; lock.unlock() }
    }

    static func transcribe(audioURL: URL, model: String) async throws -> String {
        guard let recognizer else {
            throw TranscriptionError.modelUnavailable(model: model, detail: "No on-device recogniser in this build")
        }
        return try await recognizer.transcribe(audioURL: audioURL, model: model)
    }
}
