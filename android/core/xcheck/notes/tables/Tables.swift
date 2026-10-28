import Foundation

// Dumps the Unicode data the Mac's string code works with, as code point ranges, for
// gen_tables.py (-> UnicodeTables.kt):
//  - Foundation CharacterSets (CoreFoundation's own bitmaps, which follow an older
//    Unicode version than ICU): letters and nonBaseCharacters drive NSString's composed
//    character sequences; whitespaces, whitespacesAndNewlines and alphanumerics are
//    what trimming and FuzzyMatch use.
//  - ICU (libicucore), which CoreFoundation's emoji sequence matching uses:
//    Grapheme_Cluster_Break, Extended_Pictographic, Grapheme_Extend, Emoji_Modifier.
//  - Swift's own grapheme data (the standard library doesn't use ICU's, which adds
//    Apple private use characters as Extend), read off how String splits characters.
//  - Swift scalar properties: canonical combining class 9 (viramas), White_Space.
// Build: swiftc -O -o tables Tables.swift -licucore && ./tables tables.json

@_silgen_name("u_hasBinaryProperty") func u_hasBinaryProperty(_ c: Int32, _ which: Int32) -> Int8
@_silgen_name("u_getIntPropertyValue") func u_getIntPropertyValue(_ c: Int32, _ which: Int32) -> Int32
@_silgen_name("u_getUnicodeVersion") func u_getUnicodeVersion(_ v: UnsafeMutablePointer<UInt8>)

func ranges(_ test: (UInt32) -> Bool) -> [[UInt32]] {
    var out: [[UInt32]] = []
    var start: UInt32? = nil
    var c: UInt32 = 0
    while c <= 0x10FFFF {
        if test(c) { if start == nil { start = c } } else if let st = start { out.append([st, c - 1]); start = nil }
        c += 1
    }
    if let st = start { out.append([st, 0x10FFFF]) }
    return out
}
func member(_ set: CharacterSet) -> (UInt32) -> Bool { { c in Unicode.Scalar(c).map { set.contains($0) } ?? false } }
func scalar(_ test: @escaping (Unicode.Scalar.Properties) -> Bool) -> (UInt32) -> Bool { { c in Unicode.Scalar(c).map { test($0.properties) } ?? false } }

let UCHAR_GRAPHEME_EXTEND: Int32 = 11, UCHAR_EMOJI_MODIFIER: Int32 = 59, UCHAR_EXTENDED_PICTOGRAPHIC: Int32 = 64
let UCHAR_GRAPHEME_CLUSTER_BREAK: Int32 = 0x1012
// sanity: the enum values above must mean what we think
precondition(u_hasBinaryProperty(0x1F600, UCHAR_EXTENDED_PICTOGRAPHIC) == 1 && u_hasBinaryProperty(0x61, UCHAR_EXTENDED_PICTOGRAPHIC) == 0)
precondition(u_hasBinaryProperty(0x301, UCHAR_GRAPHEME_EXTEND) == 1 && u_hasBinaryProperty(0x1F3FB, UCHAR_EMOJI_MODIFIER) == 1)
precondition(u_getIntPropertyValue(0x600, UCHAR_GRAPHEME_CLUSTER_BREAK) == 11 && u_getIntPropertyValue(0x200D, UCHAR_GRAPHEME_CLUSTER_BREAK) == 17)

var v = [UInt8](repeating: 0, count: 4)
u_getUnicodeVersion(&v)
var t: [String: Any] = ["icuUnicodeVersion": v.map(String.init).joined(separator: ".")]
t["cfLetters"] = ranges(member(.letters))
t["cfNonBase"] = ranges(member(.nonBaseCharacters))
t["cfWhitespaces"] = ranges(member(.whitespaces))
t["cfWhitespacesAndNewlines"] = ranges(member(.whitespacesAndNewlines))
t["cfAlphanumerics"] = ranges(member(.alphanumerics))
t["icuGraphemeExtend"] = ranges { u_hasBinaryProperty(Int32($0), UCHAR_GRAPHEME_EXTEND) != 0 }
t["icuEmojiModifier"] = ranges { u_hasBinaryProperty(Int32($0), UCHAR_EMOJI_MODIFIER) != 0 }
t["icuExtendedPictographic"] = ranges { u_hasBinaryProperty(Int32($0), UCHAR_EXTENDED_PICTOGRAPHIC) != 0 }
var gcb: [String: [[UInt32]]] = [:]
for (name, value) in [("Control", 1), ("CR", 2), ("Extend", 3), ("L", 4), ("LF", 5), ("LV", 6), ("LVT", 7), ("T", 8), ("V", 9),
                      ("SpacingMark", 10), ("Prepend", 11), ("Regional_Indicator", 12), ("ZWJ", 17)] {
    gcb[name] = ranges { u_getIntPropertyValue(Int32($0), UCHAR_GRAPHEME_CLUSTER_BREAK) == Int32(value) }
}
t["icuGraphemeClusterBreak"] = gcb
// Swift's own grapheme data (the standard library's tables, not ICU's: no Apple private
// use characters), read off how String splits characters: the class of each scalar as
// _GraphemeBreakProperty has it, and InCB=Consonant (GB9c).
func count(_ s: String) -> Int { s.count }
var swiftClass = [String](repeating: "any", count: 0x110000)
var consonant = [Bool](repeating: false, count: 0x110000)
for v in 0...0x10FFFF {
    guard let sc = Unicode.Scalar(UInt32(v)) else { continue }
    let c = String(sc)
    let icu = u_getIntPropertyValue(Int32(v), UCHAR_GRAPHEME_CLUSTER_BREAK)
    var cls = "any"
    if v == 0x0D || v == 0x0A || count(c + "\u{301}") == 2 {
        cls = "control" // GB4: nothing else breaks before an Extend
    } else if count("a" + c) == 1 {
        if v == 0x200D { cls = "zwj" } else if count("😀" + c + "\u{200D}😀") == 1 { cls = "extend" } else { cls = "spacingMark" }
    } else if count(c + "a") == 1 {
        cls = "prepend"
    } else if let h = [4: "l", 9: "v", 8: "t", 6: "lv", 7: "lvt", 12: "regionalIndicator"][Int(icu)] {
        cls = h
    } else if count("😀\u{200D}" + c) == 1 {
        cls = "extendedPictographic"
    }
    swiftClass[v] = cls
    if cls == "any" && count("\u{915}\u{94D}" + c) == 1 { consonant[v] = true }
}
var swiftGCB: [String: [[UInt32]]] = [:]
for name in ["control", "extend", "zwj", "spacingMark", "prepend", "l", "v", "t", "lv", "lvt", "regionalIndicator", "extendedPictographic"] {
    swiftGCB[name] = ranges { swiftClass[Int($0)] == name }
}
t["swiftGraphemeBreak"] = swiftGCB
t["swiftInCBConsonant"] = ranges { consonant[Int($0)] }
t["swiftVirama"] = ranges(scalar { $0.canonicalCombiningClass.rawValue == 9 })
t["swiftWhiteSpace"] = ranges(scalar { $0.isWhitespace })
let d = try! JSONSerialization.data(withJSONObject: t, options: [.sortedKeys])
try! d.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
