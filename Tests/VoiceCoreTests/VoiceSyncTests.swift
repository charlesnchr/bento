import BentoCore
import Foundation
import Testing
@testable import VoiceCore

/// The voice store in memory, as the sync engine sees it.
final class MemoryDocs: FieldDocRepository {
    var docs: [String: FieldDoc] = [:]
    func doc(_ id: String) -> FieldDoc? { docs[id] }
    func save(_ doc: FieldDoc, remote: Bool) { docs[doc.id] = doc }
    var allDocs: [FieldDoc] { Array(docs.values) }
    var dirty: [FieldDoc] { docs.values.filter(\.dirty) }
}

/// bento-sync's last-writer-wins rule (server/src/store.rs) in memory; what travels is the wire form.
final class FakeVoiceServer {
    var docs: [String: FieldDoc] = [:]
    var seq: Int64 = 0
    let wire = FieldDocWire(collection: VoiceDocs.collection)

    func put(_ d: FieldDoc, device: String) -> (FieldDoc, Bool) {
        if let s = docs[d.id], d.updatedAt < s.updatedAt { return (s, false) }
        seq += 1
        var obj = wire.encode(d, device: device)
        obj["seq"] = seq
        if let s = docs[d.id] { obj["created_at"] = s.createdAt }
        let stored = wire.decode(obj)!
        docs[d.id] = stored
        return (stored, true)
    }
}

/// One Mac: its dictionary and settings (a private defaults suite), voice store, engine and bridge.
final class VoiceDevice {
    let name: String
    let suite: PrivateDefaults
    let repo = MemoryDocs()
    let engine: FieldSyncEngine
    let bridge: VoiceSyncBridge

    init(_ name: String) {
        self.name = name
        suite = PrivateDefaults("voice-sync-\(name)")
        engine = FieldSyncEngine(repo: repo)
        engine.device = name
        bridge = VoiceSyncBridge(repo: repo, defaults: suite.defaults)
    }

    var defaults: UserDefaults { suite.defaults }

    var entries: [DictionaryEntry] {
        defaults.data(forKey: "dictionaryEntries").flatMap { try? JSONDecoder().decode([DictionaryEntry].self, from: $0) } ?? []
    }

    func setEntries(_ entries: [DictionaryEntry]) {
        defaults.set(try! JSONEncoder().encode(entries), forKey: "dictionaryEntries")
    }

    func edit(_ id: UUID, _ change: (inout DictionaryEntry) -> Void) {
        var all = entries
        if let i = all.firstIndex(where: { $0.id == id }) { change(&all[i]) }
        setEntries(all)
    }

    /// Terms with their star and misspelling, sorted: what the dictionary shows.
    var shown: [String] {
        entries.map { "\($0.term)\($0.starred ? "*" : "")\($0.misspelling.map { "<\($0)" } ?? "")" }.sorted()
    }

    /// Connects: the hello snapshot, then what arrived is applied locally.
    func connect(_ server: FakeVoiceServer) {
        bridge.reconcile()
        engine.applySnapshot(Array(server.docs.values), ids: Set(server.docs.keys))
        bridge.reconcile()
    }
}

/// Reconciles and sends until nothing is left: accepted versions reach every other
/// device, a refused put gets the stored winner back, as over the WebSocket.
private func settle(_ devices: [VoiceDevice], _ server: FakeVoiceServer) {
    for _ in 0..<20 {
        var sent = false
        for device in devices {
            device.bridge.reconcile()
            for d in device.engine.docsToSend() {
                sent = true
                device.engine.markSent(d)
                let (stored, accepted) = server.put(d, device: device.name)
                device.engine.ack(id: d.id, seq: accepted ? stored.seq : nil, accepted: accepted, version: d.updatedAt)
                if !accepted { device.engine.applyRemote(stored) }
                for other in devices where other !== device && accepted { other.engine.applyRemote(stored) }
            }
        }
        for device in devices { device.bridge.reconcile() }
        if !sent { return }
    }
    Issue.record("devices never settled")
}

