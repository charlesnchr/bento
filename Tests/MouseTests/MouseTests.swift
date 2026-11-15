import CoreGraphics
import Foundation
import Testing
@testable import Mouse

private func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private func object<T: Encodable>(_ value: T) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
}

private let razer = DeviceIdentity(vendorID: 0x1532, productID: 0xB2, name: "Razer DeathAdder V3")
private let builtIn = DeviceIdentity(vendorID: 0, productID: 0, name: "Apple Internal Keyboard / Trackpad")
private let magicTrackpad = DeviceIdentity(vendorID: 1452, productID: 613, name: "Magic Trackpad", serialNumber: "CC21")

private func reversed(_ speed: Double = 1) -> DeviceSettings {
    var s = DeviceSettings()
    s.reverseScrollVertical = true
    s.scrollSpeed = speed
    return s
}

// MARK: - Config model

@Test func defaultsChangeNothing() {
    let s = DeviceSettings()
    #expect(s.scrollRule.isIdentity)
    #expect(s.pointerRule == .system)
    #expect(PointerMath.acceleration(for: s.pointerRule) == nil)
    #expect(PointerMath.resolution(for: s.pointerRule) == nil)
    #expect(ScrollTable(settings: MouseSettings(), devices: [ConnectedDevice(identity: razer, kind: .mouse, senderIDs: [7])]).isIdentity)
}

@Test func emptySectionDecodesToDefaults() throws {
    #expect(try decode("{}", as: MouseSettings.self) == MouseSettings())
}

@Test func settingsListEveryOptionWithNullForUnset() throws {
    let o = try object(DeviceSettings())
    #expect(Set(o.keys) == Set(DeviceSettings.CodingKeys.allCases.map(\.rawValue)))
    #expect(o["pointerSpeed"] is NSNull)
    #expect(o["pointerAcceleration"] is NSNull)
    let section = try object(MouseSettings())
    #expect(Set(section.keys) == ["defaults", "devices"])
    #expect(Set((section["defaults"] as? [String: Any] ?? [:]).keys) == ["mouse", "trackpad"])
}

@Test func settingsRoundTrip() throws {
    var m = MouseSettings()
    m.defaults.mouse = reversed(1.5)
    m.defaults.trackpad.pointerSpeed = 0.4
    var own = DeviceSettings()
    own.disablePointerAcceleration = true
    own.pointerAcceleration = 2.5
    m.setSettings(own, for: razer, kind: .mouse)
    m.setSettings(reversed(), for: builtIn, kind: .trackpad)
    let back = try JSONDecoder().decode(MouseSettings.self, from: JSONEncoder().encode(m))
    #expect(back == m)
}

@Test func mistypedValuesFallBackOneByOne() throws {
    let s: DeviceSettings = try decode("""
    {"reverseScrollVertical": "yes", "reverseScrollHorizontal": true, "scrollSpeed": "fast",
     "pointerSpeed": 0.3, "pointerAcceleration": "high", "disablePointerAcceleration": 1}
    """)
    #expect(s.reverseScrollVertical == false)
    #expect(s.reverseScrollHorizontal == true)
    #expect(s.scrollSpeed == 1)
    #expect(s.pointerSpeed == 0.3)
    #expect(s.pointerAcceleration == nil)
    #expect(s.disablePointerAcceleration == false)
}

@Test func aBadDeviceEntryDoesNotCostTheOthers() throws {
    let m: MouseSettings = try decode("""
    {"defaults": {"mouse": {"reverseScrollVertical": true}, "trackpad": 3},
     "devices": ["nonsense", {"name": "Razer DeathAdder V3", "vendorID": "0x1532", "productID": 178, "scrollSpeed": 2}, 4]}
    """)
    #expect(m.defaults.mouse.reverseScrollVertical)
    #expect(m.defaults.trackpad == DeviceSettings())
    #expect(m.devices.count == 1)
    #expect(m.devices[0].vendorID == 0x1532)
    #expect(m.devices[0].kind == .mouse)
    #expect(m.settings(for: razer, kind: .mouse).scrollSpeed == 2)
}

@Test func anEntryKeepsItsSettingsBesideItsIdentity() throws {
    let entry = DeviceEntry(device: razer, kind: .mouse, settings: reversed(2))
    let o = try object(entry)
    #expect(o["name"] as? String == "Razer DeathAdder V3")
    #expect(o["vendorID"] as? Int == 0x1532)
    #expect(o["productID"] as? Int == 0xB2)
    #expect(o["kind"] as? String == "mouse")
    #expect(o["reverseScrollVertical"] as? Bool == true)
    #expect(o["scrollSpeed"] as? Double == 2)
    #expect(o["serialNumber"] == nil)
}

