// Pasteboard + history helper for the clipboard e2e tests (scripts/e2e/clipboard.sh).
// Build: swiftc -O scripts/e2e/clipboard-pb.swift -o /tmp/clipboard-pb
//
//   clipboard-pb save <file>                  archive every item/type of the general pasteboard
//   clipboard-pb restore <file>               write it back (+ TransientType so clipboard managers skip it)
//   clipboard-pb [--pb <name>] [--bare] write <kind> [args]
//        kinds: text <s> | textfile <path> | rtf <s> | html <s> | link <url> [title] | color <s>
//               png <w> <h> [noise] | tiff <w> <h> | gif <frames> | files <path>... | concealed <s>
//               typeless | empty | promised (a type whose provider never delivers)
//        Every write carries TransientType + com.charles.bento.dev-test (dev Bento records it, Maccy
//        and other managers skip it) unless --bare.
//   clipboard-pb [--pb <name>] burst <n> <interval-ms> <prefix>   n different texts in quick succession
//   clipboard-pb [--pb <name>] info           types of the first item + string
//   clipboard-pb [--pb <name>] count          changeCount
//   clipboard-pb seed <history.sqlite> <images-dir> <thumbs-dir> <n> [images-every]
//        inserts n history rows (texts, links, colours, files, every k-th an image with files on disk)
//   clipboard-pb release <name>               drop a private pasteboard
//   clipboard-pb frontpid                     pid of the frontmost app
//   clipboard-pb key --expect-pid <pid> <combo>...
//        like `bentoctl key`, for the Bento under test when it is frontmost (the raw debug binary has
//        no bundle id, so `bentoctl --expect` cannot name it). Refuses unless the frontmost app has that
//        pid, and while /tmp/bento-user-active exists (exit 75).
import AppKit
import Carbon.HIToolbox
import ImageIO
import SQLite3
import UniformTypeIdentifiers

var args = Array(CommandLine.arguments.dropFirst())
func fail(_ s: String) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(1) }
func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let v = args[i + 1]; args.removeSubrange(i...(i + 1)); return v
}
func flag(_ name: String) -> Bool {
    guard let i = args.firstIndex(of: name) else { return false }
    args.remove(at: i); return true
}
let pbName = opt("--pb")
let bare = flag("--bare")
let pb = pbName.map { NSPasteboard(name: NSPasteboard.Name($0)) } ?? .general
let markers = bare ? [] : [NSPasteboard.PasteboardType("org.nspasteboard.TransientType"),
                           NSPasteboard.PasteboardType("com.charles.bento.dev-test")]

func mark(_ item: NSPasteboardItem) { for m in markers { item.setData(Data(), forType: m) } }
func write(_ item: NSPasteboardItem) {
    mark(item)
    pb.clearContents()
    guard pb.writeObjects([item]) else { fail("write failed") }
}

func image(_ w: Int, _ h: Int, noise: Bool) -> CGImage {
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(red: .random(in: 0...1), green: .random(in: 0...1), blue: .random(in: 0...1), alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    if noise, let p = ctx.data?.assumingMemoryBound(to: UInt32.self) {
        var x: UInt32 = 2463534242
        for i in 0..<(ctx.bytesPerRow / 4 * h) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; p[i] = x | 0xFF00_0000 }
    }
    // Some text so OCR has something to find.
    let ns = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = ns
    let size = max(12, CGFloat(min(w, h)) / 10)
    ("Bento QA \(w)x\(h)" as NSString).draw(at: CGPoint(x: size, y: CGFloat(h) / 2),
        withAttributes: [.font: NSFont.boldSystemFont(ofSize: size), .foregroundColor: NSColor.black, .backgroundColor: NSColor.white])
    NSGraphicsContext.restoreGraphicsState()
    return ctx.makeImage()!
}

func encode(_ images: [CGImage], _ type: UTType) -> Data {
    let data = NSMutableData()
    let dest = CGImageDestinationCreateWithData(data, type.identifier as CFString, images.count, nil)!
    for i in images { CGImageDestinationAddImage(dest, i, nil) }
    guard CGImageDestinationFinalize(dest) else { fail("encode failed") }
    return data as Data
}

final class NeverProvider: NSObject, NSPasteboardItemDataProvider {
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {}
}

guard let cmd = args.first else { fail("usage: see header") }
switch cmd {
case "save":
    let items = (pb.pasteboardItems ?? []).map { item -> [String: Data] in
        var d: [String: Data] = [:]
        for t in item.types { if let v = item.data(forType: t) { d[t.rawValue] = v } }
        return d
    }
    let data = try PropertyListSerialization.data(fromPropertyList: items, format: .binary, options: 0)
    try data.write(to: URL(fileURLWithPath: args[1]))
    print("saved \(items.count) item(s)")
case "restore":
    let data = try Data(contentsOf: URL(fileURLWithPath: args[1]))
    let items = try PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Data]] ?? []
    pb.clearContents()
    if !items.isEmpty {
        let objs = items.map { d -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (t, v) in d { item.setData(v, forType: NSPasteboard.PasteboardType(t)) }
            return item
        }
        mark(objs[0])
        pb.writeObjects(objs)
    }
    print("restored \(items.count) item(s)")
