import Foundation

/// Whether a pointing device is a mouse or a trackpad. Devices without their
/// own entry take the defaults of their kind.
public enum PointingKind: String, Codable, CaseIterable, Hashable {
    case mouse
    case trackpad

    /// A trackpad says so in its HID usages (a digitizer touch pad); the name
    /// covers the ones that don't.
    public static func detect(isTouchPad: Bool, name: String) -> PointingKind {
        isTouchPad || name.range(of: "trackpad", options: .caseInsensitive) != nil ? .trackpad : .mouse
    }
}

/// What Bento changes about one device. The defaults change nothing.
public struct DeviceSettings: Codable, Equatable {
    /// Scroll the opposite way to the macOS "Natural scrolling" setting.
    public var reverseScrollVertical = false
    public var reverseScrollHorizontal = false
    /// Multiplies every scroll distance. 1 leaves scrolling alone.
    public var scrollSpeed: Double = 1
    /// Base pointer speed, 0 (slowest) to 1 (fastest). nil leaves it to macOS.
    public var pointerSpeed: Double?
    /// Pointer acceleration, 0 to 40 (the macOS tracking speed slider covers
    /// 0 to 3). nil leaves it to macOS.
    public var pointerAcceleration: Double?
    /// Turns pointer acceleration off: the pointer moves by the device's raw
    /// counts, and `pointerSpeed` and `pointerAcceleration` have no effect.
    public var disablePointerAcceleration = false

    public init() {}

    public static let scrollSpeedRange = 0.05...20.0
    public static let pointerSpeedRange = 0.0...1.0
    public static let pointerAccelerationRange = 0.0...40.0

    enum CodingKeys: String, CodingKey, CaseIterable {
        case reverseScrollVertical, reverseScrollHorizontal, scrollSpeed
        case pointerSpeed, pointerAcceleration, disablePointerAcceleration
    }

    // Tolerant decoding: the file is hand-editable, so a missing or mistyped
    // key takes its default instead of invalidating the section.
    public init(from decoder: Decoder) throws {
        let d = DeviceSettings()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reverseScrollVertical = (try? c.decode(Bool.self, forKey: .reverseScrollVertical)) ?? d.reverseScrollVertical
        reverseScrollHorizontal = (try? c.decode(Bool.self, forKey: .reverseScrollHorizontal)) ?? d.reverseScrollHorizontal
        scrollSpeed = (try? c.decode(Double.self, forKey: .scrollSpeed)) ?? d.scrollSpeed
        pointerSpeed = try? c.decode(Double.self, forKey: .pointerSpeed)
        pointerAcceleration = try? c.decode(Double.self, forKey: .pointerAcceleration)
        disablePointerAcceleration = (try? c.decode(Bool.self, forKey: .disablePointerAcceleration)) ?? d.disablePointerAcceleration
    }

    // The optional values are written as null, so the file lists every option.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(reverseScrollVertical, forKey: .reverseScrollVertical)
        try c.encode(reverseScrollHorizontal, forKey: .reverseScrollHorizontal)
        try c.encode(scrollSpeed, forKey: .scrollSpeed)
        try c.encode(pointerSpeed, forKey: .pointerSpeed)
        try c.encode(pointerAcceleration, forKey: .pointerAcceleration)
        try c.encode(disablePointerAcceleration, forKey: .disablePointerAcceleration)
    }

    public var scrollRule: ScrollRule {
        ScrollRule(reverseVertical: reverseScrollVertical, reverseHorizontal: reverseScrollHorizontal, speed: scrollSpeed)
    }

    public var pointerRule: PointerRule {
        PointerRule(speed: pointerSpeed, acceleration: pointerAcceleration, disableAcceleration: disablePointerAcceleration)
    }
}

/// How a connected device identifies itself.
public struct DeviceIdentity: Hashable {
    public var vendorID: Int
    public var productID: Int
    public var name: String
    public var serialNumber: String?

