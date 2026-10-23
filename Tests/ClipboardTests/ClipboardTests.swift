import AppKit
import Foundation
import Testing
import UniformTypeIdentifiers
@testable import Clipboard

// MARK: - Helpers

func tempDir() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("bento-clip-tests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func makeStore() throws -> ClipStore { try ClipStore(directory: tempDir()) }

func textDraft(_ text: String, app: String? = "TextEdit", bundle: String? = "com.apple.TextEdit") -> ClipDraft {
    var d = ClipDraft(kind: ContentDetection.kind(forText: text), text: text, hash: ClipClassifier.hash("text", text))
    d.byteSize = text.utf8.count
    d.sourceApp = app
    d.sourceBundleID = bundle
    return d
}

/// A private, uniquely named pasteboard so tests never touch the user's clipboard.
func privatePasteboard() -> NSPasteboard {
    NSPasteboard(name: NSPasteboard.Name("com.charles.bento.tests.\(UUID().uuidString)"))
}

func pngData(width: Int, height: Int) -> Data {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(red: 1, green: 0.4, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return ImageProcessor.encode(ctx.makeImage()!, as: .png)!
}

// MARK: - Type detection

@Suite struct DetectionTests {
    @Test func links() {
        #expect(ContentDetection.linkURL("https://www.apple.com/mac/")?.host == "www.apple.com")
        #expect(ContentDetection.linkURL("  http://example.org/a?b=c  \n") != nil)
        #expect(ContentDetection.linkURL("www.github.com/foo")?.absoluteString == "https://www.github.com/foo")
        #expect(ContentDetection.linkURL("mailto:me@example.com") != nil)
        #expect(ContentDetection.linkURL("hello world") == nil)
        #expect(ContentDetection.linkURL("https://example.com and more") == nil)
        #expect(ContentDetection.linkURL("example.com") == nil)
        #expect(ContentDetection.linkURL("file:///etc/hosts") == nil)
        #expect(ContentDetection.linkURL("https://") == nil)
        #expect(ContentDetection.domain(of: URL(string: "https://www.apple.com/x")!) == "apple.com")
    }

    @Test func colours() throws {
        let red = try #require(ContentDetection.parseColor("#FF0000"))
        #expect(red == .init(r: 1, g: 0, b: 0, a: 1))
        #expect(ContentDetection.parseColor("#fff")?.hex == "#FFFFFF")
        #expect(ContentDetection.parseColor("#ff000080")?.a ?? 0 > 0.49)
        #expect(ContentDetection.parseColor("rgb(255, 0, 0)")?.hex == "#FF0000")
        #expect(ContentDetection.parseColor("rgba(0,0,0,0.5)")?.rgbString == "rgba(0, 0, 0, 0.5)")
        #expect(ContentDetection.parseColor("rgb(255 128 0 / 50%)")?.hex == "#FF800080")
        #expect(ContentDetection.parseColor("hsl(120, 100%, 50%)")?.hex == "#00FF00")
        #expect(ContentDetection.parseColor("HSL(0deg 100% 50%)")?.hex == "#FF0000")
        #expect(ContentDetection.parseColor("#12345")  == nil)
        #expect(ContentDetection.parseColor("#ggg") == nil)
        #expect(ContentDetection.parseColor("rgb(300, 0, 0)") == nil)
        #expect(ContentDetection.parseColor("red") == nil)
        #expect(ContentDetection.parseColor("#FF0000 is red") == nil)
        #expect(ContentDetection.parseColor("#3366CC")?.hslString == "hsl(220, 60%, 50%)")
    }

    @Test func kinds() {
        #expect(ContentDetection.kind(forText: "#0A84FF") == .color)
        #expect(ContentDetection.kind(forText: "https://sync.example.com") == .link)
        #expect(ContentDetection.kind(forText: "Just some words.") == .text)
    }

    @Test func code() {
        #expect(ContentDetection.looksLikeCode("""
        func hello() {
            print("hi");
            return
        }
        """))
        #expect(ContentDetection.looksLikeCode("{\"a\": 1, \"b\": [1, 2]}"))
        #expect(ContentDetection.looksLikeCode("swift build --scratch-path .build-clipboard"))
        #expect(!ContentDetection.looksLikeCode("Dear team, the meeting is moved to Thursday. Thanks!"))
        #expect(!ContentDetection.looksLikeCode("Line one of a poem\nLine two of a poem\nAnd a third line"))
    }

    @Test func titlesAndStats() {
        #expect(ContentDetection.title(forText: "\n\n  First line  \nSecond") == "First line")
        let s = ContentDetection.stats("Hello world\nsecond line")
        #expect(s.words == 4 && s.lines == 2 && s.characters == 23)
        #expect(ContentDetection.anchorTitle(html: Data("<meta charset='utf-8'><a href=\"https://x.org\">X &amp; Y</a>".utf8)) == "X & Y")
    }
}

// MARK: - Classification

@Suite struct ClassifierTests {
    let settings = ClipboardSettings()

    @Test func filesWin() throws {
        var s = PasteboardSnapshot()
        s.fileURLs = [URL(fileURLWithPath: "/tmp/a.txt"), URL(fileURLWithPath: "/tmp/b.png")]
        s.string = "a.txt"
        guard case .ready(let d)? = ClipClassifier.classify(s, settings: settings) else { Issue.record("expected file"); return }
        #expect(d.kind == .file)
        #expect(d.text == "/tmp/a.txt\n/tmp/b.png")
        #expect(ClipStore.title(for: d) == "2 Files: a.txt, b.png")
    }

    @Test func imageVersusText() {
        #expect(ClipClassifier.prefersImage(string: nil, hasRTF: false))
        #expect(ClipClassifier.prefersImage(string: "https://example.com/cat.png", hasRTF: false))
        #expect(!ClipClassifier.prefersImage(string: "Quarterly numbers", hasRTF: true))
        #expect(!ClipClassifier.prefersImage(string: "https://example.com", hasRTF: true))

        var s = PasteboardSnapshot()
        s.imageData = pngData(width: 4, height: 4)
        s.imageType = NSPasteboard.PasteboardType.png.rawValue
        guard case .image(_, let type, let hash)? = ClipClassifier.classify(s, settings: settings) else { Issue.record("expected image"); return }
        #expect(type == "public.png")
        #expect(hash.count == 32)

        var off = settings
        off.captureImages = false
        #expect(ClipClassifier.classify(s, settings: off) == nil)
    }

    @Test func textAndRich() {
        var s = PasteboardSnapshot()
        s.string = "Hello"
        s.rtf = Data("{\\rtf1 Hello}".utf8)
        s.extras = ["com.example.private": Data([1, 2, 3])]
        guard case .ready(let d)? = ClipClassifier.classify(s, settings: settings) else { Issue.record("expected text"); return }
        #expect(d.kind == .text && d.rtf != nil && d.extras != nil)
        #expect(d.byteSize > 5)

        var plain = settings
        plain.captureRichText = false
        guard case .ready(let p)? = ClipClassifier.classify(s, settings: plain) else { Issue.record("expected text"); return }
        #expect(p.rtf == nil && p.extras == nil)

        var noText = settings
        noText.captureText = false
        #expect(ClipClassifier.classify(s, settings: noText) == nil)

        s.string = "   \n"
        #expect(ClipClassifier.classify(s, settings: settings) == nil)
    }

    @Test func linkTitle() {
        var s = PasteboardSnapshot()
        s.string = "https://www.apple.com/"
        s.urlName = "Apple"
        guard case .ready(let d)? = ClipClassifier.classify(s, settings: settings) else { Issue.record("expected link"); return }
        #expect(d.kind == .link && d.linkTitle == "Apple")
        #expect(ClipStore.title(for: d) == "Apple")
    }

    @Test func dedupeHashIgnoresFormatting() {
        #expect(ClipClassifier.hash("text", "abc") == ClipClassifier.hash("text", "abc"))
        #expect(ClipClassifier.hash("text", "abc") != ClipClassifier.hash("file", "abc"))
    }
}

// MARK: - Pasteboard reading / writing (private pasteboards only)

@Suite struct PasteboardTests {
    @Test func concealedAndOwnWritesAreSkipped() {
        let pb = privatePasteboard()
        defer { pb.releaseGlobally() }
        pb.clearContents()
        pb.setString("secret", forType: .string)
        pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        #expect(PasteboardReader.read(pb, settings: ClipboardSettings()) == nil)

        pb.clearContents()
        pb.setString("mine", forType: .string)
        pb.setData(Data(), forType: PasteboardTypes.own)
        #expect(PasteboardReader.read(pb, settings: ClipboardSettings()) == nil)

        pb.clearContents()
        pb.setString("test", forType: .string)
        pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        pb.setData(Data(), forType: NSPasteboard.PasteboardType(PasteboardTypes.devTest))
        #expect(PasteboardReader.read(pb, settings: ClipboardSettings(), devMode: false) == nil)
        #expect(PasteboardReader.read(pb, settings: ClipboardSettings(), devMode: true)?.string == "test")
    }

    @Test func readsRichTextAndExtras() throws {
        let pb = privatePasteboard()
        defer { pb.releaseGlobally() }
        pb.clearContents()
        let item = NSPasteboardItem()
        item.setString("Bold", forType: .string)
        item.setData(Data("{\\rtf1 {\\b Bold}}".utf8), forType: .rtf)
        item.setData(Data([9, 9]), forType: NSPasteboard.PasteboardType("com.example.app-data"))
        pb.writeObjects([item])
        let s = try #require(PasteboardReader.read(pb, settings: ClipboardSettings()))
        #expect(s.string == "Bold" && s.rtf != nil)
        #expect(s.extras["com.example.app-data"] == Data([9, 9]))
    }

    @Test func readsFiles() throws {
        let pb = privatePasteboard()
        defer { pb.releaseGlobally() }
        pb.clearContents()
        pb.writeObjects([URL(fileURLWithPath: "/etc/hosts") as NSURL])
        let s = try #require(PasteboardReader.read(pb, settings: ClipboardSettings()))
        #expect(s.fileURLs.map(\.path) == ["/etc/hosts"])
    }

    @Test func writerRoundTrip() throws {
        let store = try makeStore()
        var d = textDraft("Formatted")
        d.rtf = Data("{\\rtf1 {\\b Formatted}}".utf8)
        let id = try store.upsert(d).id
        let detail = try #require(store.detail(id))

        let pb = privatePasteboard()
        defer { pb.releaseGlobally() }
        #expect(PasteboardWriter.write(detail, plain: false, store: store, to: pb))
        #expect(pb.string(forType: .string) == "Formatted")
        #expect(pb.data(forType: .rtf) != nil)
        #expect(pb.types?.contains(PasteboardTypes.own) == true)
        #expect(PasteboardReader.read(pb, settings: ClipboardSettings()) == nil) // own write is not re-recorded

        #expect(PasteboardWriter.write(detail, plain: true, store: store, to: pb))
        #expect(pb.data(forType: .rtf) == nil)

        var f = ClipDraft(kind: .file, text: "/etc/hosts\n/etc/passwd", hash: ClipClassifier.hash("file", "x"))
        f.byteSize = 10
        let fid = try store.upsert(f).id
        let fd = try #require(store.detail(fid))
        #expect(PasteboardWriter.write(fd, plain: false, store: store, to: pb))
        let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        #expect(urls?.map(\.path) == ["/etc/hosts", "/etc/passwd"])
        #expect(PasteboardWriter.write(fd, plain: true, store: store, to: pb))
        #expect(pb.string(forType: .string) == "/etc/hosts\n/etc/passwd")
    }
}

// MARK: - Store

@Suite struct StoreTests {
    @Test func dedupeMovesToTop() throws {
        let store = try makeStore()
        let t0 = Date(timeIntervalSinceNow: -100)
        let a = try store.upsert(textDraft("alpha"), now: t0)
        _ = try store.upsert(textDraft("beta"), now: t0.addingTimeInterval(10))
        #expect(store.rows().map(\.title) == ["beta", "alpha"])

        let again = try store.upsert(textDraft("alpha", app: "Safari", bundle: "com.apple.Safari"), now: t0.addingTimeInterval(20))
        #expect(again.id == a.id && !again.inserted)
        #expect(store.rows().map(\.title) == ["alpha", "beta"])
        let d = try #require(store.detail(a.id))
        #expect(d.copyCount == 2)
        #expect(d.row.sourceApp == "Safari")
        #expect(abs(d.firstCopied.timeIntervalSince(t0)) < 0.01)
        #expect(store.stats().count == 2)
    }

    @Test func pinnedFirstAndTouch() throws {
        let store = try makeStore()
        let base = Date(timeIntervalSinceNow: -1000)
        let ids = try ["one", "two", "three"].enumerated().map { i, s in try store.upsert(textDraft(s), now: base.addingTimeInterval(Double(i))).id }
        store.setPinned(ids[0], true)
        #expect(store.rows().map(\.title) == ["one", "three", "two"])
        #expect(store.rows().first?.pinned == true)
        store.touch(ids[1])
        #expect(store.rows().map(\.title) == ["one", "two", "three"])
        #expect(store.latest(offset: 0)?.title == "two")
        #expect(store.latest(offset: 1)?.title == "three")
    }

    @Test func searchAndFilters() throws {
        let store = try makeStore()
        try store.upsert(textDraft("The quick brown fox"))
        try store.upsert(textDraft("https://www.apple.com/mac"))
        try store.upsert(textDraft("#FF8800"))
        try store.upsert(textDraft("100% done_now", app: "Notes", bundle: "com.apple.Notes"))
        var file = ClipDraft(kind: .file, text: "/Users/me/Documents/Invoice-2026.pdf", hash: "f1")
        file.sourceApp = "Finder"
        try store.upsert(file)
        var image = ClipDraft(kind: .image, hash: "img1")
        image.width = 10; image.height = 10
        let imgID = try store.upsert(image).id
        store.setOCR(imgID, text: "Receipt total 42 EUR")

        #expect(store.rows(query: "quick fox").map(\.title) == ["The quick brown fox"])
        #expect(store.rows(query: "fox quick").count == 1)        // all terms, any order
        #expect(store.rows(query: "QUICK").count == 1)            // case-insensitive
        #expect(store.rows(query: "invoice").first?.kind == .file) // file names
        #expect(store.rows(query: "finder").first?.kind == .file)  // source app
        #expect(store.rows(query: "receipt").first?.id == imgID)   // OCR text
        #expect(store.rows(query: "100%").count == 1)              // LIKE wildcards are escaped
        #expect(store.rows(query: "0%").count == 1)
        #expect(store.rows(query: "_").count == 1)
        #expect(store.rows(query: "nothing-matches").isEmpty)

        #expect(store.rows(filter: .links).map(\.kind) == [.link])
        #expect(store.rows(filter: .colors).map(\.kind) == [.color])
        #expect(store.rows(filter: .images).map(\.id) == [imgID])
        #expect(store.rows(filter: .files).count == 1)
        #expect(store.rows(filter: .text).count == 2)
        #expect(store.rows(filter: .text, query: "notes").count == 1)
        #expect(store.rows(limit: 2).count == 2)
        #expect(store.rows(limit: 2, offset: 5).count == 1)
    }

    @Test func retentionKeepsPinned() throws {
        let store = try makeStore()
        let now = Date()
        let old = try store.upsert(textDraft("old"), now: now.addingTimeInterval(-40 * 86_400)).id
        let oldPinned = try store.upsert(textDraft("old pinned"), now: now.addingTimeInterval(-400 * 86_400)).id
        store.setPinned(oldPinned, true)
        let fresh = try store.upsert(textDraft("fresh"), now: now.addingTimeInterval(-86_400)).id

        #expect(store.prune(retentionDays: 30, maxItems: 0, maxBytes: 0, now: now) == 1)
        #expect(store.detail(old) == nil)
        #expect(store.detail(oldPinned) != nil)
        #expect(store.detail(fresh) != nil)
        #expect(store.prune(retentionDays: 0, maxItems: 0, maxBytes: 0, now: now) == 0) // 0 = forever
    }

    @Test func countAndSizeCaps() throws {
        let store = try makeStore()
        let base = Date(timeIntervalSinceNow: -1000)
        for i in 0..<10 {
            var d = textDraft("item \(i)")
            d.byteSize = 100
            try store.upsert(d, now: base.addingTimeInterval(Double(i)))
        }
        store.setPinned(try #require(store.rows(query: "item 0").first?.id), true)
        #expect(store.prune(retentionDays: 0, maxItems: 5, maxBytes: 0) == 4)
        #expect(store.stats().count == 6) // 5 newest + pinned
        #expect(store.rows().map(\.title).contains("item 0"))
        #expect(store.prune(retentionDays: 0, maxItems: 0, maxBytes: 250) == 3)
        #expect(store.rows().map(\.title) == ["item 0", "item 9", "item 8"])
    }

    @Test func deleteClearAndFiles() throws {
        let store = try makeStore()
        let png = pngData(width: 300, height: 200)
        let stored = try #require(ImageProcessor.store(data: png, type: UTType.png.identifier,
                                                       imagesDir: store.imagesDir, thumbsDir: store.thumbsDir))
        #expect(stored.width == 300 && stored.height == 200)
        var d = ClipDraft(kind: .image, hash: ClipClassifier.hash(png))
        d.imageFile = stored.imageFile
        d.thumbFile = stored.thumbFile
        d.imageType = stored.imageType
        d.width = stored.width; d.height = stored.height; d.byteSize = stored.bytes
        let id = try store.upsert(d).id
        let imageURL = try #require(store.imageURL(stored.imageFile))
        let thumbURL = try #require(store.thumbURL(stored.thumbFile))
        #expect(FileManager.default.fileExists(atPath: imageURL.path))
        #expect(FileManager.default.fileExists(atPath: thumbURL.path))
        #expect(store.rows().first?.title == "Image (300×200)")
        #expect(store.nextPendingOCR()?.id == id)
        store.setOCR(id, text: "  ")
        #expect(store.nextPendingOCR() == nil)

        // A duplicate image written before the hash check is discarded.
        let dup = try #require(ImageProcessor.store(data: png, type: UTType.png.identifier,
                                                    imagesDir: store.imagesDir, thumbsDir: store.thumbsDir))
        var d2 = d
        d2.imageFile = dup.imageFile
        d2.thumbFile = dup.thumbFile
        #expect(try store.upsert(d2).inserted == false)
        #expect(!FileManager.default.fileExists(atPath: store.imagesDir.appendingPathComponent(dup.imageFile).path))

        // Orphans are removed, referenced files kept.
        let orphan = store.imagesDir.appendingPathComponent("orphan.png")
        try Data([1]).write(to: orphan)
        store.removeOrphanFiles()
        #expect(!FileManager.default.fileExists(atPath: orphan.path))
        #expect(FileManager.default.fileExists(atPath: imageURL.path))

        store.delete(id)
        #expect(store.detail(id) == nil)
        #expect(!FileManager.default.fileExists(atPath: imageURL.path))
        #expect(!FileManager.default.fileExists(atPath: thumbURL.path))

        let keep = try store.upsert(textDraft("keep")).id
        try store.upsert(textDraft("drop"))
        store.setPinned(keep, true)
        store.clear(includePinned: false)
        #expect(store.rows().map(\.id) == [keep])
        store.clear(includePinned: true)
        #expect(store.stats().count == 0)
    }

    @Test func tiffIsStoredAsPNG() throws {
        let dir = tempDir()
        let img = NSImage(data: pngData(width: 64, height: 32))!
        let tiff = try #require(img.tiffRepresentation)
        let stored = try #require(ImageProcessor.store(data: tiff, type: UTType.tiff.identifier, imagesDir: dir, thumbsDir: dir))
        #expect(stored.imageType == UTType.png.identifier)
        #expect(stored.imageFile.hasSuffix(".png"))
        #expect(stored.width == 64 && stored.height == 32)
    }

    @Test func reopenKeepsData() throws {
        let dir = tempDir()
        do {
            let store = try ClipStore(directory: dir)
            try store.upsert(textDraft("persisted"))
        }
        let again = try ClipStore(directory: dir)
        #expect(again.rows().map(\.title) == ["persisted"])
    }
}

// MARK: - Panel model

@Suite struct PanelModelTests {
    @Test func navigationAndSections() throws {
        let store = try makeStore()
        let now = Date()
        for i in 0..<5 { try store.upsert(textDraft("t\(i)"), now: now.addingTimeInterval(Double(i) - 10)) }
        try store.upsert(textDraft("old"), now: now.addingTimeInterval(-10 * 86_400))
        let model = PanelModel(store: store, settings: ClipboardSettings(), targetApp: nil, state: ClipboardState())
        #expect(model.rows.count == 6)
        #expect(model.selectedRow?.title == "t4")
        model.move(1)
        #expect(model.selectedRow?.title == "t3")
        model.move(-5)
        #expect(model.selectedIndex == 0)
        model.moveToEnd(true)
        #expect(model.selectedRow?.title == "old")
        #expect(model.sections.map(\.title).last == "Earlier")

        model.query = "t2"
        #expect(model.rows.map(\.title) == ["t2"])
        #expect(model.selectedRow?.title == "t2")
        model.query = ""
        model.filter = .links
        #expect(model.rows.isEmpty && model.selectedID == nil)
        model.cycleFilter()
        #expect(model.filter == .files)
    }
}
