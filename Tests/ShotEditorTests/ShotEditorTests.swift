import AppKit
import Foundation
import Testing
@testable import ShotEditor

// MARK: - Helpers

private func solidImage(width: Int, height: Int, rgba: (UInt8, UInt8, UInt8, UInt8) = (255, 255, 255, 255),
                        draw: ((CGContext) -> Void)? = nil) -> CGImage {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(srgbRed: CGFloat(rgba.0) / 255, green: CGFloat(rgba.1) / 255, blue: CGFloat(rgba.2) / 255, alpha: CGFloat(rgba.3) / 255))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    draw?(ctx)
    return ctx.makeImage()!
}

private func makeDoc(width: Int = 200, height: Int = 100, scale: CGFloat = 2) -> ShotDocument {
    ShotDocument(id: "test", created: Date(timeIntervalSince1970: 1_700_000_000), modified: Date(timeIntervalSince1970: 1_700_000_000),
                 kind: "area", scale: scale, pixelWidth: width, pixelHeight: height)
}

private func tempDir() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("shoteditor-tests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

// MARK: - Document

@Test func documentJSONRoundTrip() throws {
    var doc = makeDoc()
    doc.sourceAppName = "Safari"
    doc.captureRect = CGRect(x: 10, y: 20, width: 100, height: 50)
    doc.crop = CGRect(x: 5, y: 5, width: 50, height: 30)
    var arrow = Annotation(kind: .arrow, p1: CGPoint(x: 1, y: 2), p2: CGPoint(x: 30, y: 40), color: "#FF3B30", size: 4, style: 1)
    arrow.text = nil
    var text = Annotation(kind: .text, p1: CGPoint(x: 10, y: 10), p2: CGPoint(x: 10, y: 10), color: "#FFDC2C", size: 5)
    text.text = "Hello\nworld"
    var counter = Annotation(kind: .counter, p1: CGPoint(x: 50, y: 20), p2: CGPoint(x: 50, y: 20), color: "#0A84FF", size: 3)
    counter.number = 7
    var free = Annotation(kind: .freehand, p1: .zero, p2: .zero, color: "#000000", size: 2)
    free.path = [CGPoint(x: 0, y: 0), CGPoint(x: 3.5, y: 4.25)]
    var spot = Annotation(kind: .spotlight, p1: CGPoint(x: 1, y: 1), p2: CGPoint(x: 9, y: 9), color: "#FFFFFF", size: 1)
    spot.dim = 0.7
    doc.annotations = [arrow, text, counter, free, spot]

    let data = try doc.encoded()
    let back = try ShotDocument.decode(data)
    #expect(back == doc)
    // Human-readable JSON with stable keys.
    let json = String(decoding: data, as: UTF8.self)
    #expect(json.contains("\"kind\" : \"arrow\""))
    #expect(json.contains("\"text\" : \"Hello\\nworld\""))
}

@Test func documentGeometry() {
    var doc = makeDoc(width: 300, height: 200, scale: 2)
    #expect(doc.pointSize == CGSize(width: 150, height: 100))
    #expect(doc.canvasRect == CGRect(x: 0, y: 0, width: 150, height: 100))
    doc.crop = CGRect(x: 100, y: 50, width: 200, height: 200) // partly outside
    #expect(doc.canvasRect == CGRect(x: 100, y: 50, width: 50, height: 50))
    #expect(doc.isEdited)
    doc.annotations = [
        { var a = Annotation(kind: .counter, p1: .zero, p2: .zero, color: "#000", size: 1); a.number = 3; return a }(),
        { var a = Annotation(kind: .counter, p1: .zero, p2: .zero, color: "#000", size: 1); a.number = 9; return a }(),
    ]
    #expect(doc.nextCounterNumber == 10)
}

@Test func rectHelpers() {
    let r = CGRect(p1: CGPoint(x: 10, y: 20), p2: CGPoint(x: 0, y: 5))
    #expect(r == CGRect(x: 0, y: 5, width: 10, height: 15))
    // Dragging the top-left handle past the bottom-right flips cleanly.
    let box = CGRect(x: 0, y: 0, width: 10, height: 10)
    #expect(box.resized(handle: 0, to: CGPoint(x: 15, y: 20)) == CGRect(x: 10, y: 10, width: 5, height: 10))
    #expect(box.resized(handle: 5, to: CGPoint(x: 30, y: 99)) == CGRect(x: 0, y: 0, width: 30, height: 10))
    #expect(box.handlePoints.count == 8)
}

@Test func pointHelpers() {
    let o = CGPoint.zero
    let s = CGPoint(x: 10, y: 1).snapped45(from: o)
    #expect(abs(s.y) < 0.0001 && abs(s.x - hypot(10, 1)) < 0.0001)
    let d = CGPoint(x: 10, y: 9).snapped45(from: o)
    #expect(abs(d.x - d.y) < 0.0001)
    #expect(CGPoint(x: -3, y: 8).squared(from: o) == CGPoint(x: -8, y: 8))
    #expect(CGPoint(x: 5, y: 5).distance(toSegment: CGPoint(x: 0, y: 0), CGPoint(x: 10, y: 0)) == 5)
    #expect(CGPoint(x: -3, y: 4).distance(toSegment: CGPoint(x: 0, y: 0), CGPoint(x: 10, y: 0)) == 5)
}

@Test func annotationOffsetMovesPath() {
    var a = Annotation(kind: .highlight, p1: CGPoint(x: 1, y: 1), p2: CGPoint(x: 5, y: 1), color: "#FFDC2C", size: 3)
    a.path = [CGPoint(x: 1, y: 1), CGPoint(x: 5, y: 1)]
    a.offset(by: CGVector(dx: 2, dy: -1))
    #expect(a.p1 == CGPoint(x: 3, y: 0) && a.p2 == CGPoint(x: 7, y: 0))
    #expect(a.path == [CGPoint(x: 3, y: 0), CGPoint(x: 7, y: 0)])
}

@Test func hitTesting() {
    let line = Annotation(kind: .line, p1: CGPoint(x: 0, y: 0), p2: CGPoint(x: 100, y: 0), color: "#000", size: 2)
    #expect(Renderer.hitTest(line, CGPoint(x: 50, y: 2), tolerance: 3))
    #expect(!Renderer.hitTest(line, CGPoint(x: 50, y: 20), tolerance: 3))
    // Outline rectangles are hit on the stroke, filled ones anywhere inside.
    var rect = Annotation(kind: .rect, p1: CGPoint(x: 0, y: 0), p2: CGPoint(x: 100, y: 100), color: "#000", size: 2)
    #expect(Renderer.hitTest(rect, CGPoint(x: 0, y: 50), tolerance: 3))
    #expect(!Renderer.hitTest(rect, CGPoint(x: 50, y: 50), tolerance: 3))
    rect.style = 2
    #expect(Renderer.hitTest(rect, CGPoint(x: 50, y: 50), tolerance: 3))
    let oval = Annotation(kind: .oval, p1: CGPoint(x: 0, y: 0), p2: CGPoint(x: 100, y: 50), color: "#000", size: 2)
    #expect(Renderer.hitTest(oval, CGPoint(x: 100, y: 25), tolerance: 3))
    #expect(!Renderer.hitTest(oval, CGPoint(x: 50, y: 25), tolerance: 3))
}

@Test func arrowPathPointsAtTip() {
    let path = Renderer.arrowPath(CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 0), width: 6, style: 0)
    let box = path.boundingBoxOfPath
    #expect(abs(box.maxX - 100) < 0.01)
    #expect(box.minX < 1)
    #expect(path.contains(CGPoint(x: 99, y: 0)))
    #expect(Renderer.arrowPath(CGPoint(x: 0, y: 0), CGPoint(x: 0.1, y: 0), width: 6, style: 0).isEmpty)
}

