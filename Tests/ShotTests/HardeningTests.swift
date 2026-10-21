import Testing
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import ShotEditor
@testable import Shot

// Regression tests from the QA/hardening pass: inputs that used to trap or
// misbehave (null rects, NaN, tiny OCR images, huge settings, bad folders).

@Suite struct HardeningTests {
    @Test func pixelRectOfNullOrNonFiniteRectIsEmpty() {
        #expect(ShotGeometry.pixelRect(local: .null, scale: 2, imageWidth: 100, imageHeight: 100) == .zero)
        #expect(ShotGeometry.pixelRect(local: CGRect(x: 0, y: 0, width: 10, height: 10), scale: .nan, imageWidth: 100, imageHeight: 100) == .zero)
        let inf = CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 10)
        #expect(ShotGeometry.pixelRect(local: inf, scale: 2, imageWidth: 100, imageHeight: 100) == CGRect(x: 0, y: 0, width: 100, height: 20))
        // An empty window/display intersection (the copy-text window path).
        let none = CGRect(x: 0, y: 0, width: 10, height: 10).intersection(CGRect(x: 50, y: 50, width: 10, height: 10))
        #expect(ShotGeometry.pixelRect(local: ShotGeometry.localRect(none, in: CGRect(x: 0, y: 0, width: 100, height: 100)),
                                       scale: 2, imageWidth: 200, imageHeight: 200) == .zero)
    }

    @Test func intConversionNeverTraps() {
        #expect(ShotGeometry.int(.nan) == 0)
        #expect(ShotGeometry.int(.infinity) > 0)
        #expect(ShotGeometry.int(-.infinity) < 0)
        #expect(ShotGeometry.int(12.9) == 12)
        #expect(ShotGeometry.pixel(at: CGPoint(x: CGFloat.nan, y: 3), scale: 2) == (0, 6))
    }

    @Test func colorFormatCycles() {
        var f = ColorFormat.hex
        var seen: [ColorFormat] = []
        for _ in ColorFormat.allCases { seen.append(f); f = f.next }
        #expect(f == .hex)
        #expect(Set(seen.map(\.rawValue)).count == ColorFormat.allCases.count)
    }

    @Test func scrollMaxHeightIsCappedByPixelBudget() {
        #expect(ScrollStitcher.cappedMaxHeight(20_000, width: 1600) == 20_000)
        #expect(ScrollStitcher.cappedMaxHeight(200_000, width: 2880) == ScrollStitcher.pixelBudget / 2880)
        #expect(ScrollStitcher.cappedMaxHeight(10, width: 800) == 1000)
        #expect(ScrollStitcher.cappedMaxHeight(200_000, width: 1_000_000) == 1000)
    }

    @Test func consumingMakeImageMatches() throws {
        let doc = SyntheticDoc(seed: 3)
        func build() -> ScrollStitcher {
            let st = ScrollStitcher(first: doc.frame(offset: 0, visible: 300))
            for o in [180, 400, 650] { st.add(doc.frame(offset: o, visible: 300)) }
            return st
        }
        let a = try #require(build().makeImage())
        let b = try #require(build().makeImage(consume: true))
        #expect(a.height == 950 && b.height == 950)
        #expect(pixels(of: a) == pixels(of: b))
        let up = try #require(build().makeImage(flipped: true))
        let upConsumed = try #require(build().makeImage(flipped: true, consume: true))
        #expect(pixels(of: up) == pixels(of: upConsumed))
    }

    @Test func shadowCanvasKeepsWindowAtOneToOne() {
        let content = CGSize(width: 1000, height: 600)
        let probe = CGSize(width: 500, height: 300)
        // Window body 440×250 in the 500×300 probe (30 px shadow left/right).
        let bb = CGRect(x: 30, y: 15, width: 440, height: 250)
        let c = ScreenGrabber.shadowCanvas(content: content, probe: probe, opaque: bb, scale: 2)
        #expect(abs(c.width - 1000 / (440.0 / 500)) <= 1)
        #expect(abs(c.height - 600 / (250.0 / 300)) <= 1)
        // A translucent sidebar on the left must not be read as shadow.
        let sidebar = CGRect(x: 120, y: 15, width: 350, height: 250)
        #expect(ScreenGrabber.shadowCanvas(content: content, probe: probe, opaque: sidebar, scale: 2).width == c.width)
        // A mostly transparent window can't ask for a huge image.
        let tiny = CGRect(x: 240, y: 140, width: 10, height: 10)
        let t = ScreenGrabber.shadowCanvas(content: content, probe: probe, opaque: tiny, scale: 2)
        #expect(t.width <= 1000 + 2 * 160 * 2 && t.height <= 600 + 2 * 160 * 2)
        // No opaque pixels: plain content size.
        #expect(ScreenGrabber.shadowCanvas(content: content, probe: probe, opaque: nil, scale: 2) == content)
    }

    @Test func safeScaleNeverZero() {
        #expect(ScreenGrabber.safeScale(2) == 2)
        #expect(ScreenGrabber.safeScale(0, fallback: 2) == 2)
        #expect(ScreenGrabber.safeScale(.nan, fallback: 1) == 1)
        #expect(ScreenGrabber.safeScale(.infinity, fallback: 0) == 1)
    }

    @Test func windowPaddingIsClamped() {
        #expect(WindowComposer.clampedPadding(-5) == 0)
        #expect(WindowComposer.clampedPadding(1_000_000) == 500)
        #expect(WindowComposer.canvasSize(window: CGSize(width: 10, height: 10), padding: 1_000_000, scale: 1) == CGSize(width: 1010, height: 1010))
    }
}

