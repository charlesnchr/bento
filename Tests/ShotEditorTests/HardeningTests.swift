import AppKit
import Foundation
import Testing
import UniformTypeIdentifiers
@testable import ShotEditor

// Damaged history, odd image sizes, OCR edge cases and the helpers behind the
// large-image handling.

private func tempDir() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("shoteditor-hardening-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func solid(_ w: Int, _ h: Int, rgb: (CGFloat, CGFloat, CGFloat) = (1, 1, 1)) -> CGImage {
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(srgbRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()!
}

/// Black text on white, top-left origin lines.
private func textImage(_ lines: [String], width: Int = 900, lineHeight: CGFloat = 60) -> CGImage {
    let h = Int(lineHeight) * (lines.count + 1)
    let ctx = CGContext(data: nil, width: width, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: h))
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    for (i, line) in lines.enumerated() {
        NSAttributedString(string: line, attributes: [.font: NSFont.systemFont(ofSize: 32), .foregroundColor: NSColor.black])
            .draw(at: CGPoint(x: 30, y: CGFloat(h) - lineHeight * CGFloat(i + 1) - 10))
    }
    NSGraphicsContext.restoreGraphicsState()
    return ctx.makeImage()!
}

private func writeDoc(_ json: String, in root: URL, id: String, image: CGImage? = solid(40, 20)) throws {
    let dir = root.appendingPathComponent(id, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try json.data(using: .utf8)!.write(to: dir.appendingPathComponent(HistoryStore.docName))
    if let image { try ImageCodec.write(image, scale: 2, format: .png, to: dir.appendingPathComponent(HistoryStore.imageName)) }
}

private func docJSON(id: String, created: String = "2026-10-01T10:00:00Z", scale: String = "2", crop: String = "null",
                     annotations: String = "[]") -> String {
    """
    {"annotations":\(annotations),"captureRect":[[0,0],[0,0]],"created":"\(created)","id":"\(id)","kind":"area",
     "modified":"\(created)","pixelHeight":20,"pixelWidth":40,"scale":\(scale),"crop":\(crop),"version":1}
    """
}

// MARK: - History

@Test func damagedAndPartialHistoryEntriesAreSkippedOrRepaired() throws {
    let root = tempDir()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = HistoryStore(root: root)
    try writeDoc(docJSON(id: "20261001-100000-good"), in: root, id: "20261001-100000-good")
    // Truncated mid-write, garbage, empty, a folder without a document, a stray file.
    let full = docJSON(id: "20261002-100000-part")
    try writeDoc(String(full.prefix(full.count / 2)), in: root, id: "20261002-100000-part")
    try writeDoc("not json at all", in: root, id: "20261003-100000-junk")
    try writeDoc("", in: root, id: "20261004-100000-empty")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("20261005-100000-nodoc"), withIntermediateDirectories: true)
    try Data("x".utf8).write(to: root.appendingPathComponent("stray.txt"))
    // Readable but hostile values, and an id that doesn't match its folder.
    let bad = """
    [{"color":"#FF0000","id":"\(UUID().uuidString)","kind":"freehand","p1":[1,1],"p2":[2,2],"path":[],"size":1e300,"style":-4},
     {"color":"#FF0000","id":"\(UUID().uuidString)","kind":"ruler","p1":[-1e308,0],"p2":[1e308,0],"size":3,"style":0},
     {"color":"#00FF00","id":"\(UUID().uuidString)","kind":"spotlight","p1":[0,0],"p2":[5,5],"size":3,"style":0,"dim":7}]
    """
    try writeDoc(docJSON(id: "somewhere-else", created: "2026-10-06T10:00:00Z", scale: "0", crop: "[[500,500],[10,10]]", annotations: bad),
                 in: root, id: "20261006-100000-odd")
    // Document without its original image (e.g. the app quit before the PNG was written).
    try writeDoc(docJSON(id: "20261007-100000-noimg", created: "2026-10-07T10:00:00Z"), in: root, id: "20261007-100000-noimg", image: nil)

    let entries = store.entries()
    #expect(entries.map(\.id) == ["20261007-100000-noimg", "20261006-100000-odd", "20261001-100000-good"])
    let odd = try #require(entries.first { $0.id == "20261006-100000-odd" })
    #expect(odd.doc.id == "20261006-100000-odd", "re-keyed to its folder so saves land there")
    #expect(odd.doc.scale == 1 && odd.doc.crop == nil)
    #expect(odd.doc.annotations.map(\.kind) == [.freehand, .spotlight])
    let free = odd.doc.annotations[0]
    #expect(free.path == [CGPoint(x: 1, y: 1)])
    #expect(free.size == 10)
    #expect(free.style == 0)
    #expect(odd.doc.annotations[1].dim == 1)
    // Everything that survives renders and hit-tests without trapping.
    let image = try #require(store.loadImage(odd))
    let doc = odd.doc.sanitized(imageWidth: image.width, imageHeight: image.height)
    #expect(Renderer.flatten(doc, image: image, effects: EffectCache()) != nil)
    for a in doc.annotations { _ = Renderer.hitTest(a, .zero, tolerance: 3); _ = Renderer.bounds(of: a) }

    let noImage = try #require(entries.first)
    #expect(!store.hasImage(noImage) && store.loadImage(noImage) == nil)
    #expect(store.hasImage(odd))
    // Retention falls back to the folder date for unreadable documents.
    #expect(store.prune(retentionDays: 1, now: Date().addingTimeInterval(3 * 86_400)).count == 8)
}

