import Foundation

/// Wire format conversions for the sync protocol's note object.
enum NoteWire {
    /// JSON object for a client put (no `seq`).
    static func encode(_ n: Note, device: String) -> [String: Any] {
        [
            "id": n.id,
            "body": n.deleted ? "" : n.body,
            "created_at": n.createdAt,
            "updated_at": n.updatedAt,
            "deleted": n.deleted,
            "device": device,
            "meta": n.meta.mapValues(\.any),
        ]
    }

    static func decode(_ obj: Any?) -> Note? {
        guard let d = obj as? [String: Any], let id = d["id"] as? String, !id.isEmpty else { return nil }
        func int(_ k: String) -> Int64? {
            if let n = d[k] as? NSNumber { return n.int64Value }
            return nil
        }
        guard let updated = int("updated_at") else { return nil }
        var n = Note(id: id, body: d["body"] as? String ?? "", createdAt: int("created_at") ?? updated, updatedAt: updated)
        n.deleted = (d["deleted"] as? Bool) ?? ((d["deleted"] as? NSNumber)?.boolValue ?? false)
        if n.deleted { n.body = "" }
        n.seq = int("seq")
        n.device = d["device"] as? String ?? ""
        if let m = d["meta"] as? [String: Any] { n.meta = m.mapValues { JSONValue(any: $0) } }
        return n
    }
}

/// The client side of the sync protocol's state machine (transport independent).
///
/// - `dirty` notes have local changes the server hasn't acknowledged.
/// - `inflight` remembers which version (updated_at) of a note was sent, so an ack only
///   clears `dirty` when the note wasn't edited again in the meantime.
/// - Remote notes are applied with last-writer-wins on `updated_at`.
final class SyncEngine {
    enum RemoteResult: Equatable {
        case inserted, overwritten, adopted, keptLocal, unchanged
    }

    let repo: NoteRepository
    private(set) var inflight: [String: Int64] = [:]
    /// Notes the server refused (e.g. too large); not resent until edited again.
    private(set) var failed: [String: Int64] = [:]

    /// Called for every note whose stored content changed because of the server.
    var onRemoteChange: ((Note, RemoteResult) -> Void)?
    /// Called before a remote note is applied (lets the editor flush unsaved edits).
    var beforeApply: ((String) -> Void)?

    init(repo: NoteRepository) { self.repo = repo }

    // MARK: Incoming

    @discardableResult
    func applyRemote(_ r: Note) -> RemoteResult {
        if let s = r.seq, s > repo.lastSeq { repo.lastSeq = s }
        beforeApply?(r.id)
        guard let local = repo.note(r.id) else {
            var n = r
            n.dirty = false
            n.openedAt = 0
            repo.save(n)
            onRemoteChange?(n, .inserted)
            return .inserted
        }
        if local.dirty {
            if r.updatedAt > local.updatedAt {
                let n = merged(local: local, remote: r)
                repo.save(n)
                inflight.removeValue(forKey: r.id)
                onRemoteChange?(n, .adopted)
                return .adopted
            }
            // Keep ours; it will be (re)sent. Remember the server's seq anyway.
            if let s = r.seq, local.seq ?? -1 < s {
                var n = local
                n.seq = s
                repo.save(n)
            }
            inflight.removeValue(forKey: r.id) // force a resend
            return .keptLocal
        }
        let n = merged(local: local, remote: r)
        if sameContent(local, n) {
            if local.seq != n.seq { repo.save(n) }
            return .unchanged
        }
        repo.save(n)
        onRemoteChange?(n, .overwritten)
        return .overwritten
    }

    /// Applies a snapshot (reply to hello). Returns true when the server's seq went
    /// backwards (backup restore) and a full resync is needed.
    @discardableResult
    func applySnapshot(_ notes: [Note], seq: Int64) -> Bool {
        if seq < repo.lastSeq {
            // Server restored from a backup: everything we have that it lost must be resent.
            for var n in repo.allNotes(includeTombstones: true) where (n.seq ?? 0) > seq || n.seq == nil {
                n.dirty = true
                repo.save(n)
            }
            repo.lastSeq = 0
            return true
        }
        for n in notes.sorted(by: { ($0.seq ?? 0) < ($1.seq ?? 0) }) { applyRemote(n) }
        if seq > repo.lastSeq { repo.lastSeq = seq }
        return false
    }

    func ack(id: String, seq: Int64?, accepted: Bool) {
        let sent = inflight.removeValue(forKey: id)
        guard accepted else { return } // the stored winner follows as a `note` message
        guard var n = repo.note(id) else { return }
        if let seq {
            if seq == repo.lastSeq + 1 { repo.lastSeq = seq }
            n.seq = max(n.seq ?? 0, seq)
        }
        if let sent, n.updatedAt == sent { n.dirty = false }
        repo.save(n)
    }

    /// The server rejected a put with an error (validation, size).
    func putFailed(id: String) {
        if let sent = inflight.removeValue(forKey: id) { failed[id] = sent }
    }

    // MARK: Outgoing

    /// Dirty notes that aren't already in flight in their current version.
    func notesToSend() -> [Note] {
        repo.allNotes(includeTombstones: true).filter { n in
            n.dirty && inflight[n.id] != n.updatedAt && failed[n.id] != n.updatedAt
        }.sorted { $0.updatedAt < $1.updatedAt }
    }

    func markSent(_ n: Note) { inflight[n.id] = n.updatedAt }

    /// Connection lost: nothing is in flight any more.
    func reset() { inflight.removeAll() }

    var pendingCount: Int { repo.allNotes(includeTombstones: true).filter(\.dirty).count }

    // MARK: Helpers

    private func merged(local: Note, remote r: Note) -> Note {
        var n = r
        n.dirty = false
        n.openedAt = local.openedAt
        n.createdAt = min(local.createdAt, r.createdAt)
        return n
    }

    private func sameContent(_ a: Note, _ b: Note) -> Bool {
        a.body == b.body && a.deleted == b.deleted && a.meta == b.meta && a.updatedAt == b.updatedAt && a.createdAt == b.createdAt
    }
}
