import AppKit
import Foundation
import Testing
import UniformTypeIdentifiers
import BentoCore
@testable import Clipboard

// Regression tests from the QA/hardening pass (crash, data-loss and
// robustness fixes). Private pasteboards only.

private struct FakeSQLiteError: Error, CustomStringConvertible { var description: String }

private func storeImage(_ store: ClipStore, size: Int = 20) throws -> ImageProcessor.Stored {
    let png = pngData(width: size, height: size)
    let stored = try #require(ImageProcessor.store(data: png, type: UTType.png.identifier,
                                                   imagesDir: store.imagesDir, thumbsDir: store.thumbsDir))
    var d = ClipDraft(kind: .image, hash: ClipClassifier.hash(png))
    d.imageFile = stored.imageFile
    d.thumbFile = stored.thumbFile
    d.width = stored.width; d.height = stored.height
    try store.upsert(d)
    return stored
}

@Suite struct StoreRobustnessTests {
    @Test func orphanScanNeverDeletesWhenTheQueryFails() throws {
        let store = try makeStore()
        let stored = try storeImage(store)
        // Another connection breaks the table: the scan fails (not corruption).
        let other = try SQLiteDB(path: store.databaseURL.path)
        try other.exec("DROP TABLE items")
        store.removeOrphanFiles()
        #expect(FileManager.default.fileExists(atPath: store.imagesDir.appendingPathComponent(stored.imageFile).path))
    }

    @Test func garbageDatabaseIsSetAsideAtOpen() throws {
        let dir = tempDir()
        try Data(repeating: 0x5A, count: 64 * 1024).write(to: dir.appendingPathComponent("history.sqlite"))
        let store = try ClipStore(directory: dir)
        #expect(store.recoveredFromCorruption)
        #expect(try store.upsert(textDraft("after recovery")).inserted)
        #expect(store.rows().map(\.title) == ["after recovery"])
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(names.contains { $0.hasPrefix("history.corrupt-") })
        #expect(!names.contains { $0.hasPrefix("history.sqlite.rebuild") })
    }

    @Test func damagedPagesLoseOnlyTheirRows() throws {
        let dir = tempDir()
        do {
            let store = try ClipStore(directory: dir)
            let base = Date(timeIntervalSinceNow: -10_000)
            for i in 0..<400 {
                var d = textDraft("item \(i) " + String(repeating: "x", count: 700))
                d.byteSize = 700
                try store.upsert(d, now: base.addingTimeInterval(Double(i)))
            }
        }
        // Move the WAL into the main file, then trash a few pages in the middle.
        let path = dir.appendingPathComponent("history.sqlite").path
        try SQLiteDB(path: path).exec("PRAGMA wal_checkpoint(TRUNCATE)")
        let h = try #require(FileHandle(forUpdatingAtPath: path))
        h.seek(toFileOffset: 4096 * 30)
        h.write(Data((0..<(4096 * 6)).map { _ in UInt8.random(in: 0...255) }))
        try h.close()

        let store = try ClipStore(directory: dir)
        store.recoversAutomatically = false // tests are not on the main thread
        if !store.recoveredFromCorruption {
            // The damage shows when a query reaches it (the app then rebuilds
            // asynchronously; here we do it directly).
            #expect(store.rows(limit: 1000).count < 400)
            #expect(store.recoverIfCorrupt(FakeSQLiteError(description: "database disk image is malformed")))
        }
        let kept = store.rows(limit: 1000)
        #expect(kept.count > 300 && kept.count < 400)
        #expect(try store.upsert(textDraft("new after rebuild")).inserted)
        #expect(store.rows(limit: 1).first?.title == "new after rebuild")
        // A stale error from before the rebuild does not trigger another one.
        #expect(!store.recoverIfCorrupt(FakeSQLiteError(description: "database disk image is malformed"), generation: 0))
        #expect(!store.recoverIfCorrupt(FakeSQLiteError(description: "no such column: x")))
    }