case "write":
    guard args.count >= 2 else { fail("write <kind> …") }
    let a = Array(args.dropFirst(2))
    let item = NSPasteboardItem()
    switch args[1] {
    case "text": item.setString(a[0], forType: .string)
    case "textfile": item.setString(try String(contentsOfFile: a[0], encoding: .utf8), forType: .string)
    case "rtf":
        let attr = NSAttributedString(string: a[0], attributes: [.font: NSFont.boldSystemFont(ofSize: 18), .foregroundColor: NSColor.systemRed])
        item.setData(try attr.data(from: NSRange(location: 0, length: attr.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]), forType: .rtf)
        item.setString(a[0], forType: .string)
    case "html":
        item.setData(Data("<meta charset='utf-8'><b>\(a[0])</b>".utf8), forType: .html)
        item.setString(a[0], forType: .string)
    case "link":
        item.setString(a[0], forType: .string)
        item.setString(a[0], forType: .URL)
        if a.count > 1 { item.setString(a[1], forType: NSPasteboard.PasteboardType("public.url-name")) }
    case "color": item.setString(a[0], forType: .string)
    case "png": item.setData(encode([image(Int(a[0])!, Int(a[1])!, noise: a.count > 2)], .png), forType: .png)
    case "tiff": item.setData(encode([image(Int(a[0])!, Int(a[1])!, noise: false)], .tiff), forType: .tiff)
    case "gif":
        let frames = (0..<(Int(a.first ?? "3") ?? 3)).map { _ in image(120, 80, noise: false) }
        item.setData(encode(frames, .gif), forType: NSPasteboard.PasteboardType(UTType.gif.identifier))
    case "files":
        pb.clearContents()
        guard pb.writeObjects(a.map { URL(fileURLWithPath: $0) as NSURL }) else { fail("write failed") }
        pb.addTypes(markers, owner: nil)
        for m in markers { pb.setData(Data(), forType: m) }
        exit(0)
    case "concealed":
        item.setString(a[0], forType: .string)
        item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
    case "typeless": item.setData(Data(), forType: NSPasteboard.PasteboardType("com.example.bento-qa-empty"))
    case "empty": pb.clearContents(); exit(0)
    case "promised":
        let provider = NeverProvider()
        item.setDataProvider(provider, forTypes: [.string, NSPasteboard.PasteboardType("com.example.bento-qa-lazy")])
        write(item)
        // Keep the provider alive briefly so readers ask it (and get nothing).
        RunLoop.main.run(until: Date().addingTimeInterval(2))
        withExtendedLifetime(provider) {}
        exit(0)
    default: fail("unknown kind \(args[1])")
    }
    write(item)
case "burst":
    let n = Int(args[1])!, ms = Int(args[2])!, prefix = args[3]
    for i in 0..<n {
        let item = NSPasteboardItem()
        item.setString("\(prefix) \(i)", forType: .string)
        write(item)
        usleep(useconds_t(ms * 1000))
    }
case "info":
    print("changeCount", pb.changeCount)
    print("types", (pb.pasteboardItems?.first?.types ?? []).map(\.rawValue).joined(separator: " "))
    print("items", pb.pasteboardItems?.count ?? 0)
    if let s = pb.string(forType: .string) { print("string", s.prefix(200)) }
case "count": print(pb.changeCount)
case "frontpid": print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
case "key":
    guard let expect = opt("--expect-pid").flatMap(Int32.init) else { fail("key needs --expect-pid <pid>") }
    if FileManager.default.fileExists(atPath: "/tmp/bento-user-active") {
        FileHandle.standardError.write("user is active; refusing to post input\n".data(using: .utf8)!); exit(75)
    }
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    guard front == expect else { fail("frontmost pid is \(front), expected \(expect); not typing") }
    // Register with the input guard (scripts/e2e/guard.swift) so our events are not taken for the user's.
    if let h = FileHandle(forWritingAtPath: "/tmp/bento-e2e-pids") ?? {
        FileManager.default.createFile(atPath: "/tmp/bento-e2e-pids", contents: nil); return FileHandle(forWritingAtPath: "/tmp/bento-e2e-pids") }() {
        h.seekToEndOfFile(); h.write("\(getpid())\n".data(using: .utf8)!); h.closeFile()
    }
    let codes: [String: Int] = [
        "a": kVK_ANSI_A, "c": kVK_ANSI_C, "k": kVK_ANSI_K, "n": kVK_ANSI_N, "p": kVK_ANSI_P, "q": kVK_ANSI_Q,
        "t": kVK_ANSI_T, "v": kVK_ANSI_V, "x": kVK_ANSI_X, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
        "return": kVK_Return, "escape": kVK_Escape, "delete": kVK_Delete, "down": kVK_DownArrow, "up": kVK_UpArrow,
    ]
    for combo in args.dropFirst() {
        let parts = combo.lowercased().split(separator: "+")
        guard let k = parts.last, let code = codes[String(k)] else { fail("bad key \(combo)") }
        var flags: CGEventFlags = []
        for m in parts.dropLast() {
            switch m {
            case "cmd": flags.insert(.maskCommand)
            case "opt": flags.insert(.maskAlternate)
            case "ctrl": flags.insert(.maskControl)
            case "shift": flags.insert(.maskShift)
            default: fail("bad modifier \(m)")
            }
        }
        if code == kVK_DownArrow || code == kVK_UpArrow { flags.formUnion([.maskNumericPad, .maskSecondaryFn]) }
        let src = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: true)!
        let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: false)!
        down.flags = flags; up.flags = flags
        down.post(tap: .cghidEventTap); usleep(25000); up.post(tap: .cghidEventTap)
        usleep(60000)
    }
