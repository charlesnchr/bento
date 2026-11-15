import Foundation

/// What to do to a device's scroll events.
public struct ScrollRule: Equatable {
    public var reverseVertical: Bool
    public var reverseHorizontal: Bool
    /// Distance multiplier, clamped to `DeviceSettings.scrollSpeedRange`.
    public var speed: Double

    public static let identity = ScrollRule(reverseVertical: false, reverseHorizontal: false, speed: 1)

    public init(reverseVertical: Bool, reverseHorizontal: Bool, speed: Double) {
        self.reverseVertical = reverseVertical
        self.reverseHorizontal = reverseHorizontal
        let range = DeviceSettings.scrollSpeedRange
        self.speed = speed.isFinite ? min(max(speed, range.lowerBound), range.upperBound) : 1
    }

    /// True when events pass through unchanged.
    public var isIdentity: Bool { !reverseVertical && !reverseHorizontal && speed == 1 }
}

/// One axis of a scroll event: the three forms macOS carries a distance in.
public struct AxisDeltas: Equatable {
    /// Whole lines (`scrollWheelEventDeltaAxis`).
    public var lines: Int64
    /// Lines with a fraction (`scrollWheelEventFixedPtDeltaAxis`).
    public var fixed: Double
    /// Pixels (`scrollWheelEventPointDeltaAxis`).
    public var points: Int64

    public static let zero = AxisDeltas(lines: 0, fixed: 0, points: 0)

    public init(lines: Int64, fixed: Double, points: Int64) {
        self.lines = lines
        self.fixed = fixed
        self.points = points
    }
}

public struct ScrollValues: Equatable {
    public var vertical: AxisDeltas
    public var horizontal: AxisDeltas

    public init(vertical: AxisDeltas, horizontal: AxisDeltas = .zero) {
        self.vertical = vertical
        self.horizontal = horizontal
    }
}

/// Applies a rule to a stream of scroll events from one device.
///
/// The whole-number forms can't hold a scaled distance exactly, so what
/// rounding drops is carried into the next event of the same direction: at
/// half speed a wheel that sends one line per notch scrolls a line every
/// second notch, and the total over a gesture stays right.
public struct ScrollScaler {
    private var verticalLines = 0.0
    private var verticalPoints = 0.0
    private var horizontalLines = 0.0
    private var horizontalPoints = 0.0

    public init() {}

    public mutating func apply(_ rule: ScrollRule, to values: ScrollValues) -> ScrollValues {
        guard !rule.isIdentity else { return values }
        var out = values
        if rule.speed != 1 {
            out.vertical = ScrollScaler.scale(out.vertical, by: rule.speed, lines: &verticalLines, points: &verticalPoints)
            out.horizontal = ScrollScaler.scale(out.horizontal, by: rule.speed, lines: &horizontalLines, points: &horizontalPoints)
        }
        if rule.reverseVertical { out.vertical = ScrollScaler.negated(out.vertical) }
        if rule.reverseHorizontal { out.horizontal = ScrollScaler.negated(out.horizontal) }
        return out
    }

    private static func negated(_ a: AxisDeltas) -> AxisDeltas {
        // 0 - x rather than -x: a zero stays +0.0, which compares and prints as 0.
        AxisDeltas(lines: -a.lines, fixed: 0 - a.fixed, points: -a.points)
    }

    private static func scale(_ a: AxisDeltas, by factor: Double, lines: inout Double, points: inout Double) -> AxisDeltas {
        AxisDeltas(lines: scale(a.lines, by: factor, carry: &lines),
                   fixed: a.fixed * factor,
                   points: scale(a.points, by: factor, carry: &points))
    }

    /// Scales a whole number, rounding toward zero and carrying the rest.
    static func scale(_ value: Int64, by factor: Double, carry: inout Double) -> Int64 {
        guard value != 0 else { return 0 }
        // What was left over from scrolling the other way is dropped.
        if (carry < 0) != (value < 0) { carry = 0 }
        let exact = Double(value) * factor + carry
        let whole = exact.rounded(.towardZero)
        carry = exact - whole
        return Int64(whole)
    }
}

/// A connected pointing device: what it is, and the ids its events carry.
public struct ConnectedDevice: Identifiable, Equatable {
    public var identity: DeviceIdentity
    public var kind: PointingKind
    /// The registry ids of its HID services. A scroll event names the service
    /// that sent it; a device can have several (USB and Bluetooth at once).
    public var senderIDs: [UInt64]
    /// What the device mainly is, for sorting the list: a keyboard that also
    /// has a pointer interface comes after the mice and trackpads.
    public var isPrimarilyPointer: Bool
    /// The pointer speed the device has when Bento doesn't set one, from the
    /// resolution macOS holds for it. nil when that can't be read.
    public var ownPointerSpeed: Double?

    public var id: String { identity.key }

    public init(identity: DeviceIdentity, kind: PointingKind, senderIDs: [UInt64] = [], isPrimarilyPointer: Bool = true,
                ownPointerSpeed: Double? = nil) {
        self.identity = identity
        self.kind = kind
        self.senderIDs = senderIDs
        self.isPrimarilyPointer = isPrimarilyPointer
        self.ownPointerSpeed = ownPointerSpeed
    }
}

/// Which rule a scroll event gets.
public struct ScrollTable: Equatable {
    /// By the registry id of the HID service that sent the event.
    public var bySender: [UInt64: ScrollRule]
    /// For events that name no known sender, by what they look like: a wheel
    /// sends stepped events, a trackpad continuous ones.
    public var stepped: ScrollRule
    public var continuous: ScrollRule

    public static let identity = ScrollTable(bySender: [:], stepped: .identity, continuous: .identity)

    public init(bySender: [UInt64: ScrollRule], stepped: ScrollRule, continuous: ScrollRule) {
        self.bySender = bySender
        self.stepped = stepped
        self.continuous = continuous
    }

    public init(settings: MouseSettings, devices: [ConnectedDevice]) {
        var bySender: [UInt64: ScrollRule] = [:]
        var byKind: [PointingKind: [ScrollRule]] = [:]
        for device in devices {
            let rule = settings.settings(for: device.identity, kind: device.kind).scrollRule
            for id in device.senderIDs { bySender[id] = rule }
            byKind[device.kind, default: []].append(rule)
        }
        // Without a sender, the connected devices of that kind decide when
        // they all agree; otherwise the kind's defaults do.
        func fallback(_ kind: PointingKind) -> ScrollRule {
            if let rules = byKind[kind], let first = rules.first, rules.allSatisfy({ $0 == first }) { return first }
            return settings.defaults[kind].scrollRule
        }
        self.init(bySender: bySender, stepped: fallback(.mouse), continuous: fallback(.trackpad))
    }

    public func rule(sender: UInt64?, continuous isContinuous: Bool) -> ScrollRule {
        if let sender, let rule = bySender[sender] { return rule }
        return isContinuous ? continuous : stepped
    }

    /// True when no event can change, so no event tap is needed.
    public var isIdentity: Bool {
        stepped.isIdentity && continuous.isIdentity && bySender.values.allSatisfy(\.isIdentity)
    }
}