// MARK: - Matching

@Test func idsMatchWhateverTheName() {
    let entry = DeviceEntry(name: "My mouse", vendorID: 0x1532, productID: 0xB2)
    #expect(entry.matches(razer))
    #expect(!entry.matches(DeviceIdentity(vendorID: 0x1532, productID: 0xB3, name: "My mouse")))
    // Only a vendor: every device of that vendor.
    #expect(DeviceEntry(vendorID: 0x1532).matches(razer))
    #expect(!DeviceEntry(vendorID: 0x046D).matches(razer))
}

@Test func devicesWithoutIDsMatchByName() {
    let entry = DeviceEntry(device: builtIn, kind: .trackpad, settings: DeviceSettings())
    #expect(entry.vendorID == nil && entry.productID == nil)
    #expect(entry.matches(builtIn))
    #expect(entry.matches(DeviceIdentity(vendorID: 0, productID: 0, name: "apple internal keyboard / trackpad")))
    #expect(!entry.matches(magicTrackpad))
    // Zero ids written by hand count as no ids.
    #expect(DeviceEntry(name: "Apple Internal Keyboard / Trackpad", vendorID: 0, productID: 0).matches(builtIn))
    // A name alone matches a device that does have ids.
    #expect(DeviceEntry(name: "Magic Trackpad").matches(magicTrackpad))
}

@Test func anEntryWithoutCriteriaMatchesNothing() {
    #expect(!DeviceEntry().matches(razer))
    #expect(!DeviceEntry(kind: .trackpad).matches(builtIn))
}

@Test func theMostSpecificEntryWins() {
    var m = MouseSettings()
    m.devices = [
        DeviceEntry(name: "Magic Trackpad", settings: reversed(1.1)),
        DeviceEntry(vendorID: 1452, productID: 613, settings: reversed(1.2)),
        DeviceEntry(vendorID: 1452, productID: 613, serialNumber: "CC21", settings: reversed(1.3)),
        DeviceEntry(vendorID: 1452, productID: 613, serialNumber: "OTHER", settings: reversed(1.4)),
    ]
    #expect(m.settings(for: magicTrackpad, kind: .trackpad).scrollSpeed == 1.3)
    var other = magicTrackpad
    other.serialNumber = nil
    #expect(m.settings(for: other, kind: .trackpad).scrollSpeed == 1.2)
    // Equally specific: the first.
    m.devices = [DeviceEntry(vendorID: 1452, settings: reversed(2)), DeviceEntry(productID: 613, settings: reversed(3))]
    #expect(m.settings(for: magicTrackpad, kind: .trackpad).scrollSpeed == 2)
}

@Test func devicesWithoutAnEntryTakeTheirKindsDefaults() {
    var m = MouseSettings()
    m.defaults.mouse = reversed()
    #expect(m.settings(for: razer, kind: .mouse).reverseScrollVertical)
    #expect(!m.settings(for: builtIn, kind: .trackpad).reverseScrollVertical)
}

@Test func editingADeviceAddsOneEntryAndRemovingRestoresDefaults() {
    var m = MouseSettings()
    m.defaults.mouse = reversed()
    m.setSettings(reversed(2), for: razer, kind: .mouse)
    m.setSettings(reversed(3), for: razer, kind: .mouse)
    #expect(m.devices.count == 1)
    #expect(m.devices[0].vendorID == 0x1532 && m.devices[0].name == "Razer DeathAdder V3")
    #expect(m.settings(for: razer, kind: .mouse).scrollSpeed == 3)
    m.removeEntries(for: razer)
    #expect(m.devices.isEmpty)
    #expect(m.settings(for: razer, kind: .mouse) == m.defaults.mouse)
}

@Test func kindComesFromTheUsageOrTheName() {
    #expect(PointingKind.detect(isTouchPad: true, name: "Anything") == .trackpad)
    #expect(PointingKind.detect(isTouchPad: false, name: "Magic Trackpad") == .trackpad)
    #expect(PointingKind.detect(isTouchPad: false, name: "Razer DeathAdder V3") == .mouse)
}

// MARK: - Scroll transform

