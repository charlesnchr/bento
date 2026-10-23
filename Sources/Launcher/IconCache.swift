import AppKit
import QuickLookThumbnailing
import SwiftUI

/// App and file icons, drawn by the Quick Look thumbnail service and kept as
/// small 8-bit bitmaps while the settings pane is open. `NSWorkspace.icon(forFile:)`
/// decodes each icon at full size inside the process and keeps it (measured:
/// ~110 MB for 40 apps, never given back); a searchable grid would pile that up.
final class IconCache {
    private var images: [String: NSImage] = [:]
    /// Bumped by `removeAll()`, so a load still in flight when the pane goes
    /// away doesn't refill the cache.
    private var generation = 0

    func cached(_ url: URL, side: CGFloat) -> NSImage? { images[key(url, side)] }

    @MainActor
    func load(_ url: URL, side: CGFloat) async -> NSImage? {
        let k = key(url, side)
        if let hit = images[k] { return hit }
        let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: side, height: side),
                                                   scale: 2, representationTypes: .icon)
        let gen = generation
        let rep = try? await withTaskCancellationHandler {
            try await QLThumbnailGenerator.shared.generateBestRepresentation(for: request)
        } onCancel: {
            QLThumbnailGenerator.shared.cancel(request)
        }
        guard let rep, gen == generation, !Task.isCancelled else { return nil }
        let image = IconCache.bitmap(rep.cgImage, side: side)
        images[k] = image
        return image
    }

    func removeAll() {
        images = [:]
        generation += 1
    }

    private func key(_ url: URL, _ side: CGFloat) -> String { "\(Int(side))@\(url.path)" }

    /// The service hands back 256 px in 16-bit extended sRGB (512 KB, which
    /// CoreAnimation then keeps a copy of per icon): redraw it as 8-bit sRGB at
    /// 2× the drawn size (36 KB). Never scales up.
    static func bitmap(_ image: CGImage, side: CGFloat) -> NSImage {
        let px = min(Int(side * 2), max(image.width, image.height))
        let size = NSSize(width: side, height: side)
        guard px > 0, let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return NSImage(cgImage: image, size: size)
        }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: px, height: px))
        return NSImage(cgImage: ctx.makeImage() ?? image, size: size)
    }
}

/// An app or file icon from the cache, with a quiet placeholder for the few
/// milliseconds until it's drawn.
struct FileIcon: View {
    let url: URL
    let side: CGFloat
    let cache: IconCache
    @State private var loaded: NSImage?
    @State private var failed = false

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
            guard !Task.isCancelled else { return }
            if let image { loaded = image } else { failed = true }
        }
    }
}