@Test func hexColors() {
    let c = HexColor.components("#FF8000")!
    #expect(c.r == 1 && abs(c.g - 128.0 / 255) < 0.001 && c.b == 0 && c.a == 1)
    #expect(HexColor.components("#0f0")!.g == 1)
    #expect(HexColor.components("12345")  == nil)
    #expect(HexColor.hex(NSColor(srgbRed: 1, green: 0, blue: 0.5, alpha: 1)) == "#FF0080")
    #expect(HexColor.hex(r: 1, g: 2, b: 255) == "#0102FF")
    #expect(HexColor.contrasting("#FFFFFF") != HexColor.contrasting("#000000"))
}

// MARK: - Flatten

@Test func flattenOutputSize() throws {
    let image = solidImage(width: 400, height: 200)
    var doc = makeDoc(width: 400, height: 200, scale: 2)
    let fx = EffectCache()
    // No edits: the original is returned untouched.
    #expect(Renderer.flatten(doc, image: image, effects: fx) === image)
    doc.annotations = [Annotation(kind: .rect, p1: CGPoint(x: 10, y: 10), p2: CGPoint(x: 50, y: 50), color: "#FF0000", size: 3)]
    let full = try #require(Renderer.flatten(doc, image: image, effects: fx))
    #expect(full.width == 400 && full.height == 200)
    doc.crop = CGRect(x: 20, y: 10, width: 100.5, height: 40)
    let cropped = try #require(Renderer.flatten(doc, image: image, effects: fx))
    #expect(cropped.width == 201 && cropped.height == 80)
    // Region export and 1x downscale.
    let region = try #require(Renderer.flatten(doc, image: image, effects: fx, region: CGRect(x: 0, y: 0, width: 30, height: 20)))
    #expect(region.width == 60 && region.height == 40)
    let oneX = try #require(Renderer.flatten(doc, image: image, effects: fx, outputScale: 1))
    #expect(oneX.width == 101 && oneX.height == 40)
}

