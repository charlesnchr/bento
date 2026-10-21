import Foundation

/// What a history entry holds. Links and colours are text that was recognised
/// as such; they paste back as text.
enum ClipKind: String, CaseIterable {
    case text, image, file, link, color

    var label: String {
        switch self {
        case .text: return "Text"
        case .image: return "Image"
        case .file: return "File"
        case .link: return "Link"
        case .color: return "Colour"
        }
    }

    var symbol: String {
        switch self {
        case .text: return "text.alignleft"
        case .image: return "photo"
        case .file: return "doc"
        case .link: return "link"
        case .color: return "paintpalette"
        }
    }
}

/// Type filter in the panel (⌘P cycles).
enum ClipFilter: String, CaseIterable, Identifiable {
    case all, text, images, links, files, colors

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All Types"
        case .text: return "Text"
        case .images: return "Images"
        case .links: return "Links"
        case .files: return "Files"
        case .colors: return "Colours"
        }
    }

    var symbol: String {
        switch self {
        case .all: return "square.grid.2x2"
        case .text: return ClipKind.text.symbol
        case .images: return ClipKind.image.symbol
        case .links: return ClipKind.link.symbol
        case .files: return ClipKind.file.symbol
        case .colors: return ClipKind.color.symbol
        }
    }

    var kind: ClipKind? {
        switch self {
        case .all: return nil
        case .text: return .text
        case .images: return .image
        case .links: return .link
        case .files: return .file
        case .colors: return .color
        }
    }

    var next: ClipFilter {
        let all = ClipFilter.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }
}

/// A new clipboard capture, before it is stored.
struct ClipDraft {
    var kind: ClipKind
    /// Plain text (text/link/colour), newline-separated paths (file), nil (image).
    var text: String?
    var rtf: Data?
    var html: Data?
    /// Other pasteboard representations (app-specific formats), archived.
    var extras: Data?
    var linkTitle: String?
    /// Image: file name (inside the images directory) of the stored full image.
    var imageFile: String?
    var thumbFile: String?
    var imageType: String?
    var width: Int = 0
    var height: Int = 0
    /// Bytes this entry occupies on disk (text + rich data + image file).
    var byteSize: Int = 0
    var sourceApp: String?
    var sourceBundleID: String?
    /// Dedupe key: same content -> same hash.
    var hash: String
}

/// Lightweight list row (no big blobs).
struct ClipRow: Identifiable, Equatable {
    let id: Int64
    let kind: ClipKind
    /// First line of text, file name(s), link title or URL, image description.
    let title: String
    /// Short preview of the text (for files: the paths).
    let snippet: String
    let sourceApp: String?
    let sourceBundleID: String?
    let lastCopied: Date
    let pinned: Bool
    let thumbFile: String?
    let width: Int
    let height: Int
    let isRich: Bool
}

/// Everything about one entry, loaded for the preview and for pasting.
struct ClipDetail {
    let row: ClipRow
    let text: String?
    let rtf: Data?
    let html: Data?
    let extras: Data?
    let linkTitle: String?
    let imageFile: String?
    let imageType: String?
    let byteSize: Int
    let ocrText: String?
    let ocrDone: Bool
    let firstCopied: Date
    let copyCount: Int

    var id: Int64 { row.id }
    var kind: ClipKind { row.kind }

    var fileURLs: [URL] {
        guard kind == .file, let text else { return [] }
        return text.split(separator: "\n").map { URL(fileURLWithPath: String($0)) }
    }
}