    public init(vendorID: Int, productID: Int, name: String, serialNumber: String? = nil) {
        self.vendorID = vendorID
        self.productID = productID
        self.name = name
        self.serialNumber = serialNumber
    }

    /// Whether the device reports usable ids. The built-in trackpad of an
    /// Apple silicon Mac reports 0 for both, so it is known by its name.
    public var hasIDs: Bool { vendorID != 0 || productID != 0 }

    /// One string per identity, for lists and saved state.
    public var key: String { "\(vendorID):\(productID):\(serialNumber ?? ""):\(name)" }
}

/// A device's own settings, in the `devices` list of the `mouse` section.
///
/// An entry with a `vendorID` or `productID` (other than 0) matches devices
/// with those ids, whatever they are called, so `name` is then only a label.
/// Without ids it matches by `name` (ignoring case). A `serialNumber` narrows
/// either to one unit. Of several matching entries, the one with a serial
/// number wins, then the one with ids, then the first.
public struct DeviceEntry: Codable, Equatable {
    public var name: String?
    public var vendorID: Int?
    public var productID: Int?
    public var serialNumber: String?
    /// Which controls and icon the entry gets while its device is away.
    public var kind: PointingKind = .mouse
    public var settings = DeviceSettings()

    public init(name: String? = nil, vendorID: Int? = nil, productID: Int? = nil, serialNumber: String? = nil,
                kind: PointingKind = .mouse, settings: DeviceSettings = DeviceSettings()) {
        self.name = name
        self.vendorID = vendorID
        self.productID = productID
        self.serialNumber = serialNumber
        self.kind = kind
        self.settings = settings
    }

    /// The entry a device gets when its settings are first changed: its ids
    /// (or its name, without ids) and its serial number when it reports one,
    /// so another unit of the same model keeps its own values. Taking the
    /// `serialNumber` out of the file makes the entry cover every unit, and
    /// every connection of one that reports different serial numbers over USB
    /// and Bluetooth.
    public init(device: DeviceIdentity, kind: PointingKind, settings: DeviceSettings) {
        self.init(name: device.name, vendorID: device.hasIDs ? device.vendorID : nil,
                  productID: device.hasIDs ? device.productID : nil,
                  serialNumber: device.serialNumber, kind: kind, settings: settings)
    }

    enum CodingKeys: String, CodingKey {
        case name, vendorID, productID, serialNumber, kind
    }

    // The settings sit beside the identity in the same JSON object.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = DeviceEntry.text(try? c.decode(String.self, forKey: .name))
        vendorID = DeviceEntry.id(c, .vendorID)
        productID = DeviceEntry.id(c, .productID)
        serialNumber = DeviceEntry.text(try? c.decode(String.self, forKey: .serialNumber))
        kind = (try? c.decode(PointingKind.self, forKey: .kind)) ?? .mouse
        settings = try DeviceSettings(from: decoder)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(vendorID, forKey: .vendorID)
        try c.encodeIfPresent(productID, forKey: .productID)
        try c.encodeIfPresent(serialNumber, forKey: .serialNumber)
        try c.encode(kind, forKey: .kind)
        try settings.encode(to: encoder)
    }

    private static func text(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return nil }
        return t
    }

    /// An id as a number, or as a hex string the way `ioreg` and USB lists
    /// print it (`"0x1532"`).
    private static func id(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Int? {
        if let n = try? c.decode(Int.self, forKey: key) { return n }
        guard let s = try? c.decode(String.self, forKey: key) else { return nil }
        let t = s.trimmingCharacters(in: .whitespaces).lowercased()
        return t.hasPrefix("0x") ? Int(t.dropFirst(2), radix: 16) : Int(t)
    }

    private var hasIDs: Bool { (vendorID ?? 0) != 0 || (productID ?? 0) != 0 }

    /// How specifically the entry matches a device: nil when it doesn't.
    public func matchScore(_ device: DeviceIdentity) -> Int? {
        var score = 0
        if hasIDs {
            if let vendorID, vendorID != device.vendorID { return nil }
            if let productID, productID != device.productID { return nil }
            score += 2
        } else if let name {
            guard name.caseInsensitiveCompare(device.name.trimmingCharacters(in: .whitespaces)) == .orderedSame else { return nil }
            score += 1
        }
        if let serialNumber {
            guard serialNumber == device.serialNumber else { return nil }
            score += 4
        }
        return score > 0 ? score : nil
    }

    public func matches(_ device: DeviceIdentity) -> Bool { matchScore(device) != nil }
}

