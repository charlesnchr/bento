import AppKit
import BentoCore

/// Recognises links, colours and code in copied text. Pure functions (tested).
enum ContentDetection {
    // MARK: Kind

    static func kind(forText text: String) -> ClipKind {
        if parseColor(text) != nil { return .color }
        if linkURL(text) != nil { return .link }
        return .text
    }

    // MARK: Links

    /// A URL when the whole (trimmed) text is a single web/mail link.
    static func linkURL(_ text: String) -> URL? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= 4096, t.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return nil }
        let lower = t.lowercased()
        if lower.hasPrefix("www."), t.count > 4, let url = URL(string: "https://" + t), url.host?.contains(".") == true {
            return url
        }
        guard let url = URL(string: t), let scheme = url.scheme?.lowercased() else { return nil }
        switch scheme {
        case "http", "https", "ftp":
            guard let host = url.host, !host.isEmpty else { return nil }
            return url
        case "mailto":
            return t.count > 7 && t.contains("@") ? url : nil
        default:
            return nil
        }
    }

    /// `www.apple.com` -> `apple.com`.
    static func domain(of url: URL) -> String? {
        if url.scheme?.lowercased() == "mailto" {
            return url.absoluteString.split(separator: "@").last.map(String.init)
        }
        guard var host = url.host?.lowercased() else { return nil }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        return host
    }

    // MARK: Colours

    struct RGBA: Equatable {
        var r: Double, g: Double, b: Double, a: Double // 0...1

        var nsColor: NSColor { NSColor(srgbRed: r, green: g, blue: b, alpha: a) }

        var hex: String {
            let c = [r, g, b].map { Int(($0 * 255).rounded()).clamped(0...255) }
            var s = String(format: "#%02X%02X%02X", c[0], c[1], c[2])
            if a < 1 { s += String(format: "%02X", Int((a * 255).rounded()).clamped(0...255)) }
            return s
        }

        var rgbString: String {
            let c = [r, g, b].map { Int(($0 * 255).rounded()).clamped(0...255) }
            if a < 1 { return "rgba(\(c[0]), \(c[1]), \(c[2]), \(Self.fmt(a)))" }
            return "rgb(\(c[0]), \(c[1]), \(c[2]))"
        }

        var hslString: String {
            let (h, s, l) = hsl
            let base = "\(Int(h.rounded())), \(Int((s * 100).rounded()))%, \(Int((l * 100).rounded()))%"
            return a < 1 ? "hsla(\(base), \(Self.fmt(a)))" : "hsl(\(base))"
        }

        var hsl: (Double, Double, Double) {
            let mx = max(r, g, b), mn = min(r, g, b)
            let l = (mx + mn) / 2
            guard mx != mn else { return (0, 0, l) }
            let d = mx - mn
            let s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
            var h: Double
            if mx == r { h = (g - b) / d + (g < b ? 6 : 0) }
            else if mx == g { h = (b - r) / d + 2 }
            else { h = (r - g) / d + 4 }
            h *= 60
            return (h, s, l)
        }

        /// Relative luminance, for choosing readable text on the swatch.
        var isLight: Bool { 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 }

        private static func fmt(_ v: Double) -> String {
            let s = String(format: "%.2f", v)
            return s.hasSuffix("0") ? String(s.dropLast()) : s
        }
    }

    /// Parses `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb()/rgba()` and `hsl()/hsla()`.
    static func parseColor(_ text: String) -> RGBA? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !t.isEmpty, t.count <= 64 else { return nil }
        if t.hasPrefix("#") { return parseHex(String(t.dropFirst())) }
        if t.hasPrefix("rgb") { return parseFunc(t, names: ["rgba", "rgb"], hsl: false) }
        if t.hasPrefix("hsl") { return parseFunc(t, names: ["hsla", "hsl"], hsl: true) }
        return nil
    }

    private static func parseHex(_ h: String) -> RGBA? {
        guard [3, 4, 6, 8].contains(h.count), h.allSatisfy(\.isHexDigit), let v = UInt64(h, radix: 16) else { return nil }
        func c(_ shift: Int, _ bits: Int) -> Double {
            let mask: UInt64 = bits == 4 ? 0xF : 0xFF
            let x = Double((v >> UInt64(shift)) & mask)
            return bits == 4 ? x * 17 / 255 : x / 255
        }
        switch h.count {
        case 3: return RGBA(r: c(8, 4), g: c(4, 4), b: c(0, 4), a: 1)
        case 4: return RGBA(r: c(12, 4), g: c(8, 4), b: c(4, 4), a: c(0, 4))
        case 6: return RGBA(r: c(16, 8), g: c(8, 8), b: c(0, 8), a: 1)
        default: return RGBA(r: c(24, 8), g: c(16, 8), b: c(8, 8), a: c(0, 8))
        }
    }

    private static func parseFunc(_ t: String, names: [String], hsl: Bool) -> RGBA? {
        guard let name = names.first(where: { t.hasPrefix($0 + "(") }), t.hasSuffix(")") else { return nil }
        let inner = t.dropFirst(name.count + 1).dropLast()
        // Accept "1, 2, 3", "1 2 3", "1 2 3 / 50%".
        let parts = inner.replacingOccurrences(of: "/", with: " ")
            .replacingOccurrences(of: ",", with: " ")
            .split(separator: " ").map(String.init)
        guard parts.count == 3 || parts.count == 4 else { return nil }
        func number(_ s: String) -> (Double, Bool)? {
            var s = s
            var pct = false
            if s.hasSuffix("%") { pct = true; s.removeLast() }
            if hsl, s.hasSuffix("deg") { s.removeLast(3) }
            guard let d = Double(s), d.isFinite else { return nil }
            return (d, pct)
        }
        guard let nums = Optional(parts.compactMap(number)), nums.count == parts.count else { return nil }
        var alpha = 1.0
        if nums.count == 4 {
            alpha = nums[3].1 ? nums[3].0 / 100 : nums[3].0
            guard (0...1).contains(alpha) else { return nil }
        }
        if hsl {
            let h = nums[0].0.truncatingRemainder(dividingBy: 360)
            let s = nums[1].0 / 100, l = nums[2].0 / 100
            guard nums[1].1, nums[2].1, (0...1).contains(s), (0...1).contains(l) else { return nil }
            let (r, g, b) = hslToRGB(h < 0 ? h + 360 : h, s, l)
            return RGBA(r: r, g: g, b: b, a: alpha)
        }
        var comps: [Double] = []
        for n in nums.prefix(3) {
            let v = n.1 ? n.0 / 100 : n.0 / 255
            guard (0...1).contains(v) else { return nil }
            comps.append(v)
        }
        return RGBA(r: comps[0], g: comps[1], b: comps[2], a: alpha)
    }

    private static func hslToRGB(_ h: Double, _ s: Double, _ l: Double) -> (Double, Double, Double) {
        let c = (1 - abs(2 * l - 1)) * s
        let x = c * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1))
        let m = l - c / 2
        let (r, g, b): (Double, Double, Double)
        switch h {
        case ..<60: (r, g, b) = (c, x, 0)
        case ..<120: (r, g, b) = (x, c, 0)
        case ..<180: (r, g, b) = (0, c, x)
        case ..<240: (r, g, b) = (0, x, c)
        case ..<300: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        return (r + m, g + m, b + m)
    }

    // MARK: Code

    /// Heuristic: does this text look like source code / config / a shell
    /// command? Used to pick a monospaced preview font.
    static func looksLikeCode(_ text: String) -> Bool {
        let sample = String(text.prefix(4000))
        let t = sample.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return false }
        if (t.hasPrefix("{") && t.hasSuffix("}")) || (t.hasPrefix("[") && t.hasSuffix("]")) || t.hasPrefix("<?xml") { return true }
        let lines = sample.split(separator: "\n", omittingEmptySubsequences: true)
        var score = 0
        let keywords = ["func ", "def ", "class ", "import ", "return ", "const ", "let ", "var ", "fn ", "#include",
                        "public ", "private ", "struct ", "if (", "for (", "while (", "=> ", "->", "#!/", "SELECT ", "package "]
        for line in lines.prefix(60) {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.hasSuffix(";") || l.hasSuffix("{") || l == "}" || l.hasSuffix("};") || l.hasSuffix(") {") { score += 2 }
            if line.hasPrefix("    ") || line.hasPrefix("\t") { score += 1 }
            if keywords.contains(where: { l.hasPrefix($0) || l.contains(" " + $0) }) { score += 2 }
            if l.hasPrefix("$ ") || l.hasPrefix("//") || l.hasPrefix("# ") && lines.count > 1 { score += 1 }
        }
        if lines.count == 1 {
            // Single line: shell commands and expressions.
            let l = t
            let shellish = ["--", " | ", " && ", "./", "~/", "sudo ", "git ", "swift ", "brew ", "npm ", "cd ", "ls "]
            if shellish.contains(where: { l.contains($0) }) && !l.contains(". ") { return true }
            let symbols = l.filter { "{}[]();=<>_$`|\\".contains($0) }.count
            return Double(symbols) / Double(max(l.count, 1)) > 0.08 && l.count > 6
        }
        return score >= max(3, lines.count / 2)
    }

    // MARK: Text helpers

    /// First non-empty line, trimmed and shortened for list rows.
    static func title(forText text: String, limit: Int = 200) -> String {
        for line in text.prefix(20_000).split(whereSeparator: \.isNewline) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { return String(t.prefix(limit)) }
        }
        return text.isEmpty ? "(empty)" : "(whitespace)"
    }

    struct TextStats: Equatable { var characters: Int; var words: Int; var lines: Int }

    static func stats(_ text: String) -> TextStats {
        var words = 0
        text.enumerateSubstrings(in: text.startIndex..., options: [.byWords, .substringNotRequired]) { _, _, _, _ in words += 1 }
        let lines = text.isEmpty ? 0 : text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).count
        return TextStats(characters: text.count, words: words, lines: lines)
    }

    /// Text of a lone `<a href>` in HTML (browsers' "Copy Link" flavour).
    static func anchorTitle(html: Data?) -> String? {
        guard let html, html.count < 20_000, let s = String(data: html, encoding: .utf8) else { return nil }
        guard let open = s.range(of: "<a ", options: .caseInsensitive),
              let tagEnd = s.range(of: ">", range: open.upperBound..<s.endIndex),
              let close = s.range(of: "</a>", options: .caseInsensitive, range: tagEnd.upperBound..<s.endIndex) else { return nil }
        let inner = String(s[tagEnd.upperBound..<close.lowerBound])
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return inner.isEmpty ? nil : inner
    }
}
