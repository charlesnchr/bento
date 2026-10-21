import AppKit
import SwiftUI
import Vision
import BentoCore

// Public interface between the capture module (`Shot`) and the editor library
// (`ShotEditor`). The capture side produces `CapturedImage`s; everything after
// the pixels exist (editor window, history, re-editing, pinning, copy/save)
// lives in ShotEditor. Signatures here are a contract: extend, don't break.

/// A finished capture handed from Shot to ShotEditor.
public struct CapturedImage {
    public enum Kind: String, Codable { case area, window, fullscreen, scrolling, repeatArea, pasted, file }

    /// Pixels at native (Retina) resolution.
    public let image: CGImage
    /// Pixels per point of the source display (2 on Retina).
    public let scale: CGFloat
    /// Captured rect in global AX coordinates (points, top-left origin). `.zero` if unknown.
    public let rect: CGRect
    public let date: Date
    public let kind: Kind
    /// App that owned the captured window / was frontmost, if known.
    public let sourceAppName: String?
    public let sourceBundleID: String?

    public init(image: CGImage, scale: CGFloat, rect: CGRect = .zero, date: Date = Date(), kind: Kind,
                sourceAppName: String? = nil, sourceBundleID: String? = nil) {
        self.image = image
        self.scale = scale
        self.rect = rect
        self.date = date
        self.kind = kind
        self.sourceAppName = sourceAppName
        self.sourceBundleID = sourceBundleID
    }

    /// Size in points.
    public var pointSize: CGSize { CGSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale) }
}

/// Editor, history and pinning. Main thread only.
public final class ShotEditor {
    public static let shared = ShotEditor()

    private var editors: [EditorController] = []
    private var pins: [PinController] = []
    private var history: HistoryWindowController?
    private var lastPrune = Date.distantPast
    /// The most recently recorded capture, so `pin(_:)` after `record(_:)` can
    /// link the pin to its history entry (double-click re-opens it).
    private var lastRecorded: (image: CGImage, id: String)?
    private var store: HistoryStore { .shared }

    private init() {
        ConfigStore.shared.materialize(EditorSettings.section, default: EditorSettings())
        DispatchQueue.main.async { [weak self] in self?.pruneIfNeeded(force: true) }
    }

    /// Stores the capture in history and opens it in an editor window.
    public func open(_ capture: CapturedImage) {
        let entry = add(capture, async: true)
        presentEditor(doc: entry.doc, image: capture.image, near: capture.rect)
    }

    /// Stores the capture in history without opening an editor (for
    /// "copy immediately" / "save immediately" after-capture modes).
    /// Returns the URL of the stored original PNG.
    @discardableResult
    public func record(_ capture: CapturedImage) -> URL? {
        add(capture, async: false).imageURL
    }

    /// Re-opens the most recent capture, with its annotations still editable.
    public func reopenLast() {
        guard let e = store.entries().first else {
            HUD.show("No captures yet", symbol: "photo.on.rectangle")
            return
        }
        reopen(entryID: e.id)
    }

    /// Browser of recent captures (re-edit, copy, save, delete).
    public func showHistory() {
        if history == nil {
            let h = HistoryWindowController()
            h.onClose = { [weak self] in
                DispatchQueue.main.async { self?.history = nil }
            }
            history = h
        } else {
            history?.reload()
        }
        history?.show()
    }

    /// Floating, always-on-top window showing the image.
    public func pin(_ capture: CapturedImage) {
        let id = lastRecorded.flatMap { $0.image === capture.image ? $0.id : nil }
        pinImage(capture.image, scale: capture.scale, entryID: id, rect: capture.rect)
    }

    /// Opens an image file in the editor (e.g. from Finder or history).
    /// History originals reopen with their annotations; other files are added to history.
    public func open(fileURL: URL) {
        if let e = store.entry(forImageAt: fileURL) {
            reopen(entryID: e.id)
            return
        }
        guard let (image, scale) = ImageCodec.load(fileURL) else {
            HUD.show("Can't open \(fileURL.lastPathComponent)", symbol: "exclamationmark.triangle")
            return
        }
        open(CapturedImage(image: image, scale: scale, kind: .file))
    }

    /// Copies an image as PNG + TIFF with correct point size for Retina.
    public func copyToClipboard(_ image: CGImage, scale: CGFloat) {
        Clipboard.copy(image, scale: scale)
    }

    /// Settings rows embedded by the Shot module's settings view (inside its
    /// "Editor" section): Esc behaviour, default tool and colour, history retention.
    /// Save folder / format / file name are the Shot module's "Saving" options, shared by ⌘S.
    public func makeSettingsView() -> AnyView? { AnyView(EditorSettingsView()) }

