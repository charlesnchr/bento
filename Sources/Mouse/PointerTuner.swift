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

/// What to write to the services of one device to put a rule in force.
/// nil means "leave as it is".
struct PointerPlan: Equatable {
    var acceleration: Int?
    var resolution: Int?
    /// The write puts macOS's value back, so the ledger entry can go once it succeeds.
    var restoresAcceleration = false
    var restoresResolution = false
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

    /// The values a device's services should end up with. What is about to be
    /// changed is recorded in the ledger here, before anything is written;
    /// what is being restored stays recorded until `settle` hears it worked.
    static func plan(rule: PointerRule, key: String, currentResolution: Int?, systemAcceleration: Int,
                     ledger: inout PointerLedger) -> PointerPlan {
        var plan = PointerPlan()
        if let wanted = PointerMath.acceleration(for: rule) {
            plan.acceleration = wanted
            ledger.acceleration.insert(key)
        } else if ledger.acceleration.contains(key) {
            plan.acceleration = systemAcceleration
            plan.restoresAcceleration = true
        }
        if let wanted = PointerMath.resolution(for: rule) {
            if ledger.resolution[key] == nil { ledger.resolution[key] = currentResolution ?? PointerMath.defaultResolution }
            plan.resolution = wanted
        } else if let original = ledger.resolution[key] {
            plan.resolution = original
            plan.restoresResolution = true
        }
        return plan
    }

    /// Forgets what a plan restored, but only the parts every service took:
    /// a refused restore stays in the ledger and is tried again next time.
    static func settle(_ plan: PointerPlan, key: String, accelerationWritten: Bool, resolutionWritten: Bool,
                       ledger: inout PointerLedger) {
        if plan.restoresAcceleration, accelerationWritten { ledger.acceleration.remove(key) }
        if plan.restoresResolution, resolutionWritten { ledger.resolution.removeValue(forKey: key) }
    }

    /// Puts each service's rule in force. `rule` returns `.system` for a
    /// device Bento should leave alone (or all of them, when the module stops).
    func apply(to services: [PointingService], system: HIDSystem, rule: (PointingService) -> PointerRule) {
        failures = []
        var saved = ledger
        // Services of one device share a ledger entry: plan per device once,
        // so the second service doesn't read the first one's new value as the original.
        var plans: [String: PointerPlan] = [:]
        for s in services where plans[s.identity.key] == nil {
            let key = s.identity.key
            plans[key] = PointerTuner.plan(rule: rule(s), key: key, currentResolution: s.number(PointerMath.resolutionKey),
                                           systemAcceleration: systemAcceleration(for: s, system: system), ledger: &ledger)
        }
        // On disk before the first write, so a crash in between still leaves a record.
        if ledger != saved {
            save()
            saved = ledger
        }
        var accelerationFailed: Set<String> = []
        var resolutionFailed: Set<String> = []
        for s in services {
            let key = s.identity.key
            guard let plan = plans[key] else { continue }
            if let a = plan.acceleration, s.number(PointerMath.accelerationKey) != a, !s.set(PointerMath.accelerationKey, a) {
                accelerationFailed.insert(key)
                failures.append("\(s.identity.name): acceleration")
            }
            if let r = plan.resolution, s.number(PointerMath.resolutionKey) != r, !s.set(PointerMath.resolutionKey, r) {
                resolutionFailed.insert(key)
                failures.append("\(s.identity.name): speed")
            }
        }
        for (key, plan) in plans {
            PointerTuner.settle(plan, key: key, accelerationWritten: !accelerationFailed.contains(key),
                                resolutionWritten: !resolutionFailed.contains(key), ledger: &ledger)
        }
        if !failures.isEmpty {
            mouseLog.error("Pointer settings refused: \(self.failures.joined(separator: ", "), privacy: .public)")
        }
        if ledger != saved { save() }
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
