// Bento: replaces SwiftPM's Bundle.module lookup, which only searches the app
// bundle's root (where code signing allows no resources) and the build machine's
// .build folder. build.sh copies the fonts to Contents/Resources/Voice/mathFonts.bundle.
import Foundation

enum MathFontsBundle {
    static let url: URL? = {
        var candidates = [Bundle.main.resourceURL?.appendingPathComponent("Voice/mathFonts.bundle", isDirectory: true)]
        #if DEBUG
        // Vendor/SwiftMath/MathFontsBundle.swift -> checkout root, for dev builds.
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        candidates.append(checkout.appendingPathComponent("Resources/Voice/mathFonts.bundle", isDirectory: true))
        #endif
        return candidates.compactMap { $0 }.first { FileManager.default.fileExists(atPath: $0.path) }
    }()
}