    // MARK: Additional API

    /// Opens the image on the clipboard (or a copied image file) in the editor.
    public func openClipboardImage() {
        guard let (image, scale) = Clipboard.image() else {
            HUD.show("No image on the clipboard", symbol: "doc.on.clipboard")
            return
        }
        open(CapturedImage(image: image, scale: scale, kind: .pasted))
    }

    /// Shows an Open panel for image files.
    public func openFilePanel() {
        AppActivation.activateSelf()
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = true
        if panel.runModal() == .OK { panel.urls.forEach(open(fileURL:)) }
    }

    /// Number of open editor windows / pins (for diagnostics and tests).
    public var openEditorCount: Int { editors.count }
    public var pinCount: Int { pins.count }

    // MARK: Internals

    private func add(_ capture: CapturedImage, async: Bool) -> HistoryStore.Entry {
        let entry = store.add(image: capture.image, scale: capture.scale, date: capture.date, kind: capture.kind.rawValue,
                              rect: capture.rect, appName: capture.sourceAppName, bundleID: capture.sourceBundleID, async: async)
        lastRecorded = (capture.image, entry.id)
        pruneIfNeeded()
        historyChanged()
        return entry
    }

    @discardableResult
    func reopen(entryID: String) -> Bool {
        if let ed = editors.first(where: { $0.doc.id == entryID }) {
            AppActivation.activateSelf()
            ed.window.makeKeyAndOrderFront(nil)
            ed.window.orderFrontRegardless()
            return true
        }
        guard let e = store.entry(id: entryID), let image = store.loadImage(e) else {
            HUD.show("Capture not found", symbol: "exclamationmark.triangle")
            return false
        }
        presentEditor(doc: e.doc, image: image, near: e.doc.captureRect)
        return true
    }

    private func presentEditor(doc: ShotDocument, image: CGImage, near rect: CGRect) {
        let ed = EditorController(doc: doc, image: image)
        ed.onClose = { [weak self] closed in
            // Defer so the window finishes closing before the controller is released.
            DispatchQueue.main.async {
                self?.editors.removeAll { $0 === closed }
                if self?.editors.isEmpty == true { EffectCache.releaseShared() }
                HistoryStore.shared.whenWritten { self?.historyChanged() }
            }
        }
        editors.append(ed)
        ed.show(near: rect)
    }

    func pinImage(_ image: CGImage, scale: CGFloat, entryID: String?, rect: CGRect) {
        let p = PinController(image: image, scale: scale, entryID: entryID, rect: rect)
        p.onClose = { [weak self] closed in
            DispatchQueue.main.async { self?.pins.removeAll { $0 === closed } }
        }
        pins.append(p)
        p.show()
    }

    private func historyChanged() {
        history?.reload()
    }

    /// Applies the retention setting at most every few hours (no timers).
    private func pruneIfNeeded(force: Bool = false) {
        guard force || Date().timeIntervalSince(lastPrune) > 6 * 3600 else { return }
        lastPrune = Date()
        let days = EditorSettings.current.historyRetentionDays
        let open = Set(editors.map(\.doc.id))
        let removed = store.prune(retentionDays: days, keeping: open)
        if !removed.isEmpty { historyChanged() }
    }
}

/// On-device OCR (Vision). Shared by capture ("copy text from area") and editor.
public enum TextRecognizer {
    /// Recognizes text, preserving line order. Accurate mode with language correction.
    public static func recognize(_ image: CGImage, languages: [String]? = nil) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            let request = VNRecognizeTextRequest { req, err in
                if let err { cont.resume(throwing: err); return }
                let obs = (req.results as? [VNRecognizedTextObservation]) ?? []
                let lines = obs
                    .sorted { a, b in
                        // Top-to-bottom, then left-to-right (Vision uses bottom-left origin).
                        abs(a.boundingBox.midY - b.boundingBox.midY) > 0.01
                            ? a.boundingBox.midY > b.boundingBox.midY
                            : a.boundingBox.minX < b.boundingBox.minX
                    }
                    .compactMap { $0.topCandidates(1).first?.string }
                cont.resume(returning: lines.joined(separator: "\n"))
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.automaticallyDetectsLanguage = true
            if let languages { request.recognitionLanguages = languages }
            do {
                try VNImageRequestHandler(cgImage: image).perform([request])
            } catch {
                cont.resume(throwing: error)
            }
        }
    }

    /// Detects QR / barcodes and returns their payloads.
    public static func barcodes(_ image: CGImage) -> [String] {
        let request = VNDetectBarcodesRequest()
        try? VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.payloadStringValue }
    }
}
