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
    private init() {}

    /// Stores the capture in history and opens it in an editor window.
    public func open(_ capture: CapturedImage) {
        // Placeholder until the editor is implemented.
        record(capture)
        copyToClipboard(capture.image, scale: capture.scale)
        HUD.show("Copied (editor not built yet)", symbol: "doc.on.doc")
    }

    /// Stores the capture in history without opening an editor (for
    /// "copy immediately" / "save immediately" after-capture modes).
    @discardableResult
    public func record(_ capture: CapturedImage) -> URL? { nil }

    /// Re-opens the most recent capture, with its annotations still editable.
    public func reopenLast() {}

    /// Browser of recent captures (re-edit, copy, save, delete).
    public func showHistory() {}

    /// Floating, always-on-top window showing the image.
    public func pin(_ capture: CapturedImage) {}

    /// Opens an image file in the editor (e.g. from Finder or history).
    public func open(fileURL: URL) {}

    /// Copies an image as PNG + TIFF with correct point size for Retina.
    public func copyToClipboard(_ image: CGImage, scale: CGFloat) {
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = NSSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale)
        let pb = NSPasteboard.general
        pb.clearContents()
        if let png = rep.representation(using: .png, properties: [:]) { pb.setData(png, forType: .png) }
        if let tiff = rep.tiffRepresentation { pb.setData(tiff, forType: .tiff) }
    }

    /// Settings pane embedded by the Shot module's settings view.
    public func makeSettingsView() -> AnyView? { nil }
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