private func wheel(_ lines: Int64) -> ScrollValues {
    ScrollValues(vertical: AxisDeltas(lines: lines, fixed: Double(lines), points: lines * 10))
}

@Test func identityRuleLeavesEventsAlone() {
    var scaler = ScrollScaler()
    let v = ScrollValues(vertical: AxisDeltas(lines: 3, fixed: 2.7, points: 31), horizontal: AxisDeltas(lines: -1, fixed: -0.5, points: -4))
    #expect(scaler.apply(.identity, to: v) == v)
}

@Test func reverseNegatesEveryFormOfOneAxis() {
    var scaler = ScrollScaler()
    let v = ScrollValues(vertical: AxisDeltas(lines: 3, fixed: 2.7, points: 31), horizontal: AxisDeltas(lines: -1, fixed: -0.5, points: -4))
    let vertical = scaler.apply(ScrollRule(reverseVertical: true, reverseHorizontal: false, speed: 1), to: v)
    #expect(vertical.vertical == AxisDeltas(lines: -3, fixed: -2.7, points: -31))
    #expect(vertical.horizontal == v.horizontal)
    let horizontal = scaler.apply(ScrollRule(reverseVertical: false, reverseHorizontal: true, speed: 1), to: v)
    #expect(horizontal.vertical == v.vertical)
    #expect(horizontal.horizontal == AxisDeltas(lines: 1, fixed: 0.5, points: 4))
}

@Test func reversingTwiceRestoresTheEvent() {
    var scaler = ScrollScaler()
    let rule = ScrollRule(reverseVertical: true, reverseHorizontal: true, speed: 1)
    let v = ScrollValues(vertical: AxisDeltas(lines: 0, fixed: 0, points: 0), horizontal: AxisDeltas(lines: 2, fixed: 1.5, points: 17))
    #expect(scaler.apply(rule, to: scaler.apply(rule, to: v)) == v)
}

@Test func speedScalesEveryForm() {
    var scaler = ScrollScaler()
    let out = scaler.apply(ScrollRule(reverseVertical: false, reverseHorizontal: false, speed: 2), to: wheel(3))
    #expect(out.vertical == AxisDeltas(lines: 6, fixed: 6, points: 60))
    #expect(out.horizontal == .zero)
}

@Test func halfSpeedCarriesWhatRoundingDrops() {
    var scaler = ScrollScaler()
    let rule = ScrollRule(reverseVertical: false, reverseHorizontal: false, speed: 0.5)
    let lines = (0..<6).map { _ in scaler.apply(rule, to: wheel(1)).vertical.lines }
    #expect(lines == [0, 1, 0, 1, 0, 1])
    // The fractional form is exact every time.
    #expect(scaler.apply(rule, to: wheel(1)).vertical.fixed == 0.5)
}

@Test func scaledTotalsStayWithinOneUnit() {
    for speed in [0.3, 0.75, 1.3, 2.4] {
        var scaler = ScrollScaler()
        let rule = ScrollRule(reverseVertical: false, reverseHorizontal: false, speed: speed)
        var total: Int64 = 0
        var input: Int64 = 0
        for delta: Int64 in [1, 3, 7, 2, 1, 1, 12, 5, 1, 4] {
            input += delta
            total += scaler.apply(rule, to: ScrollValues(vertical: AxisDeltas(lines: 0, fixed: 0, points: delta))).vertical.points
        }
        #expect(abs(Double(total) - Double(input) * speed) < 1)
    }
}

@Test func changingDirectionDropsTheCarry() {
    var scaler = ScrollScaler()
    let rule = ScrollRule(reverseVertical: false, reverseHorizontal: false, speed: 0.5)
    #expect(scaler.apply(rule, to: wheel(1)).vertical.lines == 0)   // half a line carried down
    #expect(scaler.apply(rule, to: wheel(-1)).vertical.lines == 0)  // not cancelled into the way up
    #expect(scaler.apply(rule, to: wheel(-1)).vertical.lines == -1)
}

@Test func speedAndReverseCombine() {
    var scaler = ScrollScaler()
    let out = scaler.apply(ScrollRule(reverseVertical: true, reverseHorizontal: false, speed: 1.5), to: wheel(2))
    #expect(out.vertical == AxisDeltas(lines: -3, fixed: -3, points: -30))
}

