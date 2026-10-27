import Foundation

/// Wire format conversions for the sync protocol's note object.
enum NoteWire {
    /// JSON object for a client put (no `seq`). `ancestors`: hashes of recent texts this
    /// version descends from, newest first.
    static func encode(_ n: Note, device: String, ancestors: [UInt64] = []) -> [String: Any] {
        var meta = n.meta
        meta.removeValue(forKey: baseKey)
        if !ancestors.isEmpty, !n.deleted {
            // Tied to this version's updated_at: an older client that edits the note keeps
            // the key but not the timestamp, so a stale base is never trusted.
            meta[baseKey] = .object(["at": .number(Double(n.updatedAt)),
                                     "hashes": .array(ancestors.map { .string(String($0, radix: 16)) })])
        }
        return [
            "id": n.id,
            "body": n.deleted ? "" : n.body,
            "created_at": n.createdAt,
            "updated_at": n.updatedAt,
            "deleted": n.deleted,
            "device": device,
            "meta": meta.mapValues(\.any),
        ]
    }

    /// `meta` key listing the texts a version descends from.
    static let baseKey = "base"

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
        if case .object(let b)? = n.meta.removeValue(forKey: baseKey), case .array(let hashes)? = b["hashes"],
           b["at"]?.double == Double(updated) {
            n.remoteBases = hashes.prefix(8).compactMap { if case .string(let h) = $0 { return UInt64(h, radix: 16) }; return nil }
        }
        return n
    }
}

/// The client side of the sync protocol's state machine (transport independent).
///
/// - `dirty` notes have local changes the server hasn't acknowledged.
/// - `inflight` remembers which versions (updated_at) of a note were sent, oldest first.
///   Acks arrive in send order on a connection, so each ack pops the version it
///   acknowledges and only clears `dirty` when that is still the current version.
/// - Concurrent text edits are merged like Google Docs: every put lists recent texts it
///   descends from (`meta.base`), and when one of them is also an ancestor of the local
///   text (versions seen, sent or merged this session), both sides' changes since the
///   newest such text are applied together and the result is sent back.
/// - Otherwise remote notes are applied with last-writer-wins on `updated_at`. When a
///   real concurrent edit would be overwritten (both sides changed the body since the
///   last version they share, and the changes overlap or can't be merged), the losing
///   body is kept as a "conflicted copy" note, so no edit is ever silently lost.
final class SyncEngine {
    enum RemoteResult: Equatable {
        case inserted, overwritten, adopted, keptLocal, unchanged
        /// Remote text merged with a local meta-only change, or remote meta with local text.
        case merged
    }

    struct Sent: Equatable {
        let updatedAt: Int64
        let bodyHash: UInt64
    }

    let repo: NoteRepository
    /// This client's device name (puts carry it; notes from it are our own echoes).
    var device = ""
    private(set) var inflight: [String: [Sent]] = [:]
    /// Notes the server refused (e.g. too large); not resent until edited again.
    private(set) var failed: [String: Int64] = [:]
    /// Notes re-sent after the server lost them (seq regression): their base is unknown.
    private var resyncing: Set<String> = []
    /// Conflicted copies made this session, by "<note id>|<losing device>", so a burst of
    /// concurrent typing updates one copy instead of creating dozens.
    private var conflictCopies: [String: (id: String, updatedAt: Int64, created: Int64)] = [:]

    /// Recent texts of each note by hash, oldest first (seen from the server, sent, merged
    /// or about to be edited). `ancestor`: the local text descends from it, so it can be
    /// the base of a three-way merge.
    private var versions: [String: [(hash: UInt64, body: String, ancestor: Bool)]] = [:]
    private static let versionsKept = 16

    /// Called for every note whose stored content changed because of the server.
    var onRemoteChange: ((Note, RemoteResult) -> Void)?
    /// Called before a remote note is applied (lets the editor flush unsaved edits).
    var beforeApply: ((String) -> Void)?
    /// Called after a conflicted copy was created or updated (the copy, the original's id).
    var onConflictCopy: ((Note, String) -> Void)?

    init(repo: NoteRepository) { self.repo = repo }

    // MARK: Incoming

