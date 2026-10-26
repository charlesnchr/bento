import Foundation

/// Sounds, fonts and the Python helpers. build.sh copies `Resources/Voice` and
/// `helper/` into Bento.app/Contents/Resources/Voice; a dev build reads them
/// from the checkout.
enum VoiceResources {
    static let root: URL? = {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("Voice", isDirectory: true),
           FileManager.default.fileExists(atPath: bundled.path) {
            return bundled
        }
        #if DEBUG
        // Sources/Voice/VoiceResources.swift -> checkout root.
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let dev = checkout.appendingPathComponent("Resources/Voice", isDirectory: true)
        return FileManager.default.fileExists(atPath: dev.path) ? dev : nil
        #else
        return nil
        #endif
    }()

    /// A sound, font folder or helper script: `url("hermes-acp", "py")`.
    static func url(_ name: String, _ ext: String, in subdirectory: String? = nil) -> URL? {
        guard let root else { return nil }
        let folder = subdirectory ?? (ext == "py" || ext == "txt" ? "helper" : "")
        let url = root.appendingPathComponent(folder, isDirectory: true).appendingPathComponent("\(name).\(ext)")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        // Dev builds: the helper scripts live in the checkout's helper/ folder.
        if folder == "helper" {
            let dev = root.deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("helper/\(name).\(ext)")
            if FileManager.default.fileExists(atPath: dev.path) { return dev }
        }
        return nil
    }

    static func urls(withExtension ext: String, in subdirectory: String) -> [URL] {
        guard let root else { return [] }
        let folder = root.appendingPathComponent(subdirectory, isDirectory: true)
        let items = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        return items.filter { $0.pathExtension == ext }
    }
}
