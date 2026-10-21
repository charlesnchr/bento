import AppKit
import ImageIO
import UniformTypeIdentifiers

enum FilenamePattern {
    /// Same syntax as the capture module: `{app}`, `{kind}`, `{w}`, `{h}`;
    /// anything else in braces is a date format (`{yyyy-MM-dd}`, `{HH.mm.ss}`).
    /// Path separators and colons are replaced so the result is one file name.
    static func expand(_ pattern: String, date: Date, app: String?, kind: String?, size: CGSize = .zero) -> String {
        var out = ""
        var token: String?
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        for ch in pattern {
            if ch == "{" && token == nil { token = ""; continue }
            if ch == "}", let t = token {
                switch t {
                case "app": out += app ?? "Screen"
                case "kind": out += kind ?? ""
                case "w": out += "\(Int(size.width))"
                case "h": out += "\(Int(size.height))"
                default:
                    df.dateFormat = t
                    out += df.string(from: date)
                }
                token = nil
                continue
            }
            if token != nil { token!.append(ch) } else { out.append(ch) }
        }
        if let t = token { out += "{" + t }
        var cleaned = out.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        return cleaned.isEmpty ? "Screenshot" : cleaned
    }

    /// `folder/name.ext`, or `name (2).ext`, `name (3).ext`... if taken.
    static func uniqueURL(in folder: URL, name: String, ext: String) -> URL {
        var url = folder.appendingPathComponent(name).appendingPathExtension(ext)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = folder.appendingPathComponent("\(name) (\(n))").appendingPathExtension(ext)
            n += 1
        }
        return url
    }
}

enum ImageCodec {
    /// Encodes with DPI metadata (72 x scale) so Retina images keep their point size.
    static func data(_ image: CGImage, scale: CGFloat, format: EditorSettings.Format, quality: Double = 0.9) -> Data? {
        let type = (format == .png ? UTType.png : UTType.jpeg).identifier as CFString
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, type, 1, nil) else { return nil }
        var props: [CFString: Any] = [
            kCGImagePropertyDPIWidth: 72 * scale,
            kCGImagePropertyDPIHeight: 72 * scale,
        ]
        if format == .jpeg { props[kCGImageDestinationLossyCompressionQuality] = quality }
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    static func write(_ image: CGImage, scale: CGFloat, format: EditorSettings.Format, quality: Double = 0.9, to url: URL) throws {
        guard let data = data(image, scale: scale, format: format, quality: quality) else {
            throw CocoaError(.fileWriteUnknown)
        }
        try data.write(to: url, options: .atomic)
    }

    /// Loads an image file; scale comes from its DPI (144 dpi -> 2x).
    static func load(_ url: URL) -> (CGImage, CGFloat)? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let dpi = (props?[kCGImagePropertyDPIWidth] as? NSNumber)?.doubleValue ?? 72
        let scale = max(1, (dpi / 72).rounded())
        return (image, CGFloat(scale))
    }

    /// Resamples to a different pixels-per-point scale (e.g. 2x -> 1x).
    static func resample(_ image: CGImage, from scale: CGFloat, to newScale: CGFloat) -> CGImage {
        guard scale != newScale, scale > 0 else { return image }
        let w = max(1, Int((CGFloat(image.width) / scale * newScale).rounded()))
        let h = max(1, Int((CGFloat(image.height) / scale * newScale).rounded()))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: Renderer.outputColorSpace(image), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return image }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage() ?? image
    }

    /// Small JPEG preview for the history grid.
    static func thumbnail(_ image: CGImage, maxPixels: CGFloat = 480) -> Data? {
        let s = min(1, maxPixels / CGFloat(max(image.width, image.height)))
        let w = max(1, Int(CGFloat(image.width) * s)), h = max(1, Int(CGFloat(image.height) * s))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let small = ctx.makeImage() else { return nil }
        return data(small, scale: 1, format: .jpeg, quality: 0.8)
    }
}

enum Clipboard {
    /// Puts PNG on the pasteboard and promises TIFF lazily: an uncompressed
    /// TIFF of a Retina fullscreen capture is ~24 MB, and most apps take PNG.
    static func copy(_ image: CGImage, scale: CGFloat) {
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = NSSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale)
        guard let png = ImageCodec.data(image, scale: scale, format: .png) ?? rep.representation(using: .png, properties: [:]) else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        let item = NSPasteboardItem()
        item.setData(png, forType: .png)
        let provider = LazyTIFFProvider(png: png, pointSize: rep.size)
        item.setDataProvider(provider, forTypes: [.tiff])
        LazyTIFFProvider.current = provider
        pb.writeObjects([item])
    }

    static func copyText(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }

    /// Image on the pasteboard (pasted screenshots, copied files).
    static func image() -> (CGImage, CGFloat)? {
        let pb = NSPasteboard.general
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           let url = urls.first, let loaded = ImageCodec.load(url) {
            return loaded
        }
        guard let img = NSImage(pasteboard: pb), let rep = img.representations.first,
              let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let scale = img.size.width > 0 ? max(1, (CGFloat(rep.pixelsWide) / img.size.width).rounded()) : 1
        return (cg, scale)
    }
}

/// Produces TIFF from the stored PNG only when a paste target asks for it.
final class LazyTIFFProvider: NSObject, NSPasteboardItemDataProvider {
    /// The pasteboard doesn't retain providers; keep the latest alive.
    static var current: LazyTIFFProvider?
    private let png: Data
    private let pointSize: NSSize

    init(png: Data, pointSize: NSSize) {
        self.png = png
        self.pointSize = pointSize
    }

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        guard type == .tiff, let rep = NSBitmapImageRep(data: png) else { return }
        rep.size = pointSize
        if let tiff = rep.tiffRepresentation { item.setData(tiff, forType: .tiff) }
    }

    func pasteboardFinishedWithDataProvider(_ pasteboard: NSPasteboard) {
        if LazyTIFFProvider.current === self { LazyTIFFProvider.current = nil }
    }
}