private func entry(_ term: String, misspelling: String? = nil, starred: Bool = false, at seconds: Double, id: UUID = UUID()) -> DictionaryEntry {
    var e = DictionaryEntry(term: term, misspelling: misspelling, starred: starred)
    e.id = id
    e.createdAt = Date(timeIntervalSince1970: seconds)
    return e
}

private func entryDoc(_ id: String, term: String, starred: Bool = false, misspelling: String? = nil, createdAt: Int64) -> FieldDoc {
    var d = FieldDoc(id: id, type: "entry", createdAt: createdAt, updatedAt: createdAt)
    d.set("term", .string(term), at: createdAt)
    d.set("misspelling", misspelling.map(SyncValue.string) ?? .null, at: createdAt)
    d.set("starred", .bool(starred), at: createdAt)
    d.set("created_at", .number(Double(createdAt)), at: createdAt)
    return d
}

// MARK: - Mapping

@Suite struct VoiceDocsTests {
    @Test func entryRoundTripsThroughItsDocument() throws {
        let e = entry("Kubernetes", misspelling: " cooper netties ", starred: true, at: 1_761_000_000.1234)
        let d = VoiceDocs.newDoc(for: e)
        #expect(d.id == e.id.uuidString && d.type == "entry")
        #expect(d.fields == ["term": .string("Kubernetes"), "misspelling": .string("cooper netties"),
                             "starred": .bool(true), "created_at": .number(1_761_000_000_123)])
        // Never-synced fields carry the entry's creation time.
        #expect(Set(d.clocks.values) == [1_761_000_000_123] && d.updatedAt == 1_761_000_000_123)
        let wire = FieldDocWire(collection: "voice")
        let back = try #require(wire.decode(wire.encode(d, device: "mac")).flatMap(VoiceDocs.entry))
        #expect(VoiceDocs.same(back, e))
        #expect(back.misspelling == "cooper netties")
    }

    @Test func noMisspellingIsNull() {
        let d = VoiceDocs.newDoc(for: entry("gRPC", misspelling: "", at: 1))
        #expect(d.fields["misspelling"] == .null)
        #expect(VoiceDocs.entry(d)?.misspelling == nil)
    }

    @Test func documentsTheDictionaryCannotShowAreSkipped() {
        let id = UUID()
        #expect(VoiceDocs.entry(entryDoc(id.uuidString.lowercased(), term: "Ammaar", createdAt: 5))?.id == id)
        var deleted = entryDoc(id.uuidString, term: "Ammaar", createdAt: 5)
        deleted.deleted = true
        var mode = entryDoc(id.uuidString, term: "Ammaar", createdAt: 5)
        mode.type = "mode"
        for d in [deleted, mode, entryDoc("not-a-uuid", term: "x", createdAt: 5), entryDoc(id.uuidString, term: "  ", createdAt: 5),
                  entryDoc(id.uuidString, term: String(repeating: "a", count: 61), createdAt: 5)] {
            #expect(VoiceDocs.entry(d) == nil)
        }
        // created_at missing: the document's own creation time.
        var bare = FieldDoc(id: id.uuidString, type: "entry", createdAt: 42_000, updatedAt: 42_000)
        bare.set("term", .string("NixOS"), at: 42_000)
        #expect(VoiceDocs.entry(bare).map { VoiceDocs.milliseconds($0.createdAt) } == 42_000)
    }

    @Test func settingsTakeDefaultsForMissingOrMistypedFields() {
        #expect(VoiceDocs.settings(nil) == VoiceDocs.settingsDefaults)
        var d = FieldDoc(id: "voice-settings", type: "settings", createdAt: 1, updatedAt: 1)
        d.set("customInstructions", .string("lowercase"), at: 2)
        d.set("customInstructionsEnabled", .number(1), at: 2)
        d.set("language", .string("da"), at: 2)
        #expect(VoiceDocs.settings(d) == ["customInstructions": .string("lowercase"), "customInstructionsEnabled": .bool(false), "cleanupEnabled": .bool(true)])
        d.deleted = true
        #expect(VoiceDocs.settings(d) == VoiceDocs.settingsDefaults)
    }

    @Test func aTermAddedOnTwoDevicesShowsOnceKeepingStarAndMisspelling() {
        let (a, b, c) = (UUID(), UUID(), UUID())
        let docs = [
            entryDoc(b.uuidString, term: "kubernetes", starred: true, misspelling: "cooper netties", createdAt: 2000),
            entryDoc(a.uuidString, term: "Kubernetes", createdAt: 1000),
            entryDoc(c.uuidString, term: "gRPC", createdAt: 1500),
        ]
        for order in [docs, docs.reversed()] {
            let (entries, groups) = VoiceDocs.dictionary(order)
            #expect(entries.map(\.term) == ["Kubernetes", "gRPC"])
            #expect(entries[0].id == a && entries[0].starred && entries[0].misspelling == "cooper netties")
            #expect(groups[a] == [a.uuidString, b.uuidString] && groups[c] == [c.uuidString])
        }
    }

    @Test func voiceWireTakesOnlyVoiceDocuments() {
        let wire = FieldDocWire(collection: "voice")
        let todo = FieldDocWire(collection: "todos").encode(entryDoc(UUID().uuidString, term: "x", createdAt: 1), device: "mac")
        #expect(wire.decode(todo) == nil)
        // Android-only dictation modes keep every field.
        var mode = FieldDoc(id: UUID().uuidString, type: "mode", createdAt: 1, updatedAt: 3)
        mode.set("name", .string("Email"), at: 2)
        mode.set("order", .number(1.5), at: 3)
        mode.extra["v"] = .number(2)
        let back = wire.decode(wire.encode(mode, device: "phone"))
        #expect(back?.type == "mode" && back?.fields == mode.fields && back?.clocks == mode.clocks && back?.extra == mode.extra)
    }
}