@Test func hostileAnnotationsNeverTrap() {
    // Built directly (JSON can't carry NaN): every kind with empty paths / extreme values.
    for kind in Annotation.Kind.allCases {
        var a = Annotation(kind: kind, p1: CGPoint(x: 5, y: 5), p2: CGPoint(x: 5, y: 5), color: "zz", size: 0)
        a.path = []
        a.text = kind == .text ? "x" : nil
        _ = Renderer.hitTest(a, CGPoint(x: 5, y: 5), tolerance: 0)
        _ = Renderer.bounds(of: a)
        #expect(a.sanitized() != nil)
        var nan = a
        nan.p2 = CGPoint(x: CGFloat.nan, y: 1)
        #expect(nan.sanitized() == nil)
    }
    var emptyText = Annotation(kind: .text, p1: .zero, p2: .zero, color: "#000", size: 4)
    emptyText.text = " \n"
    #expect(emptyText.sanitized() == nil, "empty labels autosaved mid-typing are dropped")
    #expect(Renderer.rulerLabel(Annotation(kind: .ruler, p1: CGPoint(x: -1e308, y: 0), p2: CGPoint(x: 1e308, y: 0), color: "#000", size: 1)) == "–")
    // A crop entirely outside the image falls back to the whole image.
    var doc = ShotDocument(id: "x", created: Date(), modified: Date(), kind: "area", scale: 2, pixelWidth: 100, pixelHeight: 50)
    doc.crop = CGRect(x: 500, y: 500, width: 10, height: 10)
    #expect(doc.canvasRect == CGRect(x: 0, y: 0, width: 50, height: 25))
}

@Test func manyHistoryEntriesListQuickly() throws {
    let root = tempDir()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = HistoryStore(root: root)
    let png = try #require(ImageCodec.data(solid(40, 20), scale: 2, format: .png))
    let f = ISO8601DateFormatter()
    for i in 0..<250 {
        let id = String(format: "20260101-%06d-test", i)
        let dir = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try docJSON(id: id, created: f.string(from: Date(timeIntervalSince1970: 1_767_000_000 + Double(i) * 60)))
            .data(using: .utf8)!.write(to: dir.appendingPathComponent(HistoryStore.docName))
        try png.write(to: dir.appendingPathComponent(HistoryStore.imageName))
    }
    let t0 = Date()
    let entries = store.entries()
    #expect(Date().timeIntervalSince(t0) < 2)
    #expect(entries.count == 250 && entries.first?.id == "20260101-000249-test")
}

// MARK: - Images