@Test func scrollSpeedIsClamped() {
    #expect(ScrollRule(reverseVertical: false, reverseHorizontal: false, speed: 0).speed == DeviceSettings.scrollSpeedRange.lowerBound)
    #expect(ScrollRule(reverseVertical: false, reverseHorizontal: false, speed: -3).speed == DeviceSettings.scrollSpeedRange.lowerBound)
    #expect(ScrollRule(reverseVertical: false, reverseHorizontal: false, speed: 1000).speed == DeviceSettings.scrollSpeedRange.upperBound)
    #expect(ScrollRule(reverseVertical: false, reverseHorizontal: false, speed: .nan).isIdentity)
}

// MARK: - Which rule an event gets

@Test func aMouseScrollsTraditionallyWhileTheTrackpadStaysNatural() {
    var m = MouseSettings()
    m.defaults.mouse = reversed()
    let table = ScrollTable(settings: m, devices: [
        ConnectedDevice(identity: razer, kind: .mouse, senderIDs: [10]),
        ConnectedDevice(identity: builtIn, kind: .trackpad, senderIDs: [20]),
    ])
    #expect(table.rule(sender: 10, continuous: false).reverseVertical)
    #expect(table.rule(sender: 20, continuous: true).isIdentity)
    // Without a sender, what the event looks like decides.
    #expect(table.rule(sender: nil, continuous: false).reverseVertical)
    #expect(table.rule(sender: nil, continuous: true).isIdentity)
    #expect(table.rule(sender: 99, continuous: true).isIdentity)
    #expect(!table.isIdentity)
}

@Test func eachDeviceGetsItsOwnRuleBySender() {
    var m = MouseSettings()
    m.setSettings(reversed(2), for: razer, kind: .mouse)
    let other = DeviceIdentity(vendorID: 0x046D, productID: 0xC08B, name: "G502")
    let table = ScrollTable(settings: m, devices: [
        ConnectedDevice(identity: razer, kind: .mouse, senderIDs: [10, 11]),
        ConnectedDevice(identity: other, kind: .mouse, senderIDs: [12]),
    ])
    #expect(table.rule(sender: 10, continuous: false).speed == 2)
    #expect(table.rule(sender: 11, continuous: false).speed == 2)
    #expect(table.rule(sender: 12, continuous: false).isIdentity)
    // The two mice disagree, so an event without a sender gets the mouse defaults.
    #expect(table.rule(sender: nil, continuous: false).isIdentity)
}

@Test func withoutASenderTheOnlyDeviceOfAKindDecides() {
    var m = MouseSettings()
    m.setSettings(reversed(), for: razer, kind: .mouse)
    let table = ScrollTable(settings: m, devices: [ConnectedDevice(identity: razer, kind: .mouse, senderIDs: [10])])
    #expect(table.rule(sender: nil, continuous: false).reverseVertical)
    #expect(table.rule(sender: nil, continuous: true).isIdentity)
}

@Test func noTapIsNeededUntilARuleChangesScrolling() {
    var m = MouseSettings()
    m.defaults.mouse.pointerSpeed = 0.5
    let devices = [ConnectedDevice(identity: razer, kind: .mouse, senderIDs: [10])]
    #expect(ScrollTable(settings: m, devices: devices).isIdentity)
    m.defaults.trackpad.scrollSpeed = 1.2
    #expect(!ScrollTable(settings: m, devices: devices).isIdentity)
}

// MARK: - Scroll events

@Test func scrollValuesSurviveBeingWrittenToAnEvent() throws {
    let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 12, wheel2: -5, wheel3: 0))
    let v = ScrollValues(vertical: AxisDeltas(lines: -3, fixed: -2.5, points: -27), horizontal: AxisDeltas(lines: 1, fixed: 0.75, points: 9))
    ScrollEventIO.write(v, to: event)
    #expect(ScrollEventIO.values(of: event) == v)
    #expect(ScrollEventIO.isContinuous(event))
}

@Test func aWheelEventIsReversedInEveryForm() throws {
    let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: 2, wheel2: 0, wheel3: 0))
    #expect(!ScrollEventIO.isContinuous(event))
    let before = ScrollEventIO.values(of: event)
    #expect(before.vertical.lines == 2)
    var scaler = ScrollScaler()
    let after = scaler.apply(ScrollRule(reverseVertical: true, reverseHorizontal: false, speed: 1), to: before)
    ScrollEventIO.write(after, to: event)
    let read = ScrollEventIO.values(of: event)
    #expect(read.vertical.lines == -2)
    #expect(read.vertical.fixed == -before.vertical.fixed)
    #expect(read.vertical.points == -before.vertical.points)
    #expect(!ScrollEventIO.isContinuous(event))
}

