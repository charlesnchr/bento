import AppKit
import UniformTypeIdentifiers
import Testing
@testable import Notes

@Suite struct NoteImageTests {
    let a = String(repeating: "a", count: 64)
    let b = String(repeating: "0123456789abcdef", count: 4)

    /// A `w`×`h` image encoded as `type` (with an alpha channel when `alpha`).
    func image(_ w: Int, _ h: Int, type: UTType, alpha: Bool = false) -> Data {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0, green: 0.6, blue: 0.7, alpha: alpha ? 0.5 : 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w / 2, height: h))
        let out = NSMutableData()
        let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
        CGImageDestinationFinalize(dest)
        return out as Data
    }

    @Test func imageLines() {
        #expect(NoteImage.hash(inLine: "![](bento-image:\(a))") == a)
        #expect(NoteImage.hash(inLine: "  ![a cat](bento-image:\(b)) \t") == b)
        #expect(NoteImage.markdown(a) == "![](bento-image:\(a))")
        #expect(NoteImage.hash(inLine: NoteImage.markdown(b)) == b)
        // only a line that is one image
        #expect(NoteImage.hash(inLine: "x ![](bento-image:\(a))") == nil)
        #expect(NoteImage.hash(inLine: "![](bento-image:\(a)) x") == nil)
        #expect(NoteImage.hash(inLine: "- ![](bento-image:\(a))") == nil)
        #expect(NoteImage.hash(inLine: "![](bento-image:\(a.uppercased()))") == nil)
        #expect(NoteImage.hash(inLine: "![](bento-image:\(a.dropLast()))") == nil)
        #expect(NoteImage.hash(inLine: "![](https://example.com/\(a).png)") == nil)
        #expect(NoteImage.hash(inLine: "![a]b](bento-image:\(a))") == nil)
        let body = "# T\n\(NoteImage.markdown(a))\ntext\n\(NoteImage.markdown(b))\n\(NoteImage.markdown(a))"
        #expect(NoteImage.hashes(in: body) == [a, b])
        #expect(NoteImage.hashes(in: "no images") == [])
    }

    @Test func insertingPutsEachImageOnItsOwnLine() {
        func insert(_ text: String, _ sel: NSRange, _ hashes: [String]) -> (String, Int) {
            let r = NoteImage.insertion(text as NSString, selection: sel, hashes: hashes)
            return (r.apply(to: text), r.selection.location)
        }
        let img = NoteImage.markdown(a), img2 = NoteImage.markdown(b)
        #expect(insert("", NSRange(location: 0, length: 0), [a]) == ("\(img)\n", (img as NSString).length + 1))
        let (t1, c1) = insert("abc", NSRange(location: 3, length: 0), [a])
        #expect(t1 == "abc\n\(img)\n" && c1 == (t1 as NSString).length)
        let (t2, c2) = insert("abc\ndef", NSRange(location: 4, length: 0), [a, b])
        #expect(t2 == "abc\n\(img)\n\(img2)\ndef" && c2 == (t2 as NSString).length - 3)
        // replaces the selection
        let (t3, _) = insert("abXYcd", NSRange(location: 2, length: 2), [a])
        #expect(t3 == "ab\n\(img)\ncd")
    }

    @Test func formats() {
        #expect(NoteImage.mimeType(image(4, 4, type: .png)) == "image/png")
        #expect(NoteImage.mimeType(image(4, 4, type: .jpeg)) == "image/jpeg")
        #expect(NoteImage.mimeType(image(4, 4, type: .gif)) == "image/gif")
        #expect(NoteImage.mimeType(image(4, 4, type: .tiff)) == nil)
        #expect(NoteImage.mimeType(Data("<html>".utf8)) == nil)
        #expect(NoteImage.sha256(Data("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test func preparingKeepsWhatTheServerTakesAndConvertsTheRest() throws {
        let png = image(20, 10, type: .png)
        #expect(NoteImage.prepare(png) == png)
        let jpeg = image(20, 10, type: .jpeg)
        #expect(NoteImage.prepare(jpeg) == jpeg)
        // TIFF (macOS's pasteboard format): PNG when it has transparency, JPEG otherwise
        let clear = try #require(NoteImage.prepare(image(20, 10, type: .tiff, alpha: true)))
        #expect(NoteImage.mimeType(clear) == "image/png")
        let opaque = try #require(NoteImage.prepare(image(20, 10, type: .tiff)))
        #expect(NoteImage.mimeType(opaque) == "image/jpeg")
        #expect(NSImage(data: opaque)?.representations.first?.pixelsWide == 20)
        // too large: scaled down to 4096 px
        let big = try #require(NoteImage.prepare(image(5000, 100, type: .png)))
        #expect(NSBitmapImageRep(data: big)?.pixelsWide == 4096)
        #expect(NoteImage.prepare(Data("not an image".utf8)) == nil)
    }

    @Test func storeKeepsImagesAndTheirUploads() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-images-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = NoteImageStore(dir: dir)
        let png = image(30, 20, type: .png)
        let hash = try #require(store.add(png))
        #expect(hash == NoteImage.sha256(png))
        #expect(store.has(hash) && store.data(hash) == png)
        #expect(store.size(hash) == NSSize(width: 30, height: 20))
        #expect(store.pendingUploads == [hash])
        store.uploaded(hash)
        #expect(store.pendingUploads.isEmpty)
        // a fetched image must match its hash
        let other = image(5, 5, type: .png)
        #expect(!store.store(other, hash: hash))
        #expect(store.store(other, hash: NoteImage.sha256(other)))
        #expect(store.has(NoteImage.sha256(other)) && store.pendingUploads.isEmpty)
        #expect(store.add(Data("nope".utf8)) == nil)
    }

    @Test func titlesAndCountsSkipImages() {
        let body = "\(NoteImage.markdown(a))\n# Trip\nsome words"
        #expect(NoteText.title(of: body) == "Trip")
        #expect(NoteText.title(of: NoteImage.markdown(a)) == "")
        #expect(NoteText.wordCount(of: body) == 3)
        #expect(!NoteText.searchText(of: body).contains("bento-image"))
    }

    // MARK: Styling

    func deco(_ s: NSTextStorage, _ loc: Int) -> BlockDecoration.Kind? {
        (s.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration)?.kind
    }

    @Test func imageLinesAreDrawnAndTheirMarkdownHidden() {
        let line = NoteImage.markdown(a)
        let text = "intro\n\(line)\nafter"
        let s = NSTextStorage(string: text)
        let st = MarkdownStyler()
        st.imageMaxWidth = 300
        var sizes: [String: NSSize] = [:]
        st.imageSize = { sizes[$0] }
        st.selectionChanged(s, to: NSRange(location: 0, length: 0))
        st.styleAll(s)
        let start = 6, len = (line as NSString).length
        // not here yet: a placeholder
        #expect(deco(s, start) == .image(hash: a, width: 240, height: 0, revealed: false))
        #expect(s.attribute(.notesHidden, at: start, effectiveRange: nil) != nil)
        let ps = s.attribute(.paragraphStyle, at: start, effectiveRange: nil) as! NSParagraphStyle
        #expect(abs(ps.paragraphSpacingBefore - 86) < 0.001, "\(ps.paragraphSpacingBefore)")
        #expect(deco(s, start + len + 1) == .paragraph(empty: false))

        // it arrives: scaled to the width, at most 420 high
        sizes[a] = NSSize(width: 600, height: 200)
        st.restyleImages(s, hash: a)
        #expect(deco(s, start) == .image(hash: a, width: 300, height: 100, revealed: false))
        sizes[a] = NSSize(width: 100, height: 2000)
        st.restyleImages(s)
        #expect(deco(s, start) == .image(hash: a, width: 21, height: 420, revealed: false))
        sizes[a] = NSSize(width: 100, height: 200)
        st.imageMaxWidth = 50
        st.restyleImages(s)
        #expect(deco(s, start) == .image(hash: a, width: 50, height: 100, revealed: false))

        // the caret on its line shows the markdown (below the picture)
        st.selectionChanged(s, to: NSRange(location: start + 3, length: 0))
        #expect(deco(s, start) == .image(hash: a, width: 50, height: 100, revealed: true))
        #expect(s.attribute(.notesHidden, at: start, effectiveRange: nil) == nil)
        // and no link styling on it
        #expect(s.attribute(.notesLink, at: start + 2, effectiveRange: nil) == nil)
        st.selectionChanged(s, to: NSRange(location: 0, length: 0))
        #expect(deco(s, start) == .image(hash: a, width: 50, height: 100, revealed: false))
    }

    @Test func anImageInsideCodeIsText() {
        let s = NSTextStorage(string: "```\n\(NoteImage.markdown(a))\n```")
        let st = MarkdownStyler()
        st.styleAll(s)
        #expect(deco(s, 4) == .code)
    }
}
