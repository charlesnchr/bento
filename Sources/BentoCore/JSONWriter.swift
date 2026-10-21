import Foundation

/// Pretty JSON for the human-edited config: sorted keys, 2-space indent and
/// shortest round-trip numbers (JSONSerialization writes 0.9 as
/// 0.90000000000000002).
enum JSONWriter {
    static func data(_ value: Any) -> Data {
        var out = ""
        write(value, into: &out, indent: 0)
        out += "\n"
        return Data(out.utf8)
    }

    private static func write(_ value: Any, into out: inout String, indent: Int) {
        let pad = String(repeating: "  ", count: indent + 1)
        let closePad = String(repeating: "  ", count: indent)
        switch value {
        case let dict as [String: Any]:
            if dict.isEmpty { out += "{}"; return }
            out += "{\n"
            let keys = dict.keys.sorted()
            for (i, key) in keys.enumerated() {
                out += pad
                writeString(key, into: &out)
                out += ": "
                write(dict[key]!, into: &out, indent: indent + 1)
                out += i == keys.count - 1 ? "\n" : ",\n"
            }
            out += closePad + "}"
        case let array as [Any]:
            if array.isEmpty { out += "[]"; return }
            out += "[\n"
            for (i, item) in array.enumerated() {
                out += pad
                write(item, into: &out, indent: indent + 1)
                out += i == array.count - 1 ? "\n" : ",\n"
            }
            out += closePad + "]"
        case let s as String:
            writeString(s, into: &out)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                out += n.boolValue ? "true" : "false"
            } else if CFNumberIsFloatType(n) {
                let d = n.doubleValue
                if !d.isFinite { out += "null" }
                else if d == d.rounded(), abs(d) < 1e15 { out += String(Int64(d)) }
                else { out += "\(d)" }
            } else {
                out += n.stringValue
            }
        case is NSNull:
            out += "null"
        default:
            writeString(String(describing: value), into: &out)
        }
    }

    private static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) }
                else { out.unicodeScalars.append(scalar) }
            }
        }
        out += "\""
    }
}