// MARK: - Engine and bridge

extension SharedStateTests {
    /// The dictionary and cleanup settings against the voice documents, on one or more
    /// simulated Macs syncing through a fake server. Nested under `SharedStateTests`:
    /// applying documents posts `gtSettingDidChange` on the default center.
    @Suite struct VoiceSyncTests {
        @Test func firstSyncUploadsTheDictionaryAsOld() throws {
            let mac = VoiceDevice("a")
            let k = entry("Kubernetes", misspelling: "cooper netties", at: 1_700_000_000)
            mac.setEntries([k])
            mac.defaults.set("Write in lowercase.", forKey: "customInstructions")
            mac.defaults.set(true, forKey: "customInstructionsEnabled")
            #expect(mac.bridge.reconcile())

            let d = try #require(mac.repo.docs[k.id.uuidString])
            #expect(d.dirty && VoiceDocs.entry(d).map { VoiceDocs.same($0, k) } == true)
            #expect(Set(d.clocks.values) == [1_700_000_000_000])
            let s = try #require(mac.repo.docs["voice-settings"])
            #expect(s.type == "settings" && s.dirty)
            #expect(s.fields == ["customInstructions": .string("Write in lowercase."), "customInstructionsEnabled": .bool(true)])
            // Values this Mac had before syncing lose to any synced edit; defaults aren't sent.
            #expect(s.clocks == ["customInstructions": 1, "customInstructionsEnabled": 1])
            #expect(!mac.bridge.reconcile())
        }