@Test func flattenDrawsAnnotationsInPlace() throws {
    let image = solidImage(width: 200, height: 200)
    var doc = makeDoc(width: 200, height: 200, scale: 2)
    var r = Annotation(kind: .rect, p1: CGPoint(x: 10, y: 10), p2: CGPoint(x: 40, y: 30), color: "#FF0000", size: 3)
    r.style = 2 // filled
    doc.annotations = [r]
    let out = try #require(Renderer.flatten(doc, image: image, effects: EffectCache()))
    let buf = try #require(PixelBuffer(image: out, rect: CGRect(x: 0, y: 0, width: 200, height: 200)))
    // Inside the filled rect (points 25,20 -> pixels 50,40, top-left origin) is red.
    let inside = buf.rgba(50, 40)
    #expect(inside.0 > 240 && inside.1 < 30 && inside.2 < 30)
    // Below it stays white.
    let outside = buf.rgba(50, 150)
    #expect(outside.0 > 240 && outside.1 > 240 && outside.2 > 240)
}

@Test func spotlightDimsOutside() throws {
    let image = solidImage(width: 100, height: 100)
    var doc = makeDoc(width: 100, height: 100, scale: 1)
    var s = Annotation(kind: .spotlight, p1: CGPoint(x: 20, y: 20), p2: CGPoint(x: 80, y: 80), color: "#FFFFFF", size: 1)
    s.dim = 0.5
    doc.annotations = [s]
    let out = try #require(Renderer.flatten(doc, image: image, effects: EffectCache()))
    let buf = try #require(PixelBuffer(image: out, rect: CGRect(x: 0, y: 0, width: 100, height: 100)))
    #expect(buf.rgba(50, 50).0 > 240)
    #expect(buf.rgba(5, 5).0 < 140)
}

// MARK: - Effects

@Test func backfillInterpolatesBorders() {
    // Left border black, right border white -> horizontal gradient inside.
    let w = 9, h = 3
    let black = Effects.RGBA(0, 0, 0, 255), white = Effects.RGBA(255, 255, 255, 255)
    let top = (0..<w).map { i -> Effects.RGBA in let v = Float(i + 1) / Float(w + 1) * 255; return Effects.RGBA(v, v, v, 255) }
    let out = Effects.backfillPixels(width: w, height: h, top: top, bottom: top,
                                     left: Array(repeating: black, count: h), right: Array(repeating: white, count: h),
                                     corners: (black, white, black, white))
    let first = out[0], mid = out[(1 * w + 4) * 4], last = out[(w - 1) * 4]
    #expect(first < 40 && last > 215)
    #expect(abs(Int(mid) - 128) < 8)
    // A flat border gives a flat fill.
    let red = Effects.RGBA(200, 10, 10, 255)
    let flat = Effects.backfillPixels(width: 4, height: 4, top: Array(repeating: red, count: 4), bottom: Array(repeating: red, count: 4),
                                      left: Array(repeating: red, count: 4), right: Array(repeating: red, count: 4), corners: (red, red, red, red))
    #expect(stride(from: 0, to: flat.count, by: 4).allSatisfy { flat[$0] == 200 && flat[$0 + 1] == 10 })
}