    @discardableResult
    func applyRemote(_ r: Note) -> RemoteResult {
        if let s = r.seq, s > repo.lastSeq { repo.lastSeq = s }
        beforeApply?(r.id)
        guard let local = repo.note(r.id) else {
            var n = r
            n.remoteBases = []
            n.dirty = false
            n.openedAt = 0
            n.baseHash = NoteText.hash(n.body)
            repo.save(n)
            remember(n.id, n.body, ancestor: true)
            onRemoteChange?(n, .inserted)
            return .inserted
        }
        remember(local.id, local.body, ancestor: true)
        let wasResyncing = resyncing.remove(r.id) != nil
        if !wasResyncing, let result = threeWay(local: local, remote: r) { return result }
        defer { settle(local: local, remote: r) }
        if local.dirty {
            if wasResyncing { return applyAfterRestore(local: local, remote: r) }
            // A version from another device that this local edit was not based on.
            let concurrent = (r.seq ?? 0) > (local.seq ?? 0) && r.device != device && r.body != local.body
            let localBodyChanged = local.baseHash.map { $0 != NoteText.hash(local.body) } ?? true
            let remoteBodyChanged = local.baseHash.map { $0 != NoteText.hash(r.body) } ?? true
            if r.updatedAt > local.updatedAt {
                if concurrent, localBodyChanged, !remoteBodyChanged, !r.deleted {
                    // They only changed meta (pin, trash…), we changed the text: keep both.
                    var n = local
                    n.meta = r.meta
                    n.seq = r.seq
                    n.updatedAt = Note.nextUpdate(after: r.updatedAt, local.updatedAt)
                    n.dirty = true
                    repo.save(n)
                    onRemoteChange?(n, .merged)
                    return .merged
                }
                if concurrent, localBodyChanged, !local.deleted {
                    conflictCopy(body: local.body, from: device, of: local)
                }
                return adopt(local: local, remote: r)
            }
            // Ours is newer and will be (re)sent.
            var n = local
            if concurrent, remoteBodyChanged, !r.deleted {
                if !localBodyChanged {
                    // We only changed meta, they changed the text: take their text.
                    n.body = r.body
                    n.updatedAt = Note.nextUpdate(after: local.updatedAt)
                    n.seq = r.seq
                    n.baseHash = NoteText.hash(r.body)
                    repo.save(n)
                    onRemoteChange?(n, .merged)
                    return .merged
                }
                conflictCopy(body: r.body, from: r.device, of: local)
                n.baseHash = NoteText.hash(r.body) // their version is preserved; ours supersedes it
            }
            // Remember the server's seq so the same version isn't treated as unseen again.
            if let s = r.seq, local.seq ?? -1 < s { n.seq = s }
            if n != local { repo.save(n) }
            return .keptLocal
        }
        var n = merged(local: local, remote: r)
        n.baseHash = NoteText.hash(r.body)
        if sameContent(local, n) {
            if local.seq != n.seq || local.baseHash != n.baseHash { repo.save(n) }
            return .unchanged
        }
        repo.save(n)
        onRemoteChange?(n, .overwritten)
        return .overwritten
    }

    /// The server lost our version (restored backup) and now sends what it has, usually
    /// an older version: plain last-writer-wins, keeping our text if theirs wins.
    private func applyAfterRestore(local: Note, remote r: Note) -> RemoteResult {
        if r.updatedAt > local.updatedAt {
            if r.body != local.body, !local.deleted { conflictCopy(body: local.body, from: device, of: local) }
            return adopt(local: local, remote: r)
        }
        var n = local
        n.seq = r.seq
        n.baseHash = NoteText.hash(r.body)
        if n != local { repo.save(n) }
        return .keptLocal
    }

    /// A remote text edit that shares an ancestor with ours: both sides' changes kept.
    /// nil when that doesn't apply (no shared ancestor known, deletes, same text, changes
    /// to the same text) and last-writer-wins decides as before.
    private func threeWay(local: Note, remote r: Note) -> RemoteResult? {
        guard !r.remoteBases.isEmpty, !r.deleted, !local.deleted, r.body != local.body else { return nil }
        if r.remoteBases.contains(NoteText.hash(local.body)) {
            // Made from our text (which reached the server): a fast-forward, even if our
            // ack hasn't arrived yet. Clean notes take the normal path.
            return local.dirty ? take(local: local, remote: r, fastForward: true) : nil
        }
        // A version we already had (our own, echoed by a snapshot) brings nothing new.
        if ancestor(local.id, NoteText.hash(r.body)) { return keepMerged(local: local, remote: r, body: local.body) }
        guard let base = r.remoteBases.lazy.compactMap({ self.ancestorText(local.id, $0) }).first,
              let body = TextMerge.merge(base: base, local: local.body, remote: r.body) else { return nil }
        if body == r.body { return local.dirty ? take(local: local, remote: r, fastForward: false) : nil }
        return keepMerged(local: local, remote: r, body: body)
    }