        @Test func applyingRemoteChangesMakesNoLocalChanges() throws {
            let mac = VoiceDevice("a")
            let id = UUID()
            var remote = entryDoc(id.uuidString.lowercased(), term: "Ammaar", createdAt: 1_000)
            remote.seq = 1
            var settings = FieldDoc(id: "voice-settings", type: "settings", createdAt: 1, updatedAt: 5_000)
            settings.set("cleanupEnabled", .bool(false), at: 5_000)
            settings.seq = 2
            mac.engine.applySnapshot([remote, settings], ids: [remote.id, settings.id])

            #expect(!mac.bridge.reconcile())
            #expect(mac.repo.dirty.isEmpty)
            #expect(mac.entries.map(\.id) == [id] && mac.entries[0].term == "Ammaar")
            #expect(mac.defaults.object(forKey: "cleanupEnabled") as? Bool == false)
            #expect(!mac.bridge.reconcile())

            // A later remote edit and removal apply the same way.
            var starred = remote
            starred.set("starred", .bool(true), at: 6_000)
            starred.seq = 3
            mac.engine.applyRemote(starred)
            #expect(!mac.bridge.reconcile() && mac.entries.first?.starred == true)
            var gone = FieldDoc(id: remote.id, type: "", createdAt: 1_000, updatedAt: 7_000)
            gone.deleted = true
            gone.seq = 4
            mac.engine.applyRemote(gone)
            #expect(!mac.bridge.reconcile() && mac.entries.isEmpty && mac.repo.dirty.isEmpty)
        }

        @Test func aLocalEditMadeWhileARemoteOneArrivesIsKept() throws {
            let server = FakeVoiceServer()
            let (a, b) = (VoiceDevice("a"), VoiceDevice("b"))
            let k = entry("Kubernetes", at: 1_000)
            a.setEntries([k])
            a.connect(server)
            b.connect(server)
            settle([a, b], server)
            #expect(b.shown == ["Kubernetes"])

            // B stars it; before B reconciles, A's new misspelling arrives.
            b.edit(k.id) { $0.starred = true }
            a.edit(k.id) { $0.misspelling = "cooper netties" }
            a.bridge.reconcile()
            let put = try #require(a.engine.docsToSend().first)
            let (stored, _) = server.put(put, device: "a")
            a.engine.ack(id: put.id, seq: stored.seq, accepted: true, version: put.updatedAt)
            b.engine.applyRemote(stored)
            #expect(b.bridge.reconcile())
            #expect(b.shown == ["Kubernetes*<cooper netties"])
            settle([a, b], server)
            #expect(a.shown == ["Kubernetes*<cooper netties"] && b.shown == a.shown)
        }

        @Test func firstSyncOfSeveralMacsUnionsTheirDictionaries() {
            let server = FakeVoiceServer()
            let (a, b) = (VoiceDevice("a"), VoiceDevice("b"))
            let shared = UUID() // the same entry on both, e.g. from a config.json in dotfiles
            a.setEntries([entry("Kubernetes", at: 1_000), entry("gRPC", at: 2_000, id: shared), entry("NixOS", at: 3_000)])
            b.setEntries([entry("Ammaar", at: 1_500), entry("gRPC", starred: true, at: 2_000, id: shared),
                          entry("nixos", misspelling: "nick sauce", starred: true, at: 4_000)])
            a.connect(server)
            settle([a], server)
            b.connect(server)
            settle([a, b], server)

            let expected = ["Ammaar", "Kubernetes", "NixOS*<nick sauce", "gRPC*"]
            #expect(a.shown == expected && b.shown == expected)
            // Both NixOS documents stay; the older one stands for them.
            #expect(server.docs.values.filter { !$0.deleted && $0.type == "entry" }.count == 5)
            #expect(a.entries.first { $0.term == "NixOS" }?.createdAt == Date(timeIntervalSince1970: 3_000))
            #expect(a.repo.dirty.isEmpty && b.repo.dirty.isEmpty)
        }

        @Test func anEditOrRemovalReachesEveryDocumentBehindAnEntry() {
            let server = FakeVoiceServer()
            let (a, b) = (VoiceDevice("a"), VoiceDevice("b"))
            a.setEntries([entry("NixOS", at: 1_000)])
            b.setEntries([entry("nixos", starred: true, at: 2_000)])
            a.connect(server)
            b.connect(server)
            settle([a, b], server)
            #expect(a.shown == ["NixOS*"])

            let shown = a.entries[0].id
            a.edit(shown) { $0.starred = false }
            settle([a, b], server)
            #expect(a.shown == ["NixOS"] && b.shown == ["NixOS"])
            #expect(!server.docs.values.contains { $0.fields["starred"] == .bool(true) })

            b.setEntries([])
            settle([a, b], server)
            #expect(a.entries.isEmpty && server.docs.values.allSatisfy(\.deleted))
        }