@Test func eraseRemovesTextOnFlatBackground() throws {
    // Grey background with a black "text" bar; erase over the bar.
    let image = solidImage(width: 120, height: 60, rgba: (180, 180, 180, 255)) { ctx in
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 40, y: 25, width: 40, height: 10))
    }
    let fx = EffectCache()
    let a = Annotation(kind: .erase, p1: CGPoint(x: 30, y: 15), p2: CGPoint(x: 90, y: 45), color: "#000", size: 5)
    let (patch, rect) = try #require(fx.patch(for: a, image: image, scale: 1))
    #expect(rect == CGRect(x: 30, y: 15, width: 60, height: 30))
    let buf = try #require(PixelBuffer(image: patch, rect: CGRect(x: 0, y: 0, width: patch.width, height: patch.height)))
    let p = buf.rgba(30, 15)
    #expect(abs(Int(p.0) - 180) <= 2)
}

@Test func eraseIgnoresGlyphsCutByTheEdge() throws {
    // Light background, a dark bar crossing the top and bottom edge of the erase rect.
    let image = solidImage(width: 100, height: 60, rgba: (240, 240, 240, 255)) { ctx in
        ctx.setFillColor(CGColor(gray: 0.1, alpha: 1))
        ctx.fill(CGRect(x: 45, y: 0, width: 6, height: 60))
    }
    let a = Annotation(kind: .erase, p1: CGPoint(x: 20, y: 15), p2: CGPoint(x: 80, y: 45), color: "#000", size: 5)
    let (patch, _) = try #require(EffectCache().patch(for: a, image: image, scale: 1))
    let buf = try #require(PixelBuffer(image: patch, rect: CGRect(x: 0, y: 0, width: patch.width, height: patch.height)))
    // The bar is gone from the middle of the fill (no vertical streak).
    #expect(buf.rgba(28, 15).0 > 200)
    #expect(Effects.dominantColor([Effects.RGBA(1, 2, 3, 255), Effects.RGBA(200, 0, 0, 255), Effects.RGBA(0, 200, 0, 255)]) == nil)
}

@Test func pixelateAndBlurKeepSize() throws {
    let image = solidImage(width: 100, height: 80) { ctx in
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 50, height: 80))
    }
    let px = try #require(Effects.pixelate(image, pixelRect: CGRect(x: 10, y: 10, width: 37, height: 21), block: 8))
    #expect(px.width == 37 && px.height == 21)
    let blur = try #require(Effects.blur(image, pixelRect: CGRect(x: 30, y: 10, width: 40, height: 40), sigma: 6, context: EffectCache.sharedCI()))
    #expect(blur.width == 40 && blur.height == 40)
}

// MARK: - Measurement & colour

@Test func spanFindsUniformRun() {
    let bg = PixelSampler.pack(255, 255, 255), edge = PixelSampler.pack(0, 0, 0), near = PixelSampler.pack(250, 250, 250)
    let line = [edge, edge, bg, bg, near, bg, bg, edge, bg]
    #expect(PixelSampler.span(in: line, at: 3, tolerance: 10) == (2, 6))
    #expect(PixelSampler.span(in: line, at: 3, tolerance: 2) == (2, 3))
    #expect(PixelSampler.span(in: line, at: 0, tolerance: 0) == (0, 1))
    #expect(PixelSampler.span(in: line, at: 8, tolerance: 0) == (8, 8))
}