    /// Stores a text that includes the remote version as a new local version (it goes to
    /// the server, which only has theirs).
    private func keepMerged(local: Note, remote r: Note, body: String) -> RemoteResult {
        var n = local
        n.body = body
        if r.updatedAt > local.updatedAt { n.meta = r.meta }
        if let s = r.seq, local.seq ?? -1 < s { n.seq = s }
        if body != local.body || !local.dirty || local.updatedAt <= r.updatedAt {
            n.updatedAt = Note.nextUpdate(after: r.updatedAt, local.updatedAt)
        }
        n.dirty = true
        n.baseHash = NoteText.hash(r.body)
        repo.save(n)
        // their ancestors are ours now too
        versions[n.id] = versions[n.id]?.map { v in (v.hash, v.body, v.ancestor || r.remoteBases.contains(v.hash)) }
        remember(n.id, r.body, ancestor: true)
        remember(n.id, body, ancestor: true)
        if body != local.body || n.meta != local.meta { onRemoteChange?(n, .merged) }
        return body == local.body ? .keptLocal : .merged
    }

    private func take(local: Note, remote r: Note, fastForward: Bool) -> RemoteResult {
        let result = adopt(local: local, remote: r)
        rebase(r.id, onto: r, fastForward: fastForward)
        return result
    }

    /// After last-writer-wins: what the local text descends from now.
    private func settle(local: Note, remote r: Note) {
        let body = repo.note(r.id)?.body
        if body == r.body, local.body != r.body {
            rebase(r.id, onto: r, fastForward: r.remoteBases.contains(NoteText.hash(local.body)))
        } else {
            remember(r.id, r.body, ancestor: body == r.body)
        }
    }

    /// Our text was replaced by theirs: only their ancestors are ours now (all of ours too
    /// when theirs was made from our text).
    private func rebase(_ id: String, onto r: Note, fastForward: Bool) {
        if !fastForward { versions[id] = versions[id]?.map { v in (v.hash, v.body, r.remoteBases.contains(v.hash)) } }
        remember(id, r.body, ancestor: true)
    }

    private func adopt(local: Note, remote r: Note) -> RemoteResult {
        var n = merged(local: local, remote: r)
        n.baseHash = NoteText.hash(r.body)
        repo.save(n)
        onRemoteChange?(n, .adopted)
        return .adopted
    }

    /// Applies a snapshot (reply to hello). Returns true when the server's seq went
    /// backwards (backup restore) and a full resync is needed.
    @discardableResult
    func applySnapshot(_ notes: [Note], seq: Int64) -> Bool {
        if seq < repo.lastSeq {
            // Server restored from a backup: everything we have that it lost must be resent.
            for var n in repo.allNotes(includeTombstones: true) where (n.seq ?? 0) > seq || n.seq == nil {
                if n.seq == nil, !n.dirty, !n.deleted, n.body.isEmpty { continue } // blank, never synced
                n.dirty = true
                // Our base is gone from the server: forget it, so what it sends back is
                // never mistaken for a newer concurrent edit.
                n.seq = nil
                n.baseHash = nil
                repo.save(n)
                resyncing.insert(n.id)
            }
            repo.lastSeq = 0
            return true
        }
        for n in notes.sorted(by: { ($0.seq ?? 0) < ($1.seq ?? 0) }) { applyRemote(n) }
        if seq > repo.lastSeq { repo.lastSeq = seq }
        return false
    }

    /// An ack for a put. `version` is the updated_at that was sent when the transport
    /// knows it (REST); WebSocket acks arrive in send order and pop the oldest version.
    func ack(id: String, seq: Int64?, accepted: Bool, version: Int64? = nil) {
        let sent = popInflight(id, version: version)
        guard accepted else { return } // the stored winner follows as a `note` message
        guard var n = repo.note(id) else { return }
        if let seq {
            if seq == repo.lastSeq + 1 { repo.lastSeq = seq }
            if let sent, seq >= (n.seq ?? 0) { n.baseHash = sent.bodyHash }
            n.seq = max(n.seq ?? 0, seq)
        }
        if let sent, n.updatedAt == sent.updatedAt { n.dirty = false }
        resyncing.remove(id)
        repo.save(n)
    }

    /// The server rejected a put with an error (validation, size).
    func putFailed(id: String, version: Int64? = nil) {
        if let sent = popInflight(id, version: version) { failed[id] = sent.updatedAt }
    }

    /// The note can't be sent (too large to ever be accepted): park it until edited again.
    func markUnsendable(_ n: Note) { failed[n.id] = n.updatedAt }

    /// Dirty notes the server refused in their current version (kept locally, not resent).
    var blockedNotes: [Note] {
        failed.compactMap { id, v in repo.note(id).flatMap { $0.dirty && $0.updatedAt == v ? $0 : nil } }
    }

