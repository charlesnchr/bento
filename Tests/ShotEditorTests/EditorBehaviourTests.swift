import AppKit
import Foundation
import Testing
import BentoCore
@testable import ShotEditor

// Headless tests of a real EditorController: its window is built (never
// shown), mouse and key events are synthesized and sent to the canvas the
// way AppKit would. Config, history and the clipboard are isolated.

/// Points config / history at a temp dir. Must run before anything touches
/// `ConfigStore.shared` / `HistoryStore.shared` (only these tests do).
private let isolatedHome: URL = {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("shoteditor-home-\(getpid())", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    setenv("BENTO_HOME", url.path, 1)
    return url
}()

private let testPasteboard = NSPasteboard(name: NSPasteboard.Name("bento.shoteditor.tests.\(getpid())"))

@MainActor
private func setUp() {
    _ = isolatedHome
    _ = NSApplication.shared
    Clipboard.pasteboard = testPasteboard
    Feedback.muted = true
    // Fresh per-tool size / style memory for every editor.
    let suite = "bento.shoteditor.tests.\(getpid())"
    UserDefaults().removePersistentDomain(forName: suite)
    ToolMemory.defaults = UserDefaults(suiteName: suite)!
}

private func image(width: Int, height: Int, gray: CGFloat = 1, draw: ((CGContext) -> Void)? = nil) -> CGImage {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(gray: gray, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    draw?(ctx)
    return ctx.makeImage()!
}

@MainActor
private func makeEditor(width: Int = 800, height: Int = 500, scale: CGFloat = 1, inHistory: Bool = false) -> EditorController {
    setUp()
    let img = image(width: width, height: height)
    let doc: ShotDocument
    if inHistory {
        doc = HistoryStore.shared.add(image: img, scale: scale, date: Date(), kind: "area", rect: .zero,
                                      appName: "Tests", bundleID: nil, async: false).doc
    } else {
        doc = ShotDocument(id: "unsaved-\(UUID().uuidString)", created: Date(), modified: Date(), kind: "area", scale: scale,
                           pixelWidth: width, pixelHeight: height)
    }
    let ed = EditorController(doc: doc, image: img)
    ed.window.setContentSize(NSSize(width: 900, height: 600))
    ed.window.layoutIfNeeded()
    ed.zoomActual()
    return ed
}

/// Lets the undo manager close its per-event group (it does so on the run loop).
@MainActor
private func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }

@MainActor
private func mouse(_ ed: EditorController, _ type: NSEvent.EventType, _ p: CGPoint, clicks: Int = 1,
                   mods: NSEvent.ModifierFlags = []) {
    let c = ed.doc.canvasRect
    let win = ed.canvas.convert(CGPoint(x: p.x - c.minX, y: p.y - c.minY), to: nil)
    let e = NSEvent.mouseEvent(with: type, location: win, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: ed.window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
    let v = ed.canvas.annotationView
    switch type {
    case .leftMouseDown: v.mouseDown(with: e)
    case .leftMouseDragged: v.mouseDragged(with: e)
    case .leftMouseUp: v.mouseUp(with: e)
    default: break
    }
}

@MainActor
private func drag(_ ed: EditorController, from a: CGPoint, to b: CGPoint, mods: NSEvent.ModifierFlags = []) {
    mouse(ed, .leftMouseDown, a, mods: mods)
    for i in 1...5 {
        let t = CGFloat(i) / 5
        mouse(ed, .leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t), mods: mods)
    }
    mouse(ed, .leftMouseUp, b, mods: mods)
    settle()
}

@MainActor
private func click(_ ed: EditorController, _ p: CGPoint, clicks: Int = 1) {
    mouse(ed, .leftMouseDown, p, clicks: clicks)
    mouse(ed, .leftMouseUp, p, clicks: clicks)
    settle()
}

@MainActor
private func key(_ ed: EditorController, _ chars: String, code: UInt16, mods: NSEvent.ModifierFlags = []) {
    let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                             windowNumber: ed.window.windowNumber, context: nil, characters: chars,
                             charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
    if mods.contains(.command), ed.window.performKeyEquivalent(with: e) { settle(); return }
    ed.canvas.annotationView.keyDown(with: e)
    settle()
}

private let keyCodes: [Character: UInt16] = ["a": 0, "s": 1, "d": 2, "h": 4, "c": 8, "v": 9, "b": 11, "e": 14, "r": 15,
                                             "t": 17, "o": 31, "u": 32, "i": 34, "l": 37, "m": 46, "z": 6]

@MainActor
private func tool(_ ed: EditorController, _ c: Character) { key(ed, String(c), code: keyCodes[c]!) }

private func kinds(_ ed: EditorController) -> [Annotation.Kind] { ed.doc.annotations.map(\.kind) }

@Suite(.serialized) @MainActor
struct EditorBehaviourTests {
    // MARK: Tools

    @Test func everyDrawingToolCreatesSelectsMovesAndDeletes() {
        let ed = makeEditor()
        let tools: [(Character, Annotation.Kind)] = [("a", .arrow), ("r", .rect), ("d", .freehand), ("m", .magnifier),
                                                    ("h", .highlight), ("b", .blur), ("e", .erase), ("s", .spotlight),
                                                    ("o", .oval), ("l", .line), ("u", .ruler)]
        // One cell per tool, far enough apart that no drag starts on an earlier annotation.
        for (i, (c, kind)) in tools.enumerated() {
            tool(ed, c)
            #expect(ed.tool.kind == kind)
            let x = 30 + CGFloat(i % 4) * 190, y = 40 + CGFloat(i / 4) * 150
            drag(ed, from: CGPoint(x: x, y: y), to: CGPoint(x: x + 60, y: y + 14))
            #expect(ed.doc.annotations.last?.kind == kind, "tool \(c)")
        }
        tool(ed, "c")
        click(ed, CGPoint(x: 700, y: 470))
        click(ed, CGPoint(x: 740, y: 470))
        #expect(ed.doc.annotations.suffix(2).map(\.number) == [1, 2])
        #expect(ed.doc.annotations.count == tools.count + 2)

        // Select (V), move the arrow by dragging it, then delete it with ⌫.
        tool(ed, "v")
        let arrow = ed.doc.annotations[0]
        drag(ed, from: CGPoint(x: 60, y: 47), to: CGPoint(x: 80, y: 67))
        let moved = ed.doc.annotations.first { $0.id == arrow.id }!
        #expect(abs(moved.p1.x - arrow.p1.x - 20) < 0.01 && abs(moved.p1.y - arrow.p1.y - 20) < 0.01)
        #expect(ed.selectedID == arrow.id)
        key(ed, "\u{7F}", code: 51)
        #expect(!ed.doc.annotations.contains { $0.id == arrow.id })
        ed.close()
    }

    @Test func pressingTheToolKeyAgainCyclesStyles() {
        let ed = makeEditor()
        tool(ed, "r")
        let start = ed.currentStyle(for: .rect)
        tool(ed, "r")
        #expect(ed.currentStyle(for: .rect) == (start + 1) % 3)
        drag(ed, from: CGPoint(x: 20, y: 20), to: CGPoint(x: 120, y: 90))
        #expect(ed.doc.annotations.last?.style == (start + 1) % 3)
        // With the new rect selected, R restyles it (one undo step).
        tool(ed, "r")
        #expect(ed.doc.annotations.last?.style == (start + 2) % 3)
        ed.performUndo()
        #expect(ed.doc.annotations.last?.style == (start + 1) % 3)
        ed.close()
    }

    @Test func resizeByHandleAndRestyleSelected() {
        let ed = makeEditor()
        tool(ed, "r")
        drag(ed, from: CGPoint(x: 50, y: 50), to: CGPoint(x: 150, y: 120))
        let id = ed.doc.annotations[0].id
        // Bottom-right handle (index 2) to (200, 160).
        drag(ed, from: CGPoint(x: 150, y: 120), to: CGPoint(x: 200, y: 160))
        #expect(ed.doc.annotations[0].rect == CGRect(x: 50, y: 50, width: 150, height: 110))
        ed.setColor("#0A84FF")
        settle()
        ed.setSize(9, final: true)
        settle()
        #expect(ed.doc.annotations[0].color == "#0A84FF" && ed.doc.annotations[0].size == 9)
        ed.performUndo(); ed.performUndo()
        #expect(ed.doc.annotations[0].size != 9 && ed.doc.annotations[0].color != "#0A84FF")
        ed.performUndo()
        #expect(ed.doc.annotations[0].rect == CGRect(x: 50, y: 50, width: 100, height: 70))
        #expect(ed.selectedID == id)
        ed.close()
    }

    // MARK: Undo / redo

    @Test func longUndoRedoSequenceWithCrop() {
        let ed = makeEditor()
        tool(ed, "a")
        for i in 0..<12 { drag(ed, from: CGPoint(x: 10, y: 10 + CGFloat(i) * 15), to: CGPoint(x: 100, y: 12 + CGFloat(i) * 15)) }
        tool(ed, "v")
        drag(ed, from: CGPoint(x: 5, y: 5), to: CGPoint(x: 300, y: 200))
        key(ed, "\r", code: 36) // crop to the selection
        #expect(ed.doc.crop == CGRect(x: 5, y: 5, width: 295, height: 195))
        tool(ed, "r")
        drag(ed, from: CGPoint(x: 150, y: 50), to: CGPoint(x: 250, y: 150))
        #expect(ed.doc.annotations.count == 13)
        let final = ed.state

        for _ in 0..<14 { ed.performUndo() }
        #expect(ed.doc.annotations.isEmpty && ed.doc.crop == nil)
        #expect(!ed.undo.canUndo)
        for _ in 0..<14 { ed.performRedo() }
        #expect(ed.state == final)

        // Redo is cleared by a new edit after undoing.
        ed.performUndo()
        #expect(ed.doc.crop != nil && ed.doc.annotations.count == 12)
        ed.performUndo()
        #expect(ed.doc.crop == nil && ed.doc.annotations.count == 12)
        tool(ed, "o")
        drag(ed, from: CGPoint(x: 300, y: 100), to: CGPoint(x: 350, y: 150))
        #expect(!ed.undo.canRedo)
        #expect(kinds(ed).last == .oval && ed.doc.crop == nil)
        ed.performUndo()
        #expect(ed.doc.annotations.count == 12)
        ed.close()
    }

    @Test func undoDuringADragDoesNotResurrectState() {
        let ed = makeEditor()
        tool(ed, "r")
        drag(ed, from: CGPoint(x: 50, y: 50), to: CGPoint(x: 150, y: 120))
        drag(ed, from: CGPoint(x: 200, y: 50), to: CGPoint(x: 300, y: 120))
        tool(ed, "v")
        // Start moving the second rect, undo mid-drag, keep dragging, release.
        mouse(ed, .leftMouseDown, CGPoint(x: 300, y: 85))
        mouse(ed, .leftMouseDragged, CGPoint(x: 320, y: 95))
        ed.performUndo()
        mouse(ed, .leftMouseDragged, CGPoint(x: 340, y: 105))
        mouse(ed, .leftMouseUp, CGPoint(x: 340, y: 105))
        settle()
        #expect(ed.doc.annotations.count == 1)
        ed.performRedo()
        #expect(ed.doc.annotations.count == 2)
        #expect(ed.doc.annotations[1].rect == CGRect(x: 200, y: 50, width: 100, height: 70))
        ed.close()
    }

    @Test func pendingSliderEditIsCommittedBeforeOtherEdits() {
        let ed = makeEditor()
        tool(ed, "r")
        drag(ed, from: CGPoint(x: 50, y: 50), to: CGPoint(x: 150, y: 120))
        let a = ed.doc.annotations[0]
        // A slider drag whose final (mouse-up) action never arrived...
        ed.setSize(8, final: false)
        // ...then another edit.
        tool(ed, "o")
        drag(ed, from: CGPoint(x: 200, y: 50), to: CGPoint(x: 260, y: 120))
        #expect(ed.doc.annotations.count == 2)
        ed.performUndo() // oval
        #expect(ed.doc.annotations.count == 1 && ed.doc.annotations[0].size == 8)
        ed.performUndo() // size
        #expect(ed.doc.annotations[0].size == a.size)
        ed.performUndo() // rect
        #expect(ed.doc.annotations.isEmpty)
        ed.performRedo(); ed.performRedo(); ed.performRedo()
        #expect(ed.doc.annotations.count == 2 && ed.doc.annotations[0].size == 8)
        ed.close()
    }

    // MARK: Text

    @Test func textCreateEditEmptyAndStyleWhileTyping() {
        let ed = makeEditor()
        tool(ed, "t")
        click(ed, CGPoint(x: 100, y: 100))
        let id = ed.editingTextID
        #expect(id != nil)
        // Restyling while typing is part of the text edit, not separate steps.
        ed.textChanged("Hel")
        ed.setColor("#34C759")
        ed.setStyle(1)
        ed.setSize(7, final: true)
        ed.textChanged("Hello")
        key(ed, "\u{1B}", code: 53) // Esc ends editing (doesn't close)
        #expect(ed.editingTextID == nil && !ed.isClosed)
        let t = ed.doc.annotations.first { $0.id == id }
        #expect(t?.text == "Hello" && t?.color == "#34C759" && t?.style == 1 && t?.size == 7)
        ed.performUndo()
        #expect(ed.doc.annotations.isEmpty, "one undo removes the new text with its style")
        ed.performUndo()
        #expect(ed.doc.annotations.isEmpty, "nothing is resurrected")
        ed.performRedo()
        #expect(ed.doc.annotations.first?.text == "Hello")

        // Editing existing text: double-click, change, Esc; undo restores the old text.
        tool(ed, "v")
        let frame = Renderer.textLayout(ed.doc.annotations[0]).frame
        click(ed, CGPoint(x: frame.midX, y: frame.midY))
        click(ed, CGPoint(x: frame.midX, y: frame.midY), clicks: 2)
        #expect(ed.editingTextID == id)
        ed.textChanged("Hello world")
        ed.endTextEditing()
        settle()
        #expect(ed.doc.annotations[0].text == "Hello world")
        ed.performUndo()
        #expect(ed.doc.annotations[0].text == "Hello")

        // Clearing the text deletes the annotation (undoable).
        ed.beginTextEditing(ed.doc.annotations[0].id, isNew: false)
        ed.textChanged("   \n")
        ed.endTextEditing()
        settle()
        #expect(ed.doc.annotations.isEmpty)
        ed.performUndo()
        #expect(ed.doc.annotations.first?.text == "Hello")

        // A new empty text leaves nothing behind and no undo step.
        tool(ed, "t")
        click(ed, CGPoint(x: 300, y: 300))
        ed.endTextEditing()
        settle()
        #expect(ed.doc.annotations.count == 1)
        ed.close()
    }

    @Test func veryLongTextRendersAndFlattens() throws {
        let ed = makeEditor()
        tool(ed, "t")
        click(ed, CGPoint(x: 10, y: 10))
        let long = String(repeating: "Lorem ipsum dolor sit amet. ", count: 800) + "\n" + String(repeating: "x\n", count: 300)
        ed.textChanged(long)
        ed.canvas.annotationView.syncTextEditor()
        ed.endTextEditing()
        settle()
        #expect(ed.doc.annotations.first?.text == long)
        let out = try #require(ed.flattened())
        #expect(out.width == 800 && out.height == 500)
        ed.canvas.annotationView.display() // draws without trapping
        ed.close()
    }

    @Test func closingMidEditSavesTheText() throws {
        let ed = makeEditor(inHistory: true)
        let docID = ed.doc.id
        tool(ed, "t")
        click(ed, CGPoint(x: 60, y: 60))
        ed.textChanged("typed before closing")
        ed.close()
        let entry = try #require(HistoryStore.shared.entry(id: docID))
        #expect(entry.doc.annotations.map(\.text) == ["typed before closing"])
        HistoryStore.shared.waitForWrites()
        #expect(FileManager.default.fileExists(atPath: entry.thumbURL.path))
        HistoryStore.shared.delete(docID)
    }

    // MARK: Keyboard

    @Test func selectionKeysIncludingShiftedBrackets() {
        let ed = makeEditor()
        tool(ed, "v")
        drag(ed, from: CGPoint(x: 100, y: 100), to: CGPoint(x: 200, y: 150))
        #expect(ed.region == CGRect(x: 100, y: 100, width: 100, height: 50))
        key(ed, "]", code: 30)
        #expect(ed.region == CGRect(x: 99, y: 99, width: 102, height: 52))
        key(ed, "}", code: 30, mods: .shift) // ⇧] grows by 10 (characters are "}")
        #expect(ed.region == CGRect(x: 89, y: 89, width: 122, height: 72))
        key(ed, "{", code: 33, mods: .shift)
        #expect(ed.region == CGRect(x: 99, y: 99, width: 102, height: 52))
        key(ed, "", code: 124) // → nudges
        #expect(ed.region?.minX == 100)
        key(ed, "", code: 125, mods: [.command, .shift]) // ⌘⇧↓ grows height by 10
        #expect(ed.region?.height == 62)
        // C with a selection copies its average colour (white image).
        key(ed, "c", code: 8)
        #expect(testPasteboard.string(forType: .string) == "#FFFFFF")
        #expect(ed.tool == .select)
        // B blurs the selection.
        key(ed, "b", code: 11)
        #expect(kinds(ed) == [.blur] && ed.region == nil)
        ed.close()
    }

    @Test func escapePriorities() {
        let ed = makeEditor()
        var s = EditorSettings()
        s.escAction = .close
        ConfigStore.shared.setSection(EditorSettings.section, s)
        tool(ed, "v")
        drag(ed, from: CGPoint(x: 100, y: 100), to: CGPoint(x: 200, y: 150))
        key(ed, "\u{1B}", code: 53)
        #expect(ed.region == nil && !ed.isClosed)
        // Esc during a drag cancels the drag.
        tool(ed, "r")
        mouse(ed, .leftMouseDown, CGPoint(x: 10, y: 10))
        mouse(ed, .leftMouseDragged, CGPoint(x: 80, y: 80))
        key(ed, "\u{1B}", code: 53)
        mouse(ed, .leftMouseUp, CGPoint(x: 80, y: 80))
        #expect(ed.doc.annotations.isEmpty && ed.draft == nil && !ed.isClosed)
        key(ed, "\u{1B}", code: 53)
        #expect(ed.isClosed)
        ConfigStore.shared.setSection(EditorSettings.section, EditorSettings())
    }

    // MARK: Output

    @Test func copyPutsPNGWithPointSizeAndLazyTIFF() throws {
        let ed = makeEditor(width: 640, height: 400, scale: 2)
        tool(ed, "r")
        drag(ed, from: CGPoint(x: 20, y: 20), to: CGPoint(x: 100, y: 80))
        ed.copyImage(hud: false)
        let png = try #require(testPasteboard.data(forType: .png))
        let rep = try #require(NSBitmapImageRep(data: png))
        #expect(rep.pixelsWide == 640 && rep.pixelsHigh == 400)
        #expect(rep.size == NSSize(width: 320, height: 200))
        #expect(testPasteboard.types?.contains(.tiff) == true)
        let tiff = try #require(LazyTIFFProvider.current?.tiffData())
        let trep = try #require(NSBitmapImageRep(data: tiff))
        #expect(trep.pixelsWide == 640 && trep.size == NSSize(width: 320, height: 200))
        #expect(tiff.count < 640 * 400 * 4 / 4, "LZW-compressed")
        // A selection copies just that part.
        tool(ed, "v")
        drag(ed, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 50, y: 25))
        ed.copyImage(hud: false)
        let partData = try #require(testPasteboard.data(forType: .png))
        let part = try #require(NSBitmapImageRep(data: partData))
        #expect(part.pixelsWide == 100 && part.pixelsHigh == 50)
        ed.close()
    }

    @Test func thumbnailIsRenderedSmall() throws {
        let ed = makeEditor(width: 2880, height: 9000, scale: 2)
        tool(ed, "r")
        drag(ed, from: CGPoint(x: 20, y: 20), to: CGPoint(x: 100, y: 80))
        let thumb = try #require(ed.thumbnailImage())
        #expect(max(thumb.width, thumb.height) <= 480)
        ed.close()
    }

    // MARK: Zoom & geometry

    @Test func zoomExtremesAndTinyImages() {
        let ed = makeEditor(width: 1, height: 1, scale: 2)
        ed.setZoom(1e9)
        #expect(ed.magnification == ed.scrollView.maxMagnification)
        ed.setZoom(.nan)
        ed.setZoom(-3)
        ed.setZoom(0)
        #expect(ed.magnification == ed.scrollView.maxMagnification)
        ed.setZoom(1e-9)
        #expect(ed.magnification == ed.scrollView.minMagnification)
        ed.zoomToFit()
        ed.zoomActual()
        ed.zoomToSelection()
        for _ in 0..<40 { ed.zoom(by: 1.25) }
        for _ in 0..<80 { ed.zoom(by: 0.8) }
        // Drawing, cropping and copying a 1×1 px capture.
        tool(ed, "r")
        drag(ed, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0.5, y: 0.5))
        tool(ed, "v")
        drag(ed, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0.4, y: 0.4))
        ed.cropToRegion()
        ed.copyImage(hud: false)
        let rep = NSBitmapImageRep(data: testPasteboard.data(forType: .png) ?? Data())
        #expect(rep?.pixelsWide == 1 && rep?.pixelsHigh == 1)
        ed.canvas.annotationView.display()
        ed.close()
    }

    @Test func closingDropsTheImagePixelsRightAway() {
        let ed = makeEditor(width: 2880, height: 3000, scale: 2)
        ed.canvas.imageView.layer?.display()
        ed.canvas.imageView.updateLayer()
        #expect(ed.canvas.imageView.layer?.contents != nil)
        ed.close()
        #expect(ed.canvas.imageView.layer?.contents == nil)
    }

    @Test func monotoneSelectionUsesTheVisibleArea() {
        let ed = makeEditor(width: 1200, height: 9000, scale: 1)
        ed.zoomActual()
        // Clicking a uniform background selects (at most) what is on screen.
        ed.selectMonotone(at: CGPoint(x: 600, y: 300))
        let r = ed.region
        #expect(r != nil)
        #expect((r?.height ?? .infinity) < 1000)
        ed.close()
    }

    @Test func ocrOnTinySelectionDoesNotCrash() async throws {
        let ed = makeEditor(width: 2, height: 2, scale: 1)
        ed.recognizeText()
        try await Task.sleep(nanoseconds: 300_000_000)
        ed.close()
    }

    // MARK: Lifetime

    @Test func closedEditorsAreReleased() {
        weak var weakEditor: EditorController?
        weak var weakWindow: NSWindow?
        autoreleasepool {
            let ed = makeEditor()
            tool(ed, "a")
            drag(ed, from: CGPoint(x: 10, y: 10), to: CGPoint(x: 100, y: 100))
            tool(ed, "t")
            click(ed, CGPoint(x: 200, y: 200))
            ed.textChanged("x")
            weakEditor = ed
            weakWindow = ed.window
            ed.close()
        }
        settle()
        #expect(weakEditor == nil)
        #expect(weakWindow == nil)
    }
}
