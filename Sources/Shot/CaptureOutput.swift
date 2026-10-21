import AppKit
import AudioToolbox
import ImageIO
import UniformTypeIdentifiers
import ShotEditor
import BentoCore

/// What happens to a finished capture: editor / copy / save / pin, plus
/// history, sound and file naming.
enum CaptureOutput {
    static let log = BentoLog.make("shot")

    static func deliver(_ capture: CapturedImage, action: ShotSettings.AfterCapture? = nil) {
        let s = ShotSettings.current
        if s.playSound { playShutter() }
        let editor = ShotEditor.shared
        switch action ?? s.afterCapture {
        case .editor:
            editor.open(capture) // stores in history too
        case .copy:
            editor.record(capture)
            editor.copyToClipboard(capture.image, scale: capture.scale)
            HUD.show("Copied", symbol: "doc.on.doc")
        case .save:
            editor.record(capture)
            if let url = save(capture, settings: s) { HUD.show("Saved \(url.lastPathComponent)", symbol: "square.and.arrow.down") }
        case .copyAndSave:
            editor.record(capture)
            editor.copyToClipboard(capture.image, scale: capture.scale)
            let url = save(capture, settings: s)
            HUD.show(url == nil ? "Copied" : "Copied and saved", symbol: "doc.on.doc")
        case .pin:
            editor.record(capture)
            editor.pin(capture)
        }
    }

    // MARK: Sound

    private static var shutterID: SystemSoundID = 0

    /// The system screenshot sound, played asynchronously (System Sound
    /// Services never blocks the main thread, unlike a first NSSound load).
    static func playShutter() {
        if shutterID == 0 {
            let url = URL(fileURLWithPath: "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif")
            AudioServicesCreateSystemSoundID(url as CFURL, &shutterID)
        }
        if shutterID != 0 { AudioServicesPlaySystemSound(shutterID) }
    }

    // MARK: Saving

    static func folderURL(_ settings: ShotSettings) -> URL {
        let path = (settings.saveFolder as NSString).expandingTildeInPath
        return URL(fileURLWithPath: path.isEmpty ? NSHomeDirectory() + "/Desktop" : path, isDirectory: true)
    }

    @discardableResult
    static func save(_ capture: CapturedImage, settings: ShotSettings) -> URL? {
        let folder = folderURL(settings)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            HUD.show("Can't create \(folder.path)", symbol: "exclamationmark.triangle")
            return nil
        }
        let base = filename(pattern: settings.filenamePattern, date: capture.date, app: capture.sourceAppName,
                            kind: capture.kind.rawValue, size: capture.pointSize)
        let url = uniqueURL(folder: folder, base: base, ext: settings.format.fileExtension)
        var image = capture.image
        var scale = capture.scale
        if settings.downscaleRetina, scale > 1, let small = downscale(image, by: scale) {
            image = small
            scale = 1
        }
        guard write(image, scale: scale, to: url, format: settings.format, quality: settings.jpegQuality) else {
            HUD.show("Couldn't save screenshot", symbol: "exclamationmark.triangle")
            return nil
        }
        return url
    }

    /// Writes PNG/JPEG with DPI metadata (144 dpi for Retina, like Shottr).
    static func write(_ image: CGImage, scale: CGFloat, to url: URL, format: ShotSettings.ImageFormat, quality: Double) -> Bool {
        let type = format == .png ? UTType.png : UTType.jpeg
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else { return false }
        var props: [CFString: Any] = [
            kCGImagePropertyDPIWidth: 72 * scale,
            kCGImagePropertyDPIHeight: 72 * scale,
        ]
        if format == .jpeg { props[kCGImageDestinationLossyCompressionQuality] = quality }
        var img = image
        if format == .jpeg, let flat = flatten(image) { img = flat } // JPEG has no alpha
        CGImageDestinationAddImage(dest, img, props as CFDictionary)
        return CGImageDestinationFinalize(dest)
    }

    static func downscale(_ image: CGImage, by scale: CGFloat) -> CGImage? {
        let w = max(1, Int((CGFloat(image.width) / scale).rounded())), h = max(1, Int((CGFloat(image.height) / scale).rounded()))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: PixelFrame.colorSpace, bitmapInfo: PixelFrame.bitmapInfo) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    private static func flatten(_ image: CGImage) -> CGImage? {
        guard image.alphaInfo != .none, image.alphaInfo != .noneSkipFirst, image.alphaInfo != .noneSkipLast else { return nil }
        guard let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: PixelFrame.colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return ctx.makeImage()
    }

    /// Expands `{…}` tokens: `{app}`, `{kind}`, `{w}`, `{h}`, anything else
    /// is a date format (`{yyyy-MM-dd}`, `{HH.mm.ss}`). Path separators and
    /// colons are replaced so the result is always a single file name.
    static func filename(pattern: String, date: Date, app: String?, kind: String, size: CGSize) -> String {
        var out = ""
        var token: String?
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        for ch in pattern {
            if ch == "{" && token == nil { token = ""; continue }
            if ch == "}", let t = token {
                switch t {
                case "app": out += app ?? "Screen"
                case "kind": out += kind
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
        let cleaned = out.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "Screenshot" : cleaned
    }

    static func uniqueURL(folder: URL, base: String, ext: String) -> URL {
        var url = folder.appendingPathComponent(base).appendingPathExtension(ext)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = folder.appendingPathComponent("\(base) (\(n))").appendingPathExtension(ext)
            n += 1
        }
        return url
    }
}