@Test func codecScaleAndDataLoading() throws {
    let scales = [72.0, 144, 216, 96, 300, .nan, 0, -144].map { ImageCodec.scale(dpi: $0) }
    #expect(scales == [1, 2, 3, 1, 1, 1, 1, 1])
    let data = try #require(ImageCodec.data(solid(64, 32), scale: 2, format: .png))
    let (img, scale) = try #require(ImageCodec.load(data))
    #expect(img.width == 64 && scale == 2)
    #expect(ImageCodec.load(Data("garbage".utf8)) == nil)
    #expect(ImageCodec.load(Data()) == nil)
}

@MainActor
@Test func clipboardImageReadsPNGWithItsScale() throws {
    let pb = NSPasteboard(name: NSPasteboard.Name("bento.shoteditor.hardening.\(UUID().uuidString)"))
    defer { pb.releaseGlobally() }
    pb.clearContents()
    let png = try #require(ImageCodec.data(solid(30, 10), scale: 2, format: .png))
    pb.setData(png, forType: .png)
    let (img, scale) = try #require(Clipboard.image(from: pb))
    #expect(img.width == 30 && img.height == 10 && scale == 2)
    pb.clearContents()
    pb.setString("no image here", forType: .string)
    #expect(Clipboard.image(from: pb) == nil)
}

@Test func averageColourOfAnArea() throws {
    let s = PixelSampler(image: solid(400, 300, rgb: (1, 0, 0)), scale: 2)
    let c = try #require(s.averageColor(in: CGRect(x: 10, y: 10, width: 150, height: 100)))
    #expect(c.r > 250 && c.g < 5 && c.b < 5)
    #expect(s.averageColor(in: CGRect(x: 900, y: 900, width: 10, height: 10)) == nil)
    let mid = try #require(PixelSampler.average([PixelSampler.pack(0, 0, 0), PixelSampler.pack(255, 255, 255)]))
    #expect(mid.r == 128 && mid.g == 128 && mid.b == 128)
}

@MainActor
@Test func tinyPinsStayVisible() {
    _ = NSApplication.shared
    let pin = PinController(image: solid(1, 1), scale: 2, entryID: nil, rect: .zero)
    #expect(pin.panel.frame.width >= PinController.minSide && pin.panel.frame.height >= PinController.minSide)
    pin.scale(by: 0.01)
    #expect(pin.panel.frame.width >= PinController.minSide - 0.5)
    pin.scale(by: .infinity)
    pin.scale(by: -1)
    pin.resetSize()
    #expect(pin.panel.frame.width >= PinController.minSide - 0.5)
    let normal = PinController(image: solid(800, 400), scale: 2, entryID: nil, rect: .zero)
    #expect(normal.panel.frame.size == CGSize(width: 400, height: 200))
    pin.close()
    normal.close()
}

// MARK: - OCR

@Test func ocrLineGrouping() {
    typealias R = TextRecognizer.Run
    #expect(TextRecognizer.lines([]) == "")
    // Two runs on one baseline (table cells) join left to right; lines go top to bottom.
    let runs = [R(text: "cell", minX: 0.5, minY: 0.11, maxY: 0.19), R(text: "0001", minX: 0.1, minY: 0.1, maxY: 0.2),
                R(text: "second", minX: 0.1, minY: 0.3, maxY: 0.4), R(text: "half", minX: 0.6, minY: 0.35, maxY: 0.45),
                R(text: "zero", minX: 0.1, minY: 0.8, maxY: 0.8)]
    #expect(TextRecognizer.lines(runs) == "0001 cell\nsecond half\nzero")
}

@Test func ocrBlankTinyAndRealText() async throws {
    #expect(try await TextRecognizer.recognize(solid(400, 200)) == "")
    for (w, h) in [(1, 1), (2, 2), (2, 300), (300, 2)] {
        #expect(try await TextRecognizer.recognize(solid(w, h)) == "", "\(w)x\(h)")
        #expect(TextRecognizer.barcodes(solid(w, h)).isEmpty)
    }
    let text = try await TextRecognizer.recognize(textImage(["Hello Bento editor", "Second line of text"]))
    #expect(text.split(separator: "\n").count == 2)
    #expect(text.lowercased().contains("hello") && text.lowercased().contains("second"))
    #expect(text.range(of: "Hello")!.lowerBound < text.range(of: "Second")!.lowerBound)
}