@Test func samplerMeasuresGapBetweenEdges() throws {
    // White image, black vertical bars at x = 10 and x = 50 (pixels), scale 2.
    let image = solidImage(width: 100, height: 40) { ctx in
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 10, y: 0, width: 2, height: 40))
        ctx.fill(CGRect(x: 50, y: 0, width: 2, height: 40))
    }
    let s = PixelSampler(image: image, scale: 2)
    let (a, b) = try #require(s.measure(at: CGPoint(x: 15, y: 10), vertical: false))
    #expect(a.x == 6 && b.x == 25) // pixels 12...49 -> points 6...25 (19 pt gap)
    let c = try #require(s.color(at: CGPoint(x: 5.2, y: 3)))
    #expect(c.r == 0 && c.g == 0 && c.b == 0)
    let w = try #require(s.color(at: CGPoint(x: 15, y: 3)))
    #expect(w.r == 255)
    #expect(s.color(at: CGPoint(x: 500, y: 3)) == nil)
}

@Test func floodAndContentBounds() {
    let bg = PixelSampler.pack(255, 255, 255), ink = PixelSampler.pack(20, 20, 200)
    // 8x6 white with a blue 3x2 block at (2,1) and a stray blue pixel at (7,5).
    var px = [UInt32](repeating: bg, count: 8 * 6)
    for y in 1...2 { for x in 2...4 { px[y * 8 + x] = ink } }
    px[5 * 8 + 7] = ink
    let block = PixelSampler.floodBounds(px, width: 8, height: 6, start: (3, 2), tolerance: 8)
    #expect(block.map { [$0.minX, $0.minY, $0.maxX, $0.maxY] } == [2, 1, 4, 2])
    // Corner pixel is blue, but the background is the majority corner colour.
    let content = PixelSampler.contentBounds(px, width: 8, height: 6, tolerance: 8)
    #expect(content.map { [$0.minX, $0.minY, $0.maxX, $0.maxY] } == [2, 1, 7, 5])
    #expect(PixelSampler.contentBounds([UInt32](repeating: bg, count: 4), width: 2, height: 2, tolerance: 0) == nil)
    let white = PixelSampler.floodBounds(px, width: 8, height: 6, start: (0, 0), tolerance: 8)
    #expect(white.map { [$0.minX, $0.minY, $0.maxX, $0.maxY] } == [0, 0, 7, 5])
}

// MARK: - File names

@Test func filenamePatternExpansion() {
    var comps = DateComponents()
    comps.year = 2026; comps.month = 3; comps.day = 4; comps.hour = 5; comps.minute = 6; comps.second = 7
    let date = Calendar(identifier: .gregorian).date(from: comps)!
    #expect(FilenamePattern.expand("Screenshot {yyyy-MM-dd} at {HH.mm.ss}", date: date, app: nil, kind: nil) == "Screenshot 2026-03-04 at 05.06.07")
    #expect(FilenamePattern.expand("{app}-{kind}-{w}x{h}", date: date, app: "Safari", kind: "area", size: CGSize(width: 640, height: 480))
            == "Safari-area-640x480")
    #expect(FilenamePattern.expand("a/b:c", date: date, app: nil, kind: nil) == "a-b.c")
    #expect(FilenamePattern.expand("", date: date, app: nil, kind: nil) == "Screenshot")
    #expect(FilenamePattern.expand("{oops", date: date, app: nil, kind: nil) == "{oops")
}

@Test func uniqueURLAvoidsOverwrite() throws {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let first = FilenamePattern.uniqueURL(in: dir, name: "shot", ext: "png")
    #expect(first.lastPathComponent == "shot.png")
    try Data().write(to: first)
    #expect(FilenamePattern.uniqueURL(in: dir, name: "shot", ext: "png").lastPathComponent == "shot (2).png")
}

@Test func codecKeepsRetinaPointSize() throws {
    let image = solidImage(width: 64, height: 32)
    let data = try #require(ImageCodec.data(image, scale: 2, format: .png))
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let url = dir.appendingPathComponent("x.png")
    try data.write(to: url)
    let (loaded, scale) = try #require(ImageCodec.load(url))
    #expect(loaded.width == 64 && scale == 2)
    let rep = try #require(NSBitmapImageRep(data: data))
    #expect(rep.size == NSSize(width: 32, height: 16))
}

