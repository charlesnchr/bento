import Foundation

/// What to do to a device's pointer movement.
public struct PointerRule: Equatable {
    public var speed: Double?
    public var acceleration: Double?
    public var disableAcceleration: Bool

    public static let system = PointerRule(speed: nil, acceleration: nil, disableAcceleration: false)

    public init(speed: Double?, acceleration: Double?, disableAcceleration: Bool) {
        self.speed = speed
        self.acceleration = acceleration
        self.disableAcceleration = disableAcceleration
    }
}

/// The HID values behind a `PointerRule`. macOS keeps both as 16.16 fixed
/// point numbers on each pointing service:
///
/// - `HIDPointerAcceleration`: the tracking speed of System Settings (0 to 3
///   there). A negative value turns acceleration off.
/// - `HIDPointerResolution`: the counts per inch macOS assumes the device has,
///   400 by default. A lower figure makes each count move the pointer further.
public enum PointerMath {
    public static let accelerationKey = "HIDPointerAcceleration"
    public static let resolutionKey = "HIDPointerResolution"
    public static let accelerationTypeKey = "HIDPointerAccelerationType"

    /// Speed 0 assumes 2000 counts per inch, speed 1 assumes 100.
    static let slowestResolution = 2000.0
    static let fastestResolution = 100.0
    /// What macOS uses when it has no tracking speed stored.
    public static let systemDefaultAcceleration = 0.6875
    public static let defaultResolution = fixed(400)
    /// The speed that equals the default 400 counts per inch.
    public static let defaultSpeed = speed(forResolution: defaultResolution)

    public static func fixed(_ value: Double) -> Int { Int((value * 65536).rounded()) }

    public static func value(fromFixed fixed: Int) -> Double { Double(fixed) / 65536 }

    /// The acceleration to set, or nil to leave it to macOS.
    public static func acceleration(for rule: PointerRule) -> Int? {
        if rule.disableAcceleration { return fixed(-1) }
        guard let a = rule.acceleration, a.isFinite else { return nil }
        let range = DeviceSettings.pointerAccelerationRange
        return fixed(min(max(a, range.lowerBound), range.upperBound))
    }

    /// The resolution to set, or nil to leave the device's own. With
    /// acceleration off macOS doesn't use it, so it is left alone then too.
    public static func resolution(for rule: PointerRule) -> Int? {
        guard !rule.disableAcceleration, let s = rule.speed, s.isFinite else { return nil }
        let range = DeviceSettings.pointerSpeedRange
        let clamped = min(max(s, range.lowerBound), range.upperBound)
        return fixed(slowestResolution - clamped * (slowestResolution - fastestResolution))
    }

    /// The speed that gives a resolution, clamped: a device that reports more
    /// than 2000 or fewer than 100 counts per inch is outside what a speed can
    /// express, so switching pointer speed on changes how such a device feels.
    public static func speed(forResolution fixed: Int) -> Double {
        let s = (slowestResolution - value(fromFixed: fixed)) / (slowestResolution - fastestResolution)
        return min(max(s, 0), 1)
    }
}