/// White image, optionally with black text drawn by CoreText.
func textImage(width: Int, height: Int, text: String? = nil) -> CGImage {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: PixelFrame.colorSpace, bitmapInfo: PixelFrame.bitmapInfo)!
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    if let text {
        let font = CTFontCreateWithName("Helvetica" as CFString, 48, nil)
        let attr = NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
        ])
        ctx.textPosition = CGPoint(x: 20, y: CGFloat(height) / 2 - 16)
        CTLineDraw(CTLineCreateWithAttributedString(attr), ctx)
    }
    return ctx.makeImage()!
}

@Suite struct OCRTests {
    /// Vision both calls the request handler with an error and throws from
    /// `perform` for images of 2 px or less; resuming twice trapped.
    @Test func tinyAndBlankImagesHaveNoText() async throws {
        for (w, h) in [(1, 1), (2, 2), (2, 500), (500, 2), (3, 3), (200, 120)] {
            let text = try await OCRText.recognize(textImage(width: w, height: h))
            #expect(text.isEmpty, "\(w)×\(h)")
        }
        #expect(!OCRText.canRecognize(textImage(width: 2, height: 40)))
        #expect(OCRText.canRecognize(textImage(width: 3, height: 3)))
    }

    @Test func recognizesRenderedText() async throws {
        let text = try await OCRText.recognize(textImage(width: 640, height: 120, text: "Bento capture 42"))
        #expect(text.contains("Bento"))
        #expect(text.contains("42"))
    }

    @Test func resumeOnceIgnoresLaterResumes() async throws {
        let v: Int = try await withCheckedThrowingContinuation { cont in
            let once = ResumeOnce(cont)
            once.resume(returning: 1)
            once.resume(throwing: CocoaError(.featureUnsupported))
            once.resume(returning: 2)
        }
        #expect(v == 1)
    }
}

@Suite struct SaveTests {
    func capture(_ w: Int = 40, _ h: Int = 20, scale: CGFloat = 2) -> CapturedImage {
        let frame = PixelFrame(width: w, height: h, pixels: [UInt32](repeating: 0xFF33_66CC, count: w * h))
        return CapturedImage(image: frame.makeImage()!, scale: scale, rect: .zero, kind: .area, sourceAppName: "Safari")
    }

    func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("shot-save-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test func createsMissingFolderAndAvoidsCollisions() throws {
        let root = try tempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        var s = ShotSettings()
        s.saveFolder = root.appendingPathComponent("a/b c").path
        s.filenamePattern = "Shot {w}x{h}"
        let first = try CaptureOutput.save(capture(), settings: s).get()
        let second = try CaptureOutput.save(capture(), settings: s).get()
        #expect(first.lastPathComponent == "Shot 20x10.png")
        #expect(second.lastPathComponent == "Shot 20x10 (2).png")
        #expect(FileManager.default.fileExists(atPath: second.path))
    }

    @Test func unwritableFolderFailsWithMessage() throws {
        let root = try tempDir()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
            try? FileManager.default.removeItem(at: root)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: root.path)
        var s = ShotSettings()
        s.saveFolder = root.path
        guard case let .failure(e) = CaptureOutput.save(capture(), settings: s) else { Issue.record("saved into a read-only folder"); return }
        #expect(e.message.contains("Can't write"))
        // A file where the folder should be.
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("shot-file-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: file.path, contents: Data())
        defer { try? FileManager.default.removeItem(at: file) }
        s.saveFolder = file.path
        guard case let .failure(e2) = CaptureOutput.save(capture(), settings: s) else { Issue.record("saved into a file"); return }
        #expect(e2.message.contains("Can't create"))
    }

    @Test func jpegQualityAndDownscale() throws {
        let root = try tempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(CaptureOutput.jpegQuality(90) == 0.9)
        #expect(CaptureOutput.jpegQuality(0.75) == 0.75)
        #expect(CaptureOutput.jpegQuality(-1) == 0.1)
        #expect(CaptureOutput.jpegQuality(.nan) == 0.9)
        var s = ShotSettings()
        s.saveFolder = root.path
        s.format = .jpeg
        s.jpegQuality = 85 // hand-edited percentage
        s.downscaleRetina = true
        let url = try CaptureOutput.save(capture(400, 200), settings: s).get()
        #expect(url.pathExtension == "jpg")
        let src = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
        let props = try #require(CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any])
        #expect((props[kCGImagePropertyPixelWidth] as? Int) == 200)
        #expect((props[kCGImagePropertyDPIWidth] as? Double) == 72)
    }

    @Test func filenamesAreSafe() {
        let date = Date(timeIntervalSince1970: 0)
        #expect(CaptureOutput.filename(pattern: "..hidden", date: date, app: nil, kind: "area", size: .zero) == "hidden")
        let long = CaptureOutput.filename(pattern: String(repeating: "é", count: 400), date: date, app: nil, kind: "area", size: .zero)
        #expect(long.utf8.count <= 200)
        #expect(!CaptureOutput.filename(pattern: "{w}", date: date, app: nil, kind: "area", size: CGSize(width: CGFloat.infinity, height: 1)).isEmpty)
        #expect(CaptureOutput.filename(pattern: "{app}", date: date, app: "a/b:c", kind: "area", size: .zero) == "a-b.c")
    }
}