/// The settings of devices that have no entry, by kind.
public struct KindDefaults: Codable, Equatable {
    public var mouse = DeviceSettings()
    public var trackpad = DeviceSettings()

    public init() {}

    enum CodingKeys: String, CodingKey { case mouse, trackpad }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mouse = (try? c.decode(DeviceSettings.self, forKey: .mouse)) ?? DeviceSettings()
        trackpad = (try? c.decode(DeviceSettings.self, forKey: .trackpad)) ?? DeviceSettings()
    }

    public subscript(kind: PointingKind) -> DeviceSettings {
        get { kind == .mouse ? mouse : trackpad }
        set { if kind == .mouse { mouse = newValue } else { trackpad = newValue } }
    }
}

/// The `mouse` section of the config file.
public struct MouseSettings: Codable, Equatable {
    /// Settings for mice and trackpads that have no entry in `devices`.
    public var defaults = KindDefaults()
    /// Per-device settings. An entry holds every value itself: a key it
    /// leaves out takes the built-in default, not the default of its kind.
    public var devices: [DeviceEntry] = []

    public init() {}

    enum CodingKeys: String, CodingKey { case defaults, devices }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        defaults = (try? c.decode(KindDefaults.self, forKey: .defaults)) ?? KindDefaults()
        // One entry that is not an object must not cost the others.
        devices = ((try? c.decode([Lenient<DeviceEntry>].self, forKey: .devices)) ?? []).compactMap(\.value)
    }

    /// The index of the entry that applies to a device.
    public func entryIndex(for device: DeviceIdentity) -> Int? {
        var best: (index: Int, score: Int)?
        for (i, entry) in devices.enumerated() {
            guard let score = entry.matchScore(device) else { continue }
            if best == nil || score > best!.score { best = (i, score) }
        }
        return best?.index
    }

    /// The settings in force for a device: its entry's, or its kind's defaults.
    public func settings(for device: DeviceIdentity, kind: PointingKind) -> DeviceSettings {
        entryIndex(for: device).map { devices[$0].settings } ?? defaults[kind]
    }

    /// Changes a device's settings: those of the entry that applies to it,
    /// or of a new entry for it alone. An entry that applies to it and to
    /// other devices (one without a serial number, or naming only a vendor)
    /// is changed for all of them: that is what such an entry is for.
    public mutating func setSettings(_ settings: DeviceSettings, for device: DeviceIdentity, kind: PointingKind) {
        if let i = entryIndex(for: device) {
            devices[i].settings = settings
        } else {
            devices.append(DeviceEntry(device: device, kind: kind, settings: settings))
        }
    }

    /// Removes the entry that applies to a device, and only that one: a less
    /// specific entry that also matches it then applies, else its kind's defaults.
    public mutating func removeEntry(for device: DeviceIdentity) {
        if let i = entryIndex(for: device) { devices.remove(at: i) }
    }

    /// Whether the entry that applies to a device is for that unit alone
    /// (named by serial number, or the device reports none to tell units by).
    public func entryIsOwn(for device: DeviceIdentity) -> Bool {
        guard let i = entryIndex(for: device) else { return false }
        return devices[i].serialNumber != nil || device.serialNumber == nil
    }
}

/// Decodes to nil instead of failing, so one bad array element is skipped.
struct Lenient<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}
