import AppKit
import QuickLookThumbnailing
import SwiftUI

/// App and file icons, drawn by the Quick Look thumbnail service and kept as
/// small bitmaps while the settings pane is open. `NSWorkspace.icon(forFile:)`
/// decodes each icon at full size inside the process and keeps it (measured:
/// ~110 MB for 40 apps, never given back); a searchable grid would pile that up.
final class IconCache {
    private var images: [String: NSImage] = [:]

    func cached(_ url: URL, side: CGFloat) -> NSImage? { images[key(url, side)] }

    @MainActor
    func load(_ url: URL, side: CGFloat) async -> NSImage? {
        let k = key(url, side)
        if let hit = images[k] { return hit }
        let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: side, height: side),
                                                   scale: 2, representationTypes: .icon)
        guard let rep = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request) else { return nil }
        let image = IconCache.bitmap(rep.cgImage, side: side)
        images[k] = image
        return image
    }

    func removeAll() { images = [:] }

    private func key(_ url: URL, _ side: CGFloat) -> String { "\(Int(side))@\(url.path)" }

    /// The service hands back 256 px or more: keep 2× the drawn size.
    static func bitmap(_ image: CGImage, side: CGFloat) -> NSImage {
        let px = Int(side * 2)
        let size = NSSize(width: side, height: side)
        guard image.width > px,
              let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return NSImage(cgImage: image, size: size)
        }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: px, height: px))
        return NSImage(cgImage: ctx.makeImage() ?? image, size: size)
    }
}

/// An app or file icon from the cache: a quiet placeholder until it's drawn,
/// then a short fade.
struct FileIcon: View {
    let url: URL
    let side: CGFloat
    let cache: IconCache
    @State private var loaded: NSImage?
    @State private var failed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let image = cache.cached(url, side: side) ?? loaded {
                Image(nsImage: image).resizable().interpolation(.high)
            } else if failed {
                Image(systemName: "app").resizable().scaledToFit().foregroundStyle(.tertiary).padding(side * 0.1)
            } else {
                RoundedRectangle(cornerRadius: side * 0.22, style: .continuous).fill(.quaternary).padding(side * 0.09)
            }
        }
        .frame(width: side, height: side)
        .task(id: url) {
            guard cache.cached(url, side: side) == nil else { return }
            let image = await cache.load(url, side: side)
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                if let image { loaded = image } else { failed = true }
            }
        }
    }
}