// MARK: - Pointer

@Test func pointerSpeedMapsToResolution() {
    func rule(_ speed: Double?) -> PointerRule { PointerRule(speed: speed, acceleration: nil, disableAcceleration: false) }
    #expect(PointerMath.resolution(for: rule(0)) == 2000 << 16)
    #expect(PointerMath.resolution(for: rule(1)) == 100 << 16)
    #expect(PointerMath.resolution(for: rule(0.5)) == 1050 << 16)
    #expect(PointerMath.resolution(for: rule(7)) == 100 << 16)
    #expect(PointerMath.resolution(for: rule(-1)) == 2000 << 16)
    #expect(PointerMath.resolution(for: rule(nil)) == nil)
    #expect(PointerMath.resolution(for: rule(.nan)) == nil)
    // The default 400 counts per inch sits at the default speed.
    #expect(PointerMath.resolution(for: rule(PointerMath.defaultSpeed)) == PointerMath.defaultResolution)
    #expect(PointerMath.speed(forResolution: 1050 << 16) == 0.5)
}

@Test func pointerAccelerationIsFixedPoint() {
    func rule(_ a: Double?, off: Bool = false) -> PointerRule { PointerRule(speed: 0.5, acceleration: a, disableAcceleration: off) }
    #expect(PointerMath.acceleration(for: rule(0.6875)) == 45056)
    #expect(PointerMath.acceleration(for: rule(100)) == 40 << 16)
    #expect(PointerMath.acceleration(for: rule(-2)) == 0)
    #expect(PointerMath.acceleration(for: rule(nil)) == nil)
    // Off: a negative acceleration, and the resolution is left alone.
    #expect(PointerMath.acceleration(for: rule(2, off: true)) == -65536)
    #expect(PointerMath.resolution(for: rule(2, off: true)) == nil)
}

@Test func thePlanRemembersWhatItChangedAndPutsItBack() {
    var ledger = PointerLedger()
    let key = razer.key
    let system = 45056
    // Nothing asked, nothing changed before: nothing to write.
    #expect(PointerTuner.plan(rule: .system, key: key, currentResolution: 400 << 16, systemAcceleration: system, ledger: &ledger) == PointerPlan())
    #expect(ledger.isEmpty)

    let fast = PointerRule(speed: 1, acceleration: 2, disableAcceleration: false)
    var plan = PointerTuner.plan(rule: fast, key: key, currentResolution: 400 << 16, systemAcceleration: system, ledger: &ledger)
    #expect(plan == PointerPlan(acceleration: 2 << 16, resolution: 100 << 16))
    #expect(ledger.resolution[key] == 400 << 16)
    #expect(ledger.acceleration == [key])

    // Applied again (a later launch reads Bento's own value back): the original is kept.
    plan = PointerTuner.plan(rule: fast, key: key, currentResolution: 100 << 16, systemAcceleration: system, ledger: &ledger)
    #expect(ledger.resolution[key] == 400 << 16)

    // Acceleration off: the resolution goes back, the acceleration goes negative.
    plan = PointerTuner.plan(rule: PointerRule(speed: 1, acceleration: 2, disableAcceleration: true), key: key,
                             currentResolution: 100 << 16, systemAcceleration: system, ledger: &ledger)
    #expect(plan == PointerPlan(acceleration: -65536, resolution: 400 << 16))
    #expect(ledger.resolution.isEmpty)

    // Back to macOS: the system's tracking speed, once.
    plan = PointerTuner.plan(rule: .system, key: key, currentResolution: 400 << 16, systemAcceleration: system, ledger: &ledger)
    #expect(plan == PointerPlan(acceleration: system, resolution: nil))
    #expect(ledger.isEmpty)
    plan = PointerTuner.plan(rule: .system, key: key, currentResolution: 400 << 16, systemAcceleration: system, ledger: &ledger)
    #expect(plan == PointerPlan())
}

@Test func theLedgerSurvivesARestart() throws {
    var ledger = PointerLedger()
    _ = PointerTuner.plan(rule: PointerRule(speed: 0.2, acceleration: nil, disableAcceleration: false), key: "a",
                          currentResolution: nil, systemAcceleration: 0, ledger: &ledger)
    #expect(ledger.resolution["a"] == PointerMath.defaultResolution)
    let back = try JSONDecoder().decode(PointerLedger.self, from: JSONEncoder().encode(ledger))
    #expect(back == ledger)
}
