import Foundation
import Testing
@testable import VoiceCore

/// `APIKeyStore` against a temp file, a private defaults suite and a fake keychain.
@Suite(.serialized) final class APIKeyStoreTests {
    private let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-apikey-\(UUID().uuidString)")
    private let suite = "bento-apikey-tests-\(getpid())"
    private var keychainItem: APIKeyStore.KeychainLookup = .absent
    private var keychainReads = 0
    private var keychainDeletes = 0

    init() {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        UserDefaults().removePersistentDomain(forName: suite)
        APIKeyStore.fileURL = dir.appendingPathComponent("gemini-api-key")
        APIKeyStore.sharedURL = nil
        APIKeyStore.defaults = UserDefaults(suiteName: suite)!
        APIKeyStore.keychain = (
            load: { [unowned self] in keychainReads += 1; return keychainItem },
            delete: { [unowned self] in keychainDeletes += 1; keychainItem = .absent }
        )
        APIKeyStore.resetLaunchState()
    }

    deinit {
        APIKeyStore.keychain = (load: { .absent }, delete: {})
        APIKeyStore.defaults = .standard
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private var file: URL { APIKeyStore.fileURL }
    private func mode(_ url: URL) -> Int? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions] as? Int
    }

    @Test func movesTheKeychainKeyIntoAPrivateFile() throws {
        keychainItem = .found("AIza-old")
        #expect(APIKeyStore.loadAPIKey() == "AIza-old")
        #expect(try String(contentsOf: file, encoding: .utf8) == "AIza-old")
        #expect(mode(file) == 0o600)
        #expect(keychainDeletes == 1)
        // Later reads, this launch or the next, use the file only.
        APIKeyStore.resetLaunchState()
        #expect(APIKeyStore.loadAPIKey() == "AIza-old")
        #expect(APIKeyStore.hasAPIKey)
        #expect(keychainReads == 1)
    }

    @Test func anEmptyKeychainIsAskedOnce() {
        #expect(APIKeyStore.loadAPIKey() == nil)
        APIKeyStore.resetLaunchState()
        #expect(!APIKeyStore.hasAPIKey)
        #expect(keychainReads == 1)
    }

    @Test func aDeniedKeychainPromptReturnsNextLaunchNotNextRead() {
        keychainItem = .failed(-128)
        #expect(APIKeyStore.loadAPIKey() == nil)
        #expect(APIKeyStore.loadAPIKey() == nil)
        #expect(keychainReads == 1)
        APIKeyStore.resetLaunchState()
        keychainItem = .found("AIza-old")
        #expect(APIKeyStore.loadAPIKey() == "AIza-old")
        #expect(keychainReads == 2)
    }

    @Test func savesRemovesAndNeverFallsBackToTheKeychain() throws {
        keychainItem = .found("AIza-old")
        #expect(APIKeyStore.saveAPIKey("AIza-new"))
        #expect(mode(file) == 0o600)
        #expect(APIKeyStore.loadAPIKey() == "AIza-new")
        #expect(APIKeyStore.deleteAPIKey())
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(APIKeyStore.loadAPIKey() == nil)
        #expect(keychainReads == 0)
        // Saving replaces the file, leaving no temporary files behind.
        #expect(APIKeyStore.saveAPIKey("a"))
        #expect(APIKeyStore.saveAPIKey("b"))
        #expect(APIKeyStore.loadAPIKey() == "b")
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == ["gemini-api-key"])
    }

    @Test func aHandWrittenFileIsTrimmedAndMadePrivate() {
        FileManager.default.createFile(atPath: file.path, contents: Data("  AIza-typed\n".utf8), attributes: [.posixPermissions: 0o644])
        #expect(APIKeyStore.loadAPIKey() == "AIza-typed")
        #expect(mode(file) == 0o600)
        FileManager.default.createFile(atPath: file.path, contents: Data("\n".utf8))
        #expect(APIKeyStore.loadAPIKey() == nil)
    }

    @Test func anIsolatedInstanceReadsTheInstalledKeyAndLeavesTheKeychainAlone() {
        let shared = dir.appendingPathComponent("installed-key")
        FileManager.default.createFile(atPath: shared.path, contents: Data("AIza-installed".utf8))
        APIKeyStore.sharedURL = shared
        keychainItem = .found("AIza-old")
        #expect(APIKeyStore.loadAPIKey() == "AIza-installed")
        try? FileManager.default.removeItem(at: shared)
        #expect(APIKeyStore.loadAPIKey() == nil)
        #expect(keychainReads == 0)
    }
}
