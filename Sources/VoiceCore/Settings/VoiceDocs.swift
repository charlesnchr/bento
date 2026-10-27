import BentoCore
import Foundation

/// The `voice` collection of bento-sync ("Voice documents" in docs/SYNC_PROTOCOL.md):
/// one field document per dictionary entry plus one for the cleanup settings, shared by
/// every Mac and the Android app. Documents of other types (the Android app's dictation
/// modes) and fields this client doesn't know are stored as they are and never shown.
public enum VoiceDocs {
    public static let collection = "voice"
    public static let settingsID = "voice-settings"
    static let entryType = "entry"
    static let settingsType = "settings"

    /// The synced settings under their SettingsStore keys, with the values a missing field means.
    static let settingsDefaults: [String: SyncValue] = [
        "customInstructions": .string(""), "customInstructionsEnabled": .bool(false), "cleanupEnabled": .bool(true),
    ]

    static func milliseconds(_ date: Date) -> Int64 {
        let ms = date.timeIntervalSince1970 * 1000
        return ms.isFinite ? FieldDoc.int64(ms.rounded()) ?? 0 : 0
    }

    static func date(milliseconds ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }

    // MARK: Entries

    static func misspelling(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    /// An entry's synced fields.
    static func fields(_ e: DictionaryEntry) -> [String: SyncValue] {
        [
            "term": .string(e.term),
            "misspelling": misspelling(e.misspelling).map(SyncValue.string) ?? .null,
            "starred": .bool(e.starred),
            "created_at": .number(Double(milliseconds(e.createdAt))),
        ]
    }

    /// The same entry as far as sync can tell (creation time to the millisecond, an
    /// empty misspelling is none).
    static func same(_ a: DictionaryEntry, _ b: DictionaryEntry) -> Bool {
        a.id == b.id && fields(a) == fields(b)
    }

    /// A new document for an entry. Its fields carry the entry's creation time as their
    /// clock, so a dictionary a Mac had before it synced counts as older than any edit
    /// made while syncing, and an entry deleted elsewhere stays deleted.
    static func newDoc(for e: DictionaryEntry) -> FieldDoc {
        let created = milliseconds(e.createdAt)
        var d = FieldDoc(id: e.id.uuidString, type: entryType, createdAt: created, updatedAt: created)
        for (key, value) in fields(e) { d.set(key, value, at: created) }
        return d
    }

    /// The entry one live document describes; nil for tombstones, other types, ids that
    /// aren't UUIDs and terms the dictionary wouldn't take (1–60 characters).
    static func entry(_ d: FieldDoc) -> DictionaryEntry? {
        guard !d.deleted, d.type == entryType, let id = UUID(uuidString: d.id) else { return nil }
        let term = (d.fields["term"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...60).contains(term.count) else { return nil }
        var e = DictionaryEntry(term: term, misspelling: misspelling(d.fields["misspelling"]?.string),
                                starred: d.fields["starred"]?.bool ?? false)
        e.id = id
        e.createdAt = date(milliseconds: d.fields["created_at"]?.int64 ?? d.createdAt)
        return e
    }

    /// The dictionary the documents describe, one entry per term (ignoring case). When
    /// two devices added the same term, both documents stay and the one created first
    /// (then the smaller id) stands for them: starred if either is, with the first
    /// misspelling either has. `docs` lists every document behind a shown entry, so an
    /// edit or a removal reaches them all.
    static func dictionary(_ all: [FieldDoc]) -> (entries: [DictionaryEntry], docs: [UUID: [String]]) {
        var groups: [String: [(entry: DictionaryEntry, id: String)]] = [:]
        for d in all {
            guard let e = entry(d) else { continue }
            groups[e.term.lowercased(), default: []].append((e, d.id))
        }
        var entries: [DictionaryEntry] = []
        var docs: [UUID: [String]] = [:]
        for members in groups.values {
            let sorted = members.sorted { a, b in
                let (ta, tb) = (milliseconds(a.entry.createdAt), milliseconds(b.entry.createdAt))
                return ta != tb ? ta < tb : a.id < b.id
            }
            var shown = sorted[0].entry
            shown.starred = sorted.contains { $0.entry.starred }
            shown.misspelling = sorted.lazy.compactMap { $0.entry.misspelling }.first
            entries.append(shown)
            docs[shown.id] = sorted.map { $0.id }
        }
        entries.sort { a, b in
            let (ta, tb) = (milliseconds(a.createdAt), milliseconds(b.createdAt))
            return ta != tb ? ta < tb : a.id.uuidString < b.id.uuidString
        }
        return (entries, docs)
    }

    // MARK: Settings

    /// What a live settings document says; fields it lacks, or holds with the wrong
    /// type, take their defaults.
    static func settings(_ d: FieldDoc?) -> [String: SyncValue] {
        var out = settingsDefaults
        guard let d, !d.deleted, d.type == settingsType else { return out }
        for (key, fallback) in settingsDefaults {
            switch (d.fields[key], fallback) {
            case (.string(let s)?, .string): out[key] = .string(s)
            case (.bool(let b)?, .bool): out[key] = .bool(b)
            default: break
            }
        }
        return out
    }
}