    @Test func recoveryKeepsReadableRowsAndTheirImages() throws {
        let store = try makeStore()
        let stored = try storeImage(store)
        try store.upsert(textDraft("text survives"))
        store.setPinned(try #require(store.rows(query: "survives").first?.id), true)
        #expect(store.recoverIfCorrupt(FakeSQLiteError(description: "file is not a database")))
        #expect(store.stats().count == 2)
        #expect(store.stats().pinned == 1)
        #expect(FileManager.default.fileExists(atPath: store.imagesDir.appendingPathComponent(stored.imageFile).path))
    }

    @Test func nonASCIISearchIgnoresCase() throws {
        let store = try makeStore()
        try store.upsert(textDraft("Æbleskiver og smørrebrød"))
        try store.upsert(textDraft("ÉCOLE normale"))
        #expect(store.rows(query: "æbleskiver").count == 1)
        #expect(store.rows(query: "SMØRREBRØD").count == 1)
        #expect(store.rows(query: "école").count == 1)
        #expect(store.rows(query: "Smørrebrød æble").count == 1)
        #expect(store.rows(query: "øl").isEmpty)
        #expect(store.rows(filter: .links, query: "æble").isEmpty)
        #expect(ClipStore.caseVariants("abc") == ["abc"])
    }

    @Test func nulCharactersDoNotTruncateText() throws {
        var s = PasteboardSnapshot()
        s.string = "before\u{0}after"
        guard case .ready(let d)? = ClipClassifier.classify(s, settings: ClipboardSettings()) else { Issue.record("expected text"); return }
        #expect(d.text == "beforeafter")
        let store = try makeStore()
        let id = try store.upsert(d).id
        #expect(store.detail(id)?.text == "beforeafter")
    }

    @Test func hugeTextLimits() throws {
        var s = PasteboardSnapshot()
        s.string = String(repeating: "a", count: PasteboardReader.maxTextBytes)
        guard case .ready(let d)? = ClipClassifier.classify(s, settings: ClipboardSettings()) else { Issue.record("expected text"); return }
        #expect(d.byteSize == PasteboardReader.maxTextBytes)
        s.string = String(repeating: "a", count: PasteboardReader.maxTextBytes + 1)
        #expect(ClipClassifier.classify(s, settings: ClipboardSettings()) == nil)
    }
}

@Suite struct ImageRobustnessTests {
    @Test func animatedGIFKeepsItsFrames() throws {
        let data = NSMutableData()
        let dest = try #require(CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, 3, nil))
        let png = pngData(width: 16, height: 16)
        let src = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        let frame = try #require(CGImageSourceCreateImageAtIndex(src, 0, nil))
        for _ in 0..<3 { CGImageDestinationAddImage(dest, frame, nil) }
        #expect(CGImageDestinationFinalize(dest))
        let dir = tempDir()
        let stored = try #require(ImageProcessor.store(data: data as Data, type: UTType.gif.identifier, imagesDir: dir, thumbsDir: dir))
        #expect(stored.imageType == UTType.gif.identifier)
        #expect(stored.imageFile.hasSuffix(".gif"))
        let back = try #require(CGImageSourceCreateWithURL(dir.appendingPathComponent(stored.imageFile) as CFURL, nil))
        #expect(CGImageSourceGetCount(back) == 3)
    }

    @Test func compressedOriginalBeatsTIFF() throws {
        let pb = privatePasteboard()
        defer { pb.releaseGlobally() }
        pb.clearContents()
        let item = NSPasteboardItem()
        let png = pngData(width: 8, height: 8)
        item.setData(try #require(NSImage(data: png)?.tiffRepresentation), forType: .tiff)
        item.setData(png, forType: NSPasteboard.PasteboardType(UTType.gif.identifier)) // stand-in bytes
        pb.writeObjects([item])
        let s = try #require(PasteboardReader.read(pb, settings: ClipboardSettings()))
        #expect(s.imageType == UTType.gif.identifier)
    }

    @Test func missingImageFileFailsCleanly() throws {
        let store = try makeStore()
        let stored = try storeImage(store)
        try FileManager.default.removeItem(at: store.imagesDir.appendingPathComponent(stored.imageFile))
        let row = try #require(store.rows().first)
        let d = try #require(store.detail(row.id))
        let pb = privatePasteboard()
        defer { pb.releaseGlobally() }
        #expect(!PasteboardWriter.write(d, plain: false, store: store, to: pb))
        #expect(TextRecognition.recognize(url: try #require(store.imageURL(d.imageFile))) == nil)
        #expect(ImageProcessor.downsampled(try #require(store.imageURL(d.imageFile)), maxPixels: 100) == nil)
    }

    @Test func emptyOrBogusImageDataIsRejected() {
        let dir = tempDir()
        #expect(ImageProcessor.store(data: Data(), type: UTType.png.identifier, imagesDir: dir, thumbsDir: dir) == nil)
        #expect(ImageProcessor.store(data: Data("not an image".utf8), type: UTType.png.identifier, imagesDir: dir, thumbsDir: dir) == nil)
    }
}

@Suite struct PasteboardRobustnessTests {
    @Test func fileWritesCarryTheMarker() throws {
        let store = try makeStore()
        let id = try store.upsert(ClipDraft(kind: .file, text: "/etc/hosts\n/etc/passwd", hash: "files")).id
        let pb = privatePasteboard()
        defer { pb.releaseGlobally() }
        #expect(PasteboardWriter.write(try #require(store.detail(id)), plain: false, store: store, to: pb))
        #expect(pb.types?.contains(PasteboardTypes.own) == true)
        let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        #expect(urls?.map(\.path) == ["/etc/hosts", "/etc/passwd"])
        #expect(PasteboardReader.read(pb, settings: ClipboardSettings()) == nil)
    }

