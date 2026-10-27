import FluidAudio
import Testing
@testable import Voice

/// Download state for the on-device models. Each test uses its own instance;
/// "ready" also reads this Mac's FluidAudio cache, so assertions only rely on
/// what in-flight state overrides.
@MainActor @Suite struct ParakeetModelsTests {
    @Test func aFailedLoadStaysFailedUntilARetrySucceeds() {
        let models = ParakeetModels()
        models.finished(.parakeetV3, error: "Unable to load model")
        #expect(models.status(.parakeetV3) == .failed("Unable to load model"),
                "Failed even if the files are in the cache: they're what failed")
        #expect(!models.isReady(.parakeetV3))
        models.began(.parakeetV3)
        #expect(models.status(.parakeetV3) == .downloading(0))
        models.finished(.parakeetV3, error: nil)
        #expect(models.status(.parakeetV3) == .ready)
        models.finished(.parakeetV3, error: "Out of space")
        #expect(models.status(.parakeetV3) == .failed("Out of space"), "A later failure undoes an earlier load")
    }

    @Test func progressCountsOnlyDownloadedBytes() {
        let models = ParakeetModels()
        models.progress(.parakeetUltra, DownloadProgress(fractionCompleted: 0.2, phase: .downloading(completedFiles: 1, totalFiles: 4)))
        #expect(models.status(.parakeetUltra) != .downloading(0.4), "Nothing before the download begins")
        models.began(.parakeetUltra)
        models.progress(.parakeetUltra, DownloadProgress(fractionCompleted: 0.2, phase: .downloading(completedFiles: 1, totalFiles: 4)))
        #expect(models.status(.parakeetUltra) == .downloading(0.4), "Bytes are half of a repo load")
        models.progress(.parakeetUltra, DownloadProgress(fractionCompleted: 0.5, phase: .downloading(completedFiles: 0, totalFiles: 0)))
        #expect(models.status(.parakeetUltra) == .downloading(0.4), "A cached file set reports no bytes")
        #expect(models.progressLine(.parakeetUltra) == "Downloading Parakeet Ultra… 40%")
        models.progress(.parakeetUltra, DownloadProgress(fractionCompleted: 0.6, phase: .compiling(modelName: "Encoder")))
        #expect(models.status(.parakeetUltra) == .downloading(nil))
        #expect(models.progressLine(.parakeetUltra) == "Preparing Parakeet Ultra…")
    }
}
