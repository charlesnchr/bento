import AppKit
import ImageIO
import UniformTypeIdentifiers
import BentoCore

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
        guard let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return load(src)
    }

    static func load(_ data: Data) -> (CGImage, CGFloat)? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return load(src)
    }

    private static func load(_ src: CGImageSource) -> (CGImage, CGFloat)? {
        guard CGImageSourceGetCount(src) > 0,
              let image = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              image.width > 0, image.height > 0
        else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let dpi = (props?[kCGImagePropertyDPIWidth] as? NSNumber)?.doubleValue ?? 72
        return (image, scale(dpi: dpi))
    }

    /// Screenshots are 72, 144 or 216 dpi (1x–3x); anything else (96 dpi
    /// exports, 300 dpi scans, garbage) opens at 1x.
    static func scale(dpi: Double) -> CGFloat {
        guard dpi.isFinite, dpi > 0 else { return 1 }
        let ratio = dpi / 72, r = ratio.rounded()
        return r >= 1 && r <= 3 && abs(ratio - r) < 0.1 ? CGFloat(r) : 1
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

/// HUD messages and beeps, mutable so headless tests don't flash windows on
/// the screen or make noise.
enum Feedback {
    static var muted = false

    static func hud(_ text: String, symbol: String? = nil, duration: TimeInterval = 1.1) {
        guard !muted else { return }
        HUD.show(text, symbol: symbol, duration: duration)
    }

    static func beep() {
        guard !muted else { return }
        NSSound.beep()
    }
}

enum Clipboard {
    /// The pasteboard copies go to (tests use a private one).
    static var pasteboard = NSPasteboard.general

    /// Puts PNG on the pasteboard and promises TIFF lazily: an uncompressed
    /// TIFF of a Retina fullscreen capture is ~24 MB, and most apps take PNG.
    /// Images above this many pixels are PNG-encoded off the main thread (a
    /// 14k-px scrolling capture takes seconds); smaller ones are copied at once.
    static let backgroundEncodeThreshold = 8_000_000
    private static var copyGeneration = 0

    static func copy(_ image: CGImage, scale: CGFloat, to pb: NSPasteboard = Clipboard.pasteboard) {
        let pointSize = NSSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale)
        copyGeneration += 1
        guard image.width * image.height > backgroundEncodeThreshold else {
            if let png = encodePNG(image, scale: scale, pointSize: pointSize) { write(png, pointSize: pointSize, to: pb) }
            return
        }
        // A newer copy supersedes this one if it finishes first.
        let generation = copyGeneration
        DispatchQueue.global(qos: .userInitiated).async {
            let png = encodePNG(image, scale: scale, pointSize: pointSize)
            DispatchQueue.main.async {
                guard generation == copyGeneration, let png else { return }
                write(png, pointSize: pointSize, to: pb)
            }
        }
    }

    private static func encodePNG(_ image: CGImage, scale: CGFloat, pointSize: NSSize) -> Data? {
        // The PNG encoder's buffers are big for large captures; free them right away.
        autoreleasepool {
            ImageCodec.data(image, scale: scale, format: .png) ?? {
                let rep = NSBitmapImageRep(cgImage: image)
                rep.size = pointSize
                return rep.representation(using: .png, properties: [:])
            }()
        }
    }

    private static func write(_ png: Data, pointSize: NSSize, to pb: NSPasteboard) {
        pb.clearContents()
        let item = NSPasteboardItem()
        item.setData(png, forType: .png)
        let provider = LazyTIFFProvider(png: png, pointSize: pointSize)
        item.setDataProvider(provider, forTypes: [.tiff])
        LazyTIFFProvider.current = provider
        pb.writeObjects([item])
    }

    static func copyText(_ s: String, to pb: NSPasteboard = Clipboard.pasteboard) {
        pb.clearContents()
        pb.setString(s, forType: .string)
    }

    /// Image on the pasteboard (pasted screenshots, copied files). Image data
    /// is decoded once into a bitmap, with the scale taken from its DPI.
    static func image(from pb: NSPasteboard = Clipboard.pasteboard) -> (CGImage, CGFloat)? {
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           let url = urls.first, let loaded = ImageCodec.load(url) {
            return loaded
        }
        let types: [NSPasteboard.PasteboardType] = [.png, .tiff, NSPasteboard.PasteboardType(UTType.jpeg.identifier),
                                                    NSPasteboard.PasteboardType(UTType.heic.identifier)]
        for type in types where pb.availableType(from: [type]) != nil {
            if let data = pb.data(forType: type), let loaded = ImageCodec.load(data) { return loaded }
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
        guard type == .tiff, let tiff = tiffData() else { return }
        item.setData(tiff, forType: .tiff)
    }

    /// LZW-compressed TIFF at the right point size. Uncompressed, a 15 000 px
    /// scrolling capture is 170 MB (held by the pasteboard item for as long
    /// as Bento owns the clipboard); LZW makes screenshots 10–100× smaller.
    func tiffData() -> Data? {
        autoreleasepool {
            guard let rep = NSBitmapImageRep(data: png) else { return nil }
            rep.size = pointSize
            return rep.tiffRepresentation(using: .lzw, factor: 0) ?? rep.tiffRepresentation
        }
    }

    func pasteboardFinishedWithDataProvider(_ pasteboard: NSPasteboard) {
        if LazyTIFFProvider.current === self { LazyTIFFProvider.current = nil }
    }
}