        @Test func deletionsSyncAndAnOlderCopyStaysDeleted() {
            let server = FakeVoiceServer()
            let (a, b) = (VoiceDevice("a"), VoiceDevice("b"))
            let k = entry("Kubernetes", at: 1_000)
            a.setEntries([k, entry("gRPC", at: 2_000)])
            a.connect(server)
            b.connect(server)
            settle([a, b], server)
            a.setEntries(a.entries.filter { $0.id != k.id })
            settle([a, b], server)
            #expect(b.shown == ["gRPC"])

            // A stale copy (a config.json from before the deletion) brings it back locally.
            b.setEntries(b.entries + [k])
            settle([a, b], server)
            #expect(b.shown == ["gRPC"] && a.shown == ["gRPC"] && server.docs[k.id.uuidString]?.deleted == true)

            // Re-adding the term is a new entry and syncs.
            b.setEntries(b.entries + [entry("Kubernetes", at: Date().timeIntervalSince1970)])
            settle([a, b], server)
            #expect(a.shown == ["Kubernetes", "gRPC"])
        }

        @Test func settingsMergePerField() {
            let server = FakeVoiceServer()
            let (a, b) = (VoiceDevice("a"), VoiceDevice("b"))
            a.defaults.set("Spell British.", forKey: "customInstructions")
            a.connect(server)
            b.connect(server)
            settle([a, b], server)
            #expect(b.defaults.string(forKey: "customInstructions") == "Spell British.")

            // Concurrent edits of different settings both survive.
            a.defaults.set(true, forKey: "customInstructionsEnabled")
            b.defaults.set(false, forKey: "cleanupEnabled")
            a.bridge.reconcile()
            b.bridge.reconcile()
            settle([a, b], server)
            for mac in [a, b] {
                #expect(mac.defaults.bool(forKey: "customInstructionsEnabled"))
                #expect(mac.defaults.object(forKey: "cleanupEnabled") as? Bool == false)
                #expect(mac.defaults.string(forKey: "customInstructions") == "Spell British.")
            }
            // Edits made while syncing carry the time, not the first-sync clock.
            let clocks = server.docs["voice-settings"]?.clocks ?? [:]
            #expect(clocks["customInstructions"] == 1)
            #expect((clocks["customInstructionsEnabled"] ?? 0) > 1 && (clocks["cleanupEnabled"] ?? 0) > 1)

            // A Mac that joins later with its own never-synced instructions doesn't
            // override an edit made while syncing.
            b.defaults.set("Spell American.", forKey: "customInstructions")
            settle([a, b], server)
            let c = VoiceDevice("c")
            c.defaults.set("Old local text.", forKey: "customInstructions")
            c.connect(server)
            settle([a, b, c], server)
            #expect(c.defaults.string(forKey: "customInstructions") == "Spell American.")
        }

        @Test func unknownDocumentsAndFieldsSurvive() throws {
            let server = FakeVoiceServer()
            let a = VoiceDevice("a")
            var mode = FieldDoc(id: UUID().uuidString, type: "mode", createdAt: 1, updatedAt: 2)
            mode.set("name", .string("Email"), at: 2)
            mode.set("prompt", .string("Formal."), at: 2)
            _ = server.put(mode, device: "phone")
            var settings = FieldDoc(id: "voice-settings", type: "settings", createdAt: 1, updatedAt: 2)
            settings.set("language", .string("da"), at: 2)
            _ = server.put(settings, device: "phone")
            let k = entry("Kubernetes", at: 1_000)
            var phoneEntry = VoiceDocs.newDoc(for: k)
            phoneEntry.set("color", .string("blue"), at: 1_000)
            _ = server.put(phoneEntry, device: "phone")
            a.connect(server)
            #expect(a.shown == ["Kubernetes"])

            a.edit(k.id) { $0.starred = true }
            a.defaults.set(false, forKey: "cleanupEnabled")
            settle([a], server)
            #expect(server.docs[mode.id]?.fields == mode.fields && a.repo.docs[mode.id]?.dirty == false)
            #expect(server.docs["voice-settings"]?.fields["language"] == .string("da"))
            #expect(server.docs["voice-settings"]?.fields["cleanupEnabled"] == .bool(false))
            #expect(server.docs[k.id.uuidString]?.fields["color"] == .string("blue"))
            #expect(server.docs[k.id.uuidString]?.fields["starred"] == .bool(true))
        }

