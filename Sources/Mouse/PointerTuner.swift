import Foundation
import BentoCore

/// What Bento changed on which device, kept on disk so the values can be put
/// back after a crash too: macOS has no way to unset a service property, and
/// a changed one stays until the device reconnects.
struct PointerLedger: Codable, Equatable {
    /// The resolution each device had before Bento set one, by identity key.
    var resolution: [String: Int] = [:]
    /// The devices whose acceleration Bento set.
    var acceleration: Set<String> = []

    var isEmpty: Bool { resolution.isEmpty && acceleration.isEmpty }
}

/// What to write to one service to put a rule in force.
struct PointerPlan: Equatable {
    var acceleration: Int?
    var resolution: Int?
}

/// Sets pointer speed and acceleration per device through the properties of
/// its HID services, and restores them when a rule no longer asks for them.
final class PointerTuner {
    private let ledgerURL: URL
    private(set) var ledger: PointerLedger
    /// Writes macOS refused in the last pass, for diagnostics and the pane.
    private(set) var failures: [String] = []

    init(ledgerURL: URL = AppPaths.support("mouse").appendingPathComponent("pointer-state.json")) {
        self.ledgerURL = ledgerURL
        ledger = (try? Data(contentsOf: ledgerURL)).flatMap { try? JSONDecoder().decode(PointerLedger.self, from: $0) } ?? PointerLedger()
    }

    /// The values a service should end up with, and the ledger afterwards.
    /// nil in the plan means "leave as it is".
    static func plan(rule: PointerRule, key: String, currentResolution: Int?, systemAcceleration: Int,
                     ledger: inout PointerLedger) -> PointerPlan {
        var plan = PointerPlan()
        if let wanted = PointerMath.acceleration(for: rule) {
            plan.acceleration = wanted
            ledger.acceleration.insert(key)
        } else if ledger.acceleration.remove(key) != nil {
            plan.acceleration = systemAcceleration
        }
        if let wanted = PointerMath.resolution(for: rule) {
            if ledger.resolution[key] == nil { ledger.resolution[key] = currentResolution ?? PointerMath.defaultResolution }
            plan.resolution = wanted
        } else if let original = ledger.resolution.removeValue(forKey: key) {
            plan.resolution = original
        }
        return plan
    }

    /// Puts each service's rule in force. `rule` returns `.system` for a
    /// device Bento should leave alone (or all of them, when the module stops).
    func apply(to services: [PointingService], system: HIDSystem, rule: (PointingService) -> PointerRule) {
        failures = []
        let before = ledger
        // Services of one device share a ledger entry: plan per device once,
        // so the second service doesn't read the first one's new value as the original.
        var plans: [String: PointerPlan] = [:]
        for s in services {
            let key = s.identity.key
            if plans[key] == nil {
                plans[key] = PointerTuner.plan(rule: rule(s), key: key, currentResolution: s.number(PointerMath.resolutionKey),
                                               systemAcceleration: systemAcceleration(for: s, system: system), ledger: &ledger)
            }
            guard let plan = plans[key] else { continue }
            if let a = plan.acceleration, s.number(PointerMath.accelerationKey) != a, !s.set(PointerMath.accelerationKey, a) {
                failures.append("\(s.identity.name): acceleration")
            }
            if let r = plan.resolution, s.number(PointerMath.resolutionKey) != r, !s.set(PointerMath.resolutionKey, r) {
                failures.append("\(s.identity.name): speed")
            }
        }
        if !failures.isEmpty {
            mouseLog.error("Pointer settings refused: \(self.failures.joined(separator: ", "), privacy: .public)")
        }
        if ledger != before { save() }
    }

    /// The tracking speed macOS would give the service: the system-wide value
    /// for its type (mouse or trackpad), as System Settings last set it.
    private func systemAcceleration(for s: PointingService, system: HIDSystem) -> Int {
        let typeKey = s.string(PointerMath.accelerationTypeKey)
            ?? (s.kind == .trackpad ? "HIDTrackpadAcceleration" : "HIDMouseAcceleration")
        if let live = system.number(typeKey) { return live }
        let pref = typeKey == "HIDTrackpadAcceleration" ? "com.apple.trackpad.scaling" : "com.apple.mouse.scaling"
        if let stored = CFPreferencesCopyValue(pref as CFString, kCFPreferencesAnyApplication, kCFPreferencesCurrentUser,
                                               kCFPreferencesAnyHost) as? NSNumber {
            return PointerMath.fixed(stored.doubleValue)
        }
        return PointerMath.fixed(PointerMath.systemDefaultAcceleration)
    }

    private func save() {
        if ledger.isEmpty {
            try? FileManager.default.removeItem(at: ledgerURL)
        } else if let data = try? JSONEncoder().encode(ledger) {
            try? data.write(to: ledgerURL, options: .atomic)
        }
    }
}
