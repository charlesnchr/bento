import Foundation

/// Any JSON value, so a free-form object (the synced dictation settings) can
/// go through Bento's Codable config sections unchanged.
public enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// A JSONSerialization-style value (dictionaries, arrays, strings, NSNumber,
    /// NSNull); nil for anything else.
    public init?(_ value: Any?) {
        switch value {
        case nil, is NSNull: self = .null
        case let s as String: self = .string(s)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) }
            else if CFNumberIsFloatType(n) {
                let d = n.doubleValue
                guard d.isFinite else { return nil }
                self = .double(d)
            } else { self = .int(n.intValue) }
        case let a as [Any]:
            var out: [JSONValue] = []
            for item in a {
                guard let v = JSONValue(item) else { return nil }
                out.append(v)
            }
            self = .array(out)
        case let d as [String: Any]:
            var out: [String: JSONValue] = [:]
            for (k, item) in d {
                guard let v = JSONValue(item) else { return nil }
                out[k] = v
            }
            self = .object(out)
        default: return nil
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let i = try? c.decode(Int.self) { self = .int(i) }
        else if let d = try? c.decode(Double.self) { self = .double(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}