    private func popInflight(_ id: String, version: Int64?) -> Sent? {
        guard var q = inflight[id], !q.isEmpty else { return nil }
        let sent: Sent
        if let version, let i = q.firstIndex(where: { $0.updatedAt == version }) {
            sent = q.remove(at: i)
        } else {
            sent = q.removeFirst()
        }
        inflight[id] = q.isEmpty ? nil : q
        return sent
    }

    // MARK: Outgoing

    /// Dirty notes that aren't already in flight in their current version.
    func notesToSend() -> [Note] {
        repo.allNotes(includeTombstones: true).filter { n in
            n.dirty && inflight[n.id]?.last?.updatedAt != n.updatedAt && failed[n.id] != n.updatedAt
        }.sorted { $0.updatedAt < $1.updatedAt }
    }

    func markSent(_ n: Note) {
        if !n.deleted { remember(n.id, n.body, ancestor: true) }
        inflight[n.id, default: []].append(Sent(updatedAt: n.updatedAt, bodyHash: NoteText.hash(n.deleted ? "" : n.body)))
    }

    var hasInflight: Bool { !inflight.isEmpty }

    /// Connection lost: nothing is in flight any more.
    func reset() { inflight.removeAll() }

    var pendingCount: Int { repo.allNotes(includeTombstones: true).filter(\.dirty).count }

    // MARK: Conflicts

    /// Keeps text that can't be applied to its note any more as a conflicted copy.
    func preserve(body: String, of original: Note) {
        conflictCopy(body: body, from: device, of: original)
    }

    /// Keeps a body that lost a last-writer-wins race as its own note (synced like any edit).
    private func conflictCopy(body: String, from loser: String, of original: Note) {
        guard let copyBody = NoteText.conflictCopyBody(body, device: loser) else { return }
        let key = original.id + "|" + loser
        let now = Note.now()
        if let c = conflictCopies[key], now - c.created < 10 * 60_000, var existing = repo.note(c.id),
           existing.isLive, existing.updatedAt == c.updatedAt {
            guard existing.body != copyBody else { return }
            existing.body = copyBody
            existing.updatedAt = Note.nextUpdate(after: existing.updatedAt)
            existing.dirty = true
            repo.save(existing)
            conflictCopies[key] = (existing.id, existing.updatedAt, c.created)
            onConflictCopy?(existing, original.id)
            return
        }
        var n = Note(body: copyBody, createdAt: now)
        n.device = device
        n.dirty = true
        n.meta["conflictOf"] = .string(original.id)
        repo.save(n)
        conflictCopies[key] = (n.id, n.updatedAt, now)
        onConflictCopy?(n, original.id)
    }

    // MARK: Helpers

    /// The local note is about to be edited: keep its text, the base of the edit.
    func willEdit(_ n: Note) {
        // keystrokes before the debounced save all see the same stored version
        guard !n.dirty, !n.deleted, editBases[n.id] != n.updatedAt else { return }
        editBases[n.id] = n.updatedAt
        remember(n.id, n.body, ancestor: true)
    }

    private var editBases: [String: Int64] = [:]

    private func remember(_ id: String, _ body: String, ancestor: Bool) {
        let h = NoteText.hash(body)
        var list = versions[id, default: []]
        if let i = list.firstIndex(where: { $0.hash == h && $0.body == body }) {
            let v = list.remove(at: i)
            list.append((h, body, v.ancestor || ancestor))
        } else {
            list.append((h, body, ancestor))
            if list.count > Self.versionsKept { list.removeFirst(list.count - Self.versionsKept) }
        }
        versions[id] = list
    }

    private func ancestorText(_ id: String, _ hash: UInt64) -> String? {
        versions[id]?.last(where: { $0.hash == hash && $0.ancestor })?.body
    }

    /// Recent texts a local version descends from, newest first (sent as `meta.base`).
    func ancestors(of n: Note) -> [UInt64] {
        var out = (versions[n.id] ?? []).reversed().filter(\.ancestor).prefix(4).map(\.hash)
        if let b = n.baseHash, !out.contains(b) { out.append(b) }
        return out
    }

    /// The put for a note.
    func encode(_ n: Note) -> [String: Any] { NoteWire.encode(n, device: device, ancestors: ancestors(of: n)) }

    private func ancestor(_ id: String, _ hash: UInt64) -> Bool {
        versions[id]?.contains { $0.hash == hash && $0.ancestor } ?? false
    }

    private func merged(local: Note, remote r: Note) -> Note {
        var n = r
        n.remoteBases = []
        n.dirty = false
        n.openedAt = local.openedAt
        n.createdAt = min(local.createdAt, r.createdAt)
        return n
    }

    private func sameContent(_ a: Note, _ b: Note) -> Bool {
        a.body == b.body && a.deleted == b.deleted && a.meta == b.meta && a.updatedAt == b.updatedAt && a.createdAt == b.createdAt
    }
}