    @Test func emptyAndTypelessPasteboards() {
        let pb = privatePasteboard()
        defer { pb.releaseGlobally() }
        pb.clearContents()
        #expect(PasteboardReader.read(pb, settings: ClipboardSettings()) == nil)
        // An item with only an unknown, empty type.
        let item = NSPasteboardItem()
        item.setData(Data(), forType: NSPasteboard.PasteboardType("com.example.nothing"))
        pb.writeObjects([item])
        let s = PasteboardReader.read(pb, settings: ClipboardSettings())
        #expect(s.flatMap { ClipClassifier.classify($0, settings: ClipboardSettings()) } == nil)
    }

    @Test func promisedDataThatNeverArrives() {
        final class Failing: NSObject, NSPasteboardItemDataProvider {
            func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {}
        }
        let pb = privatePasteboard()
        defer { pb.releaseGlobally() }
        pb.clearContents()
        let provider = Failing()
        let item = NSPasteboardItem()
        item.setDataProvider(provider, forTypes: [.string, .png, NSPasteboard.PasteboardType("com.example.lazy")])
        pb.writeObjects([item])
        let s = PasteboardReader.read(pb, settings: ClipboardSettings())
        #expect(s.flatMap { ClipClassifier.classify($0, settings: ClipboardSettings()) } == nil)
        withExtendedLifetime(provider) {}
    }
}

@Suite struct PanelRobustnessTests {
    @Test func moveSurvivesRowsShrinkingUnderneath() throws {
        let store = try makeStore()
        let base = Date(timeIntervalSinceNow: -10_000)
        for i in 0..<130 { try store.upsert(textDraft("row \(i)"), now: base.addingTimeInterval(Double(i))) }
        let model = PanelModel(store: store, settings: ClipboardSettings(), targetApp: nil, state: ClipboardState())
        #expect(model.rows.count == 120)
        model.move(110)
        #expect(model.selectedIndex == 110)
        // Rows vanish without the model being told (the panel normally reloads
        // on didChange; a failed query also returns no rows).
        for r in store.rows(limit: 200).dropFirst(10) { store.delete(r.id) }
        model.move(6) // near the end: loads the next page, which now has 10 rows (crashed before)
        #expect(model.selectedIndex == 9)
        for r in store.rows(limit: 200) { store.delete(r.id) }
        model.move(1)
        model.moveToEnd(true)
        model.reload(preferIndex: 5)
        #expect(model.rows.isEmpty && model.selectedID == nil)
    }

    @Test func deletingTheLastRowSelectsTheNewLast() throws {
        let store = try makeStore()
        let base = Date(timeIntervalSinceNow: -100)
        for i in 0..<3 { try store.upsert(textDraft("r\(i)"), now: base.addingTimeInterval(Double(i))) }
        let model = PanelModel(store: store, settings: ClipboardSettings(), targetApp: nil, state: ClipboardState())
        model.moveToEnd(true)
        let i = try #require(model.selectedIndex)
        store.delete(try #require(model.selectedID))
        model.reload(preferIndex: i)
        #expect(model.selectedRow?.title == "r1")
        model.filter = .images // zero results
        model.move(1)
        model.move(-1)
        #expect(model.selectedRow == nil)
    }

    @Test func relativeTimeHandlesOddDates() {
        #expect(RelativeTime.short(Date(timeIntervalSinceNow: 30)) == "Just now")
        #expect(RelativeTime.short(Date(timeIntervalSince1970: .infinity)) == "")
        #expect(!RelativeTime.short(Date(timeIntervalSince1970: 0)).isEmpty)
    }
}
