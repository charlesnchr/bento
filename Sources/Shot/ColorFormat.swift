import Foundation

/// An 8-bit sRGB colour sampled from a capture.
struct RGB8: Equatable {
    var r: UInt8, g: UInt8, b: UInt8

    /// Rec. 709 luma, 0…255 (used to find the "text colour" = darkest pixel).
    var luma: Double { 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b) }
}

/// Colour string formats offered by the picker (Shottr has the same set,
/// minus a few exotic ones).
enum ColorFormat: String, Codable, CaseIterable {
    case hex, hexNoHash, rgb, hsl, oklch

    var title: String {
        switch self {
        case .hex: return "HEX (#1E90FF)"
        case .hexNoHash: return "HEX without #"
        case .rgb: return "rgb()"
        case .hsl: return "hsl()"
        case .oklch: return "oklch()"
        }
    }

    var next: ColorFormat {
        let all = ColorFormat.allCases
        guard let i = all.firstIndex(of: self) else { return .hex }
        return all[(i + 1) % all.count]
    }

    func string(_ c: RGB8) -> String {
        switch self {
        case .hex: return "#" + ColorFormat.hexDigits(c)
        case .hexNoHash: return ColorFormat.hexDigits(c)
        case .rgb: return "rgb(\(c.r), \(c.g), \(c.b))"
        case .hsl:
            let (h, s, l) = ColorFormat.hsl(c)
            return "hsl(\(Int(h.rounded())), \(Int((s * 100).rounded()))%, \(Int((l * 100).rounded()))%)"
        case .oklch:
            let (l, ch, h) = ColorFormat.oklch(c)
            let hue = ch < 0.0005 ? 0 : h
            return String(format: "oklch(%.1f%% %.3f %.1f)", l * 100, ch, hue)
        }
    }

    static func hexDigits(_ c: RGB8) -> String { String(format: "%02X%02X%02X", c.r, c.g, c.b) }

    /// Parses `#RRGGBB` / `RRGGBB` (used for the window background colour).
    static func parseHex(_ s: String) -> RGB8? {
        var t = s.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("#") { t.removeFirst() }
        guard t.count == 6, let v = UInt32(t, radix: 16) else { return nil }
        return RGB8(r: UInt8(v >> 16 & 0xFF), g: UInt8(v >> 8 & 0xFF), b: UInt8(v & 0xFF))
    }

    /// Hue in degrees, saturation and lightness 0…1.
    static func hsl(_ c: RGB8) -> (Double, Double, Double) {
        let r = Double(c.r) / 255, g = Double(c.g) / 255, b = Double(c.b) / 255
        let mx = max(r, g, b), mn = min(r, g, b)
        let l = (mx + mn) / 2
        let d = mx - mn
        guard d > 1e-9 else { return (0, 0, l) }
        let s = d / (1 - abs(2 * l - 1))
        var h: Double
        if mx == r { h = ((g - b) / d).truncatingRemainder(dividingBy: 6) }
        else if mx == g { h = (b - r) / d + 2 }
        else { h = (r - g) / d + 4 }
        h *= 60
        if h < 0 { h += 360 }
        return (h, s, l)
    }

    /// OKLCH (Björn Ottosson's OKLab): lightness 0…1, chroma, hue degrees.
    static func oklch(_ c: RGB8) -> (Double, Double, Double) {
        func lin(_ v: UInt8) -> Double {
            let x = Double(v) / 255
            return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4)
        }
        let r = lin(c.r), g = lin(c.g), b = lin(c.b)
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        let L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
        let A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
        let B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
        let C = (A * A + B * B).squareRoot()
        var h = atan2(B, A) * 180 / .pi
        if h < 0 { h += 360 }
        return (L, C, h)
    }
}