        @Test func anUnreadableDictionaryIsRestoredNotDeleted() {
            let server = FakeVoiceServer()
            let a = VoiceDevice("a")
            a.setEntries([entry("Kubernetes", at: 1_000)])
            a.connect(server)
            settle([a], server)
            a.defaults.set(Data("not json".utf8), forKey: "dictionaryEntries")
            #expect(!a.bridge.reconcile())
            #expect(a.shown == ["Kubernetes"] && a.repo.dirty.isEmpty)
        }

        /// Two Macs make random dictionary and settings changes, syncing through the fake
        /// server with puts delivered late: they must end up showing the same thing.
        @Test(arguments: 0..<12) func macsConverge(seed: Int) {
            var rng = VoiceRNG(seed: UInt64(seed + 1))
            let server = FakeVoiceServer()
            let macs = [VoiceDevice("a"), VoiceDevice("b")]
            for mac in macs { mac.connect(server) }
            let terms = ["Kubernetes", "kubernetes", "gRPC", "NixOS", "Ammaar"]
            var queued: [(mac: VoiceDevice, doc: FieldDoc)] = []
            func deliver(_ q: (mac: VoiceDevice, doc: FieldDoc)) {
                let (stored, accepted) = server.put(q.doc, device: q.mac.name)
                q.mac.engine.ack(id: q.doc.id, seq: accepted ? stored.seq : nil, accepted: accepted, version: q.doc.updatedAt)
                if !accepted { q.mac.engine.applyRemote(stored) }
                for other in macs where other !== q.mac && accepted { other.engine.applyRemote(stored) }
            }
            for _ in 0..<40 {
                let mac = macs[Int.random(in: 0..<2, using: &rng)]
                var all = mac.entries
                switch Int.random(in: 0..<5, using: &rng) {
                case 0:
                    let term = terms.randomElement(using: &rng)!
                    if !all.contains(where: { $0.term.lowercased() == term.lowercased() }) {
                        all.append(entry(term, at: Double(Int.random(in: 1...9, using: &rng))))
                    }
                case 1: if !all.isEmpty { all.remove(at: Int.random(in: 0..<all.count, using: &rng)) }
                case 2: if !all.isEmpty { all[Int.random(in: 0..<all.count, using: &rng)].starred.toggle() }
                case 3: if !all.isEmpty { all[Int.random(in: 0..<all.count, using: &rng)].misspelling = ["x", "y", nil].randomElement(using: &rng)! }
                default: mac.defaults.set(["a", "b", ""].randomElement(using: &rng)!, forKey: "customInstructions")
                }
                mac.setEntries(all)
                mac.bridge.reconcile()
                for d in mac.engine.docsToSend() { mac.engine.markSent(d); queued.append((mac, d)) }
                while !queued.isEmpty, Bool.random(using: &rng) { deliver(queued.removeFirst()) }
                for m in macs { m.bridge.reconcile() }
            }
            while !queued.isEmpty { deliver(queued.removeFirst()) }
            for mac in macs { mac.engine.reset() }
            settle(macs, server)
            #expect(macs[0].shown == macs[1].shown, "seed \(seed)")
            #expect(macs[0].defaults.string(forKey: "customInstructions") == macs[1].defaults.string(forKey: "customInstructions"), "seed \(seed)")
            #expect(macs.allSatisfy { $0.repo.dirty.isEmpty }, "seed \(seed)")
            // Never two entries for one term.
            for mac in macs { #expect(Set(mac.entries.map { $0.term.lowercased() }).count == mac.entries.count) }
        }
    }
}

struct VoiceRNG: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}