case "release": NSPasteboard(name: NSPasteboard.Name(args[1])).releaseGlobally()
case "seed":
    // Rows look like what the app writes (see ClipStore schema).
    let dbPath = args[1], imagesDir = args[2], thumbsDir = args[3], n = Int(args[4])!, every = Int(args.count > 5 ? args[5] : "10")!
    var db: OpaquePointer?
    guard sqlite3_open(dbPath, &db) == SQLITE_OK else { fail("open \(dbPath)") }
    sqlite3_exec(db, "PRAGMA journal_mode=WAL; BEGIN", nil, nil, nil)
    let sql = """
        INSERT OR IGNORE INTO items (kind, hash, title, text, image_file, thumb_file, image_type, width, height, byte_size,
            ocr_done, source_app, source_bundle, first_copied, last_copied)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
    var st: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { fail(String(cString: sqlite3_errmsg(db))) }
    let T = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    let now = Date().timeIntervalSince1970
    let words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "smørrebrød", "Æblegrød", "naïve", "café"]
    var thumbPNG: Data?
    for i in 0..<n {
        func text(_ k: Int32, _ s: String?) { if let s { sqlite3_bind_text(st, k, s, -1, T) } else { sqlite3_bind_null(st, k) } }
        let t = now - Double(i) * 600 // one item every 10 minutes going back
        var kind = "text", title = "", body: String? = nil, imageFile: String? = nil, thumbFile: String? = nil
        var w = 0, h = 0, bytes = 0, ocrDone = 1
        if every > 0 && i % every == 0 {
            kind = "image"; w = 400 + (i % 7) * 100; h = 300 + (i % 5) * 80
            let name = "seed-\(i)"
            let png = encode([image(w, h, noise: false)], .png)
            try png.write(to: URL(fileURLWithPath: imagesDir).appendingPathComponent(name + ".png"))
            if thumbPNG == nil || i % (every * 10) == 0 { thumbPNG = encode([image(192, 144, noise: false)], .png) }
            try thumbPNG!.write(to: URL(fileURLWithPath: thumbsDir).appendingPathComponent(name + ".png"))
            imageFile = name + ".png"; thumbFile = name + ".png"; title = "Image (\(w)×\(h))"; bytes = png.count; ocrDone = 0
        } else if i % 13 == 1 {
            kind = "link"; body = "https://example.com/qa/\(i)/\(words[i % words.count])"; title = body!
        } else if i % 17 == 2 {
            kind = "color"; body = String(format: "#%06X", (i * 2654435761) & 0xFFFFFF); title = body!
        } else if i % 19 == 3 {
            kind = "file"; body = "/tmp/bento-qa-file-\(i).txt"; title = "bento-qa-file-\(i).txt"
        } else {
            body = "Seed item \(i) " + (0..<(5 + i % 40)).map { words[($0 * 7 + i) % words.count] }.joined(separator: " ")
                + (i % 50 == 0 ? "\nfunc demo\(i)() {\n    return \(i);\n}" : "")
            title = String(body!.split(separator: "\n").first!.prefix(200))
        }
        bytes += body?.utf8.count ?? 0
        sqlite3_reset(st)
        text(1, kind); text(2, "seed-\(i)-\(kind)"); text(3, title); text(4, body); text(5, imageFile); text(6, thumbFile)
        text(7, imageFile == nil ? nil : "public.png")
        sqlite3_bind_int64(st, 8, Int64(w)); sqlite3_bind_int64(st, 9, Int64(h)); sqlite3_bind_int64(st, 10, Int64(bytes))
        sqlite3_bind_int64(st, 11, Int64(ocrDone)); text(12, "TextEdit"); text(13, "com.apple.TextEdit")
        sqlite3_bind_double(st, 14, t); sqlite3_bind_double(st, 15, t)
        guard sqlite3_step(st) == SQLITE_DONE else { fail(String(cString: sqlite3_errmsg(db))) }
    }
    sqlite3_finalize(st)
    sqlite3_exec(db, "COMMIT", nil, nil, nil)
    sqlite3_close(db)
    print("seeded \(n)")
default:
    fail("unknown command \(cmd)")
}
