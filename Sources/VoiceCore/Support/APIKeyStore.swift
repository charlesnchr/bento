// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


import BentoCore
import Foundation
import Security

/// The Gemini API key, in `~/.config/bento/gemini-api-key` beside `sync-token` and
/// `voice-runtime.json`, readable and writable only by this user (0600).
///
/// It used to be a login-keychain item, and every update asked for the keychain password
/// again, "Always Allow" or not: the keychain lets an app back in by its Team ID when it is
/// signed with an Apple-issued certificate, and otherwise only by the exact build's code
/// hash. Bento's persistent self-signed identity has no Team ID, so each release was a new
/// app to the keychain. A key still there moves to the file the first time it's needed
/// (the last keychain prompt) and leaves the keychain. Never UserDefaults/JSON
/// (Superwhisper's documented failure).
public enum APIKeyStore {
    /// Where the key lives. Tests point it elsewhere.
    nonisolated(unsafe) static var fileURL = AppPaths.configDir.appendingPathComponent("gemini-api-key")

    /// An isolated instance (BENTO_HOME: the dev harnesses) without a key of its own reads
    /// the installed app's, as both read the one keychain item before. It never takes the
    /// keychain item itself, which would leave the installed app without it.
    nonisolated(unsafe) static var sharedURL: URL? = ProcessInfo.processInfo.environment["BENTO_HOME"] == nil ? nil
        : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/bento/gemini-api-key")

    /// Set once the keychain holds nothing to move: moved, found empty, or replaced by a key
    /// saved or removed in Settings.
    nonisolated(unsafe) static var defaults = UserDefaults.standard
    static let movedKey = "apiKeyMovedFromKeychain"

    enum KeychainLookup: Equatable { case found(String), absent, failed(OSStatus) }

    /// The old keychain item. Tests swap it, so they never touch this Mac's keychain.
    nonisolated(unsafe) static var keychain: (load: () -> KeychainLookup, delete: () -> Void) = (LegacyKeychain.load, LegacyKeychain.delete)

    private static let lock = NSLock()
    /// The keychain is asked at most once per launch: a denied prompt comes back next launch,
    /// not on every read.
    nonisolated(unsafe) private static var askedKeychain = false
    /// A key read from the keychain that couldn't be written to the file.
    nonisolated(unsafe) private static var unsaved: String?

    /// A new launch, for tests.
    static func resetLaunchState() {
        lock.lock(); askedKeychain = false; unsaved = nil; lock.unlock()
    }

    public static func loadAPIKey() -> String? {
        lock.lock(); defer { lock.unlock() }
        if let key = read(fileURL, tighten: true) { return key }
        if let sharedURL { return read(sharedURL, tighten: false) }
        return unsaved ?? moveFromKeychain()
    }

    /// Whether a key is stored. A file read, so Settings and each dictation check can ask freely.
    public static var hasAPIKey: Bool { loadAPIKey() != nil }

    @discardableResult
    public static func saveAPIKey(_ key: String) -> Bool {
        lock.lock()
        let saved = write(key)
        if saved {
            unsaved = nil
            defaults.set(true, forKey: movedKey)
        }
        lock.unlock()
        guard saved else {
            Log.permissions.error("APIKeyStore: couldn't write \(fileURL.path, privacy: .public)")
            return false
        }
        Log.permissions.info("APIKeyStore: key saved")
        NotificationCenter.default.post(name: .gtSettingDidChange, object: "apiKey")
        return true
    }

    /// Removes the key (Settings → Remove).
    @discardableResult
    public static func deleteAPIKey() -> Bool {
        lock.lock()
        let deleted = (try? FileManager.default.removeItem(at: fileURL)) != nil || unsaved != nil
        unsaved = nil
        defaults.set(true, forKey: movedKey)
        lock.unlock()
        if deleted { NotificationCenter.default.post(name: .gtSettingDidChange, object: "apiKey") }
        return deleted
    }

    // MARK: File

    /// The trimmed contents, nil when missing or empty. A file made by hand with looser
    /// permissions is narrowed to 0600.
    private static func read(_ url: URL, tighten: Bool) -> String? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        if tighten, let mode = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions] as? Int,
           mode & 0o077 != 0 {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
        let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty ? nil : key
    }

    /// Created 0600 under a temporary name and renamed over the key, so the key is never
    /// readable by others nor half-written.
    private static func write(_ key: String) -> Bool {
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let temp = dir.appendingPathComponent(".\(fileURL.lastPathComponent).\(UUID().uuidString)")
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { return false }
        let data = Data(key.utf8)
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        let synced = fsync(fd) == 0
        close(fd)
        guard written == data.count, synced, rename(temp.path, fileURL.path) == 0 else {
            unlink(temp.path)
            return false
        }
        return true
    }

    // MARK: Moving out of the keychain

    private static func moveFromKeychain() -> String? {
        guard !askedKeychain, !defaults.bool(forKey: movedKey) else { return nil }
        askedKeychain = true
        switch keychain.load() {
        case .absent:
            defaults.set(true, forKey: movedKey)
            return nil
        case .failed(let status):
            Log.permissions.error("APIKeyStore: couldn't read the keychain item (\(status)); asking again next launch")
            return nil
        case .found(let key):
            guard write(key) else {
                Log.permissions.error("APIKeyStore: couldn't write \(fileURL.path, privacy: .public); the key stays in the keychain")
                unsaved = key
                return key
            }
            defaults.set(true, forKey: movedKey)
            keychain.delete()
            Log.permissions.info("APIKeyStore: moved the key from the keychain to \(fileURL.path, privacy: .public)")
            return key
        }
    }

    /// The item as the keychain-based store wrote it: in the data-protection keychain when a
    /// build had the keychain-access-groups entitlement (none did), else the login keychain.
    private enum LegacyKeychain {
        static let service = "com.charles.bento.gemini-api-key"
        static let account = "gemini-api-key"

        static func query(dataProtection: Bool) -> [String: Any] {
            var query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ]
            if dataProtection { query[kSecUseDataProtectionKeychain as String] = true }
            return query
        }

        static func load() -> KeychainLookup {
            for dataProtection in [true, false] {
                var query = query(dataProtection: dataProtection)
                query[kSecReturnData as String] = true
                query[kSecMatchLimit as String] = kSecMatchLimitOne
                var item: CFTypeRef?
                let status = SecItemCopyMatching(query as CFDictionary, &item)
                switch status {
                case errSecSuccess:
                    guard let data = item as? Data, let key = String(data: data, encoding: .utf8) else { return .absent }
                    let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
                    return trimmed.isEmpty ? .absent : .found(trimmed)
                case errSecItemNotFound, errSecMissingEntitlement:
                    continue
                default:
                    return .failed(status)
                }
            }
            return .absent
        }

        static func delete() {
            for dataProtection in [true, false] {
                SecItemDelete(query(dataProtection: dataProtection) as CFDictionary)
            }
        }
    }
}