// MARK: - History

@Test func historyStoreRoundTripAndPrune() throws {
    let root = tempDir()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = HistoryStore(root: root)
    let now = Date()
    let old = store.add(image: solidImage(width: 20, height: 10), scale: 2, date: now.addingTimeInterval(-40 * 86_400), kind: "area",
                        rect: .zero, appName: "Old", bundleID: nil, async: false)
    let recent = store.add(image: solidImage(width: 40, height: 20), scale: 2, date: now.addingTimeInterval(-3600), kind: "window",
                           rect: CGRect(x: 1, y: 2, width: 20, height: 10), appName: "New", bundleID: "com.example", async: true)
    #expect(FileManager.default.fileExists(atPath: old.imageURL.path))
    #expect(FileManager.default.fileExists(atPath: old.thumbURL.path))

    // Annotations survive a reload.
    var doc = recent.doc
    doc.annotations = [Annotation(kind: .arrow, p1: .zero, p2: CGPoint(x: 5, y: 5), color: "#FF0000", size: 4)]
    store.update(doc, flattened: nil)
    let listed = store.entries()
    #expect(listed.map(\.id) == [recent.id, old.id]) // newest first
    #expect(listed.first?.doc.annotations.count == 1)
    #expect(store.loadImage(recent)?.width == 40)
    #expect(store.entry(forImageAt: recent.imageURL)?.id == recent.id)
    #expect(store.entry(forImageAt: URL(fileURLWithPath: "/tmp/original.png")) == nil)

    // Retention: 30 days removes only the old capture; 0 keeps everything.
    #expect(store.prune(retentionDays: 0, now: now).isEmpty)
    #expect(store.prune(retentionDays: 30, now: now, keeping: [old.id]).isEmpty)
    #expect(store.prune(retentionDays: 30, now: now) == [old.id])
    #expect(store.entries().map(\.id) == [recent.id])

    store.delete(recent.id)
    #expect(store.entries().isEmpty)
}

@Test func historyIDsSortChronologically() {
    let a = HistoryStore.makeID(date: Date(timeIntervalSince1970: 1_700_000_000))
    let b = HistoryStore.makeID(date: Date(timeIntervalSince1970: 1_700_000_100))
    #expect(a < b)
    #expect(a.count == "20231114-221320-abcd".count)
}

// MARK: - Settings

@Test func settingsDefaultsAndDecoding() throws {
    let s = EditorSettings()
    #expect(s.escAction == .copyAndClose)
    #expect(s.historyRetentionDays == 30)
    #expect(EditorTool(rawValue: s.defaultTool) == .select)
    let json = #"{"escAction":"close","defaultTool":"arrow"}"#
    // Partial sections decode once merged with defaults (as ConfigStore does).
    let merged = try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as! [String: Any]
    var dict = merged
    for (k, v) in try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any] { dict[k] = v }
    let decoded = try JSONDecoder().decode(EditorSettings.self, from: JSONSerialization.data(withJSONObject: dict))
    #expect(decoded.escAction == .close && decoded.defaultTool == "arrow")
    // Save options mirror the capture module's keys.
    let save = try JSONDecoder().decode(SaveSettings.self, from: Data(#"{"saveFolder":"~/Pictures","filenamePattern":"x","format":"jpeg","jpegQuality":0.8,"downscaleRetina":true,"playSound":false}"#.utf8))
    #expect(save.format == .jpeg && save.folderURL.path.hasSuffix("/Pictures"))
}

@Test func toolShortcutsMatchShottr() {
    // Shottr's Draw menu letters.
    let expected: [Character: EditorTool] = ["a": .arrow, "t": .text, "r": .rect, "d": .freehand, "m": .magnifier, "h": .highlight,
                                             "b": .blur, "s": .spotlight, "c": .counter, "o": .oval, "l": .line, "v": .select]
    for (k, t) in expected { #expect(EditorTool.forKey(k) == t) }
    #expect(Set(EditorTool.allCases.map(\.key)).count == EditorTool.allCases.count)
}
