import AppKit
import ImageIO
import UniformTypeIdentifiers
import Vision
import BentoCore

/// Turns copied image bytes into a stored image file + thumbnail. Runs off
/// the main thread.
enum ImageProcessor {
    static let thumbnailPixels = 192

    struct Stored {
        var imageFile: String
        var thumbFile: String?
        var imageType: String
        var width: Int
        var height: Int
        var bytes: Int
    }

    static func store(data: Data, type: String, imagesDir: URL, thumbsDir: URL) -> Stored? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(src) > 0 else { return nil }
        // Multi-representation TIFFs (1x + 2x): use the largest.
        var index = 0
        var best = 0
        for i in 0..<CGImageSourceGetCount(src) {
            let (w, h) = pixelSize(src, i)
            if w * h > best { best = w * h; index = i }
        }
        let (width, height) = pixelSize(src, index)
        guard width > 0, height > 0 else { return nil }

        let name = UUID().uuidString
        var outData = data
        var outType = type
        var ext = UTType(type)?.preferredFilenameExtension ?? "img"
        // TIFF is uncompressed: keep PNG instead (lossless and much smaller).
        if type == UTType.tiff.identifier || CGImageSourceGetCount(src) > 1 {
            guard let cg = CGImageSourceCreateImageAtIndex(src, index, nil), let png = encode(cg, as: .png) else { return nil }
            outData = png
            outType = UTType.png.identifier
            ext = "png"
        }
        let imageFile = "\(name).\(ext)"
        do {
            try outData.write(to: imagesDir.appendingPathComponent(imageFile), options: .atomic)
        } catch {
            return nil
        }
        var thumbFile: String?
        var thumbBytes = 0
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: thumbnailPixels,
        ]
        if let thumb = CGImageSourceCreateThumbnailAtIndex(src, index, opts as CFDictionary), let png = encode(thumb, as: .png) {
            let f = "\(name).png"
            if (try? png.write(to: thumbsDir.appendingPathComponent(f), options: .atomic)) != nil {
                thumbFile = f
                thumbBytes = png.count
            }
        }
        return Stored(imageFile: imageFile, thumbFile: thumbFile, imageType: outType, width: width, height: height,
                      bytes: outData.count + thumbBytes)
    }

    static func pixelSize(_ src: CGImageSource, _ i: Int) -> (Int, Int) {
        guard let p = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any] else { return (0, 0) }
        var w = (p[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
        var h = (p[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
        if let o = (p[kCGImagePropertyOrientation] as? NSNumber)?.intValue, o >= 5 { swap(&w, &h) }
        return (w, h)
    }

    static func encode(_ image: CGImage, as type: UTType) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }

    /// Downsampled image for display (never decodes the full image into a view).
    static func downsampled(_ url: URL, maxPixels: Int) -> CGImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
    }
}

/// On-device text recognition (Vision), used to make images searchable.
enum TextRecognition {
    /// Keeps memory bounded while leaving tall scrolling captures readable.
    static let pixelBudget = 24_000_000.0

    static func recognize(url: URL) -> String? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let (w, h) = ImageProcessor.pixelSize(src, 0)
        guard w > 0, h > 0 else { return nil }
        let scale = min(1, (pixelBudget / Double(w * h)).squareRoot())
        let maxSide = Int((Double(max(w, h)) * scale).rounded(.down))
        guard let cg = ImageProcessor.downsampled(url, maxPixels: maxSide) else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        do {
            try VNImageRequestHandler(cgImage: cg).perform([request])
        } catch {
            return nil
        }
        let obs = request.results ?? []
        let lines = obs
            .sorted { a, b in
                abs(a.boundingBox.midY - b.boundingBox.midY) > 0.01
                    ? a.boundingBox.midY > b.boundingBox.midY
                    : a.boundingBox.minX < b.boundingBox.minX
            }
            .compactMap { $0.topCandidates(1).first?.string }
        return lines.joined(separator: "\n")
    }
}

/// Recognises text in stored images one at a time at background priority,
/// caching the result in the database. Idle when there is nothing to do.
final class OCRWorker {
    private let queue = DispatchQueue(label: "com.charles.bento.clipboard.ocr", qos: .background)
    private weak var store: ClipStore?
    private var running = false
    var enabled = true

    init(store: ClipStore) { self.store = store }

    func kick() {
        guard enabled, !running, let store, let next = store.nextPendingOCR(), let url = store.imageURL(next.file) else { return }
        running = true
        queue.async { [weak self] in
            let text = autoreleasepool { TextRecognition.recognize(url: url) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.running = false
                self.store?.setOCR(next.id, text: text)
                self.kick()
            }
        }
    }

    /// Recognises one image now (for "Copy Text from Image" before the
    /// background pass got to it).
    func recognizeNow(id: Int64, url: URL, completion: @escaping (String?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let text = TextRecognition.recognize(url: url)
            DispatchQueue.main.async {
                self?.store?.setOCR(id, text: text)
                completion(text)
            }
        }
    }
}
