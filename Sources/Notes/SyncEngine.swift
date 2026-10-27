import Foundation

/// Wire format conversions for the sync protocol's note object.
enum NoteWire {
    /// JSON object for a client put (no `seq`). `heads`: which versions of each Mac's
    /// text it contains (nil: unknown, e.g. right after a relaunch).
    static func encode(_ n: Note, device: String, heads: SyncHeads? = nil) -> [String: Any] {
        var meta = n.meta
        meta.removeValue(forKey: baseKey)
        if let heads, !n.deleted {
            // Tied to this version's updated_at: an older client that edits the note keeps
            // the key but not the timestamp, so a stale base is never trusted.
            meta[baseKey] = .object(["at": .number(Double(n.updatedAt)),
                                     "heads": .object(heads.mapValues { .array([.number(Double($0.at)), .string(String($0.hash, radix: 16))]) })])
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

    /// `meta` key saying which versions of each Mac's text a version contains.
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
        if case .object(let b)? = n.meta.removeValue(forKey: baseKey), case .object(let heads)? = b["heads"],
           b["at"]?.double == Double(updated), heads.count <= 64 {
            var out: SyncHeads = [:]
            for (device, v) in heads {
                guard case .array(let a) = v, a.count == 2, let at = a[0].double.flatMap(Note.int64),
                      case .string(let h) = a[1], let hash = UInt64(h, radix: 16) else { out = [:]; break }
                out[device] = SyncHead(at: at, hash: hash)
            }
            if !out.isEmpty { n.remoteHeads = out }
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
/// - Concurrent text edits are merged like Google Docs. Every put says which version of
///   each Mac's text it contains (`meta.base`: per device, that device's `updated_at` and
///   body hash, like a version vector). Exactly one side merges a pair of concurrent
///   versions: the one whose version the server doesn't have (overwritten by the other,
///   or refused) rebases onto the server's and sends the result, which the other side
///   takes as a fast-forward. A remote version arriving while a put of ours is in flight
///   waits for that put's ack, which tells which of the two the server kept. The merge
///   base is a known text containing exactly what both contain; when there is none (or
///   two Macs did merge each other's versions), nothing is merged.
///   This state is in memory only.
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
        let body: String
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

    /// Per note, which versions of each Mac's text the local text contains (what was sent,
    /// adopted or merged; unsent typing comes on top). Missing: unknown (e.g. after a
    /// relaunch), so nothing is merged until a remote version is adopted.
    private var heads: [String: SyncHeads] = [:]
    /// Recent versions of each note whose text is exactly what their heads say (sent or
    /// received, never one with unsent typing), oldest first: the bases of merges.
    private var versions: [String: [(heads: SyncHeads, body: String)]] = [:]
    /// Notes with versions, least recently used first.
    private var versionNotes: [String] = []
    private static let versionsKept = 64, versionBytes = 1 << 20, versionNotesKept = 16
    /// A concurrent remote version that arrived while a put of ours was in flight.
    private var deferred: [String: Note] = [:]
    /// Notes whose put was in flight when the connection dropped: it may still reach the
    /// server, so they wait like an in-flight put until the resent version's ack.
    private var uncertain: Set<String> = []

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
            n.remoteHeads = nil
            n.dirty = false
            n.openedAt = 0
            n.baseHash = NoteText.hash(n.body)
            repo.save(n)
            adoptHeads(of: r)
            onRemoteChange?(n, .inserted)
            return .inserted
        }
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

    /// A remote text edit that says what it contains. nil when that doesn't apply (no
    /// heads on either side, deletes) and last-writer-wins decides as before.
    private func threeWay(local: Note, remote r: Note) -> RemoteResult? {
        guard let theirs = r.remoteHeads, !r.deleted, !local.deleted else { return nil }
        record(r.id, theirs, r.body)
        guard r.body != local.body else {
            if let mine = heads[r.id] { heads[r.id] = Self.join(mine, theirs) }
            return nil
        }
        if let rs = r.seq, let ls = local.seq, rs <= ls { return .unchanged } // older than what we have
        guard let mine = heads[r.id] else { return nil }
        if !local.dirty { uncertain.remove(r.id) } // nothing of ours left to resend
        if inflight[r.id]?.isEmpty == false || uncertain.contains(r.id), theirs[device] != mine[device] {
            // Our put is on its way and theirs was made without it: the server will keep
            // ours (then they rebase onto it) or refuse it (then we rebase onto theirs).
            // Its ack decides.
            if (deferred[r.id]?.seq ?? -1) < (r.seq ?? 0) { deferred[r.id] = r }
            return .keptLocal
        }
        // The server's latest version: merge from exactly what both contain.
        guard let common = Self.meet(mine, theirs), let base = text(r.id, containing: common) else {
            // theirs contains everything our synced text does: nothing of ours to keep
            if !local.dirty, Self.join(mine, theirs) == theirs { return nil }
            return fallBack(local)
        }
        if base == local.body, local.dirty, local.baseHash == NoteText.hash(local.body), local.meta != r.meta {
            // only our meta changed (pin, trash): their text with our meta
            return keepMerged(local: local, remote: r, theirs: theirs, body: r.body, meta: local.meta)
        }
        guard let body = TextMerge.merge(base: base, local: local.body, remote: r.body) else { return fallBack(local) }
        if body == r.body {
            // all of ours is in theirs: a fast-forward
            heads[r.id] = Self.join(mine, theirs)
            return local.dirty ? adopt(local: local, remote: r) : nil
        }
        return keepMerged(local: local, remote: r, theirs: theirs, body: body)
    }

    /// Can't merge: last-writer-wins. A synced text of ours they overwrote is kept as a
    /// copy (unsynced edits get the usual treatment).
    private func fallBack(_ local: Note) -> RemoteResult? {
        if !local.dirty { conflictCopy(body: local.body, from: device, of: local) }
        return nil
    }

    /// Stores a text that includes the remote version as a new local version (it goes to
    /// the server, which only has theirs).
    private func keepMerged(local: Note, remote r: Note, theirs: SyncHeads, body: String, meta: [String: JSONValue]? = nil) -> RemoteResult {
        var n = local
        n.body = body
        if let meta { n.meta = meta } else if r.updatedAt > local.updatedAt { n.meta = r.meta }
        if let s = r.seq, local.seq ?? -1 < s { n.seq = s }
        if body != local.body || n.meta != local.meta || !local.dirty || local.updatedAt <= r.updatedAt {
            n.updatedAt = Note.nextUpdate(after: r.updatedAt, local.updatedAt)
        }
        n.dirty = true
        n.baseHash = NoteText.hash(r.body)
        repo.save(n)
        heads[n.id] = Self.join(heads[n.id] ?? [:], theirs)
        if body != local.body || n.meta != local.meta { onRemoteChange?(n, .merged) }
        return body == local.body ? .keptLocal : .merged
    }

    /// After last-writer-wins: when our text was replaced by theirs, so were our heads.
    private func settle(local: Note, remote r: Note) {
        if repo.note(r.id)?.body == r.body, local.body != r.body || heads[r.id] == nil { adoptHeads(of: r) }
    }

    /// The local text is now exactly `r`'s. A version that doesn't say what it contains
    /// (older client, or sent right after a relaunch) counts as the start of the history.
    private func adoptHeads(of r: Note) {
        guard !r.deleted else { heads.removeValue(forKey: r.id); return }
        let h = r.remoteHeads ?? [r.device: SyncHead(at: r.updatedAt, hash: NoteText.hash(r.body))]
        heads[r.id] = h
        record(r.id, h, r.body)
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
        // Nothing in flight any more: a version that came in meanwhile and was stored after
        // ours (it overwrote ours) is ours to rebase onto. One stored before ours (ours
        // overwrote it, they rebase) or a refused put (the winner follows) needs nothing.
        uncertain.remove(id)
        let waiting = inflight[id] == nil ? deferred.removeValue(forKey: id) : nil
        defer {
            if let d = waiting, accepted, seq.map({ (d.seq ?? 0) > $0 }) ?? true { applyRemote(d) }
        }
        guard accepted else { return } // the stored winner follows as a `note` message
        guard var n = repo.note(id) else { return }
        if let seq {
            if seq == repo.lastSeq + 1 { repo.lastSeq = seq }
            if let sent, seq >= (n.seq ?? 0) { n.baseHash = sent.bodyHash }
            n.seq = max(n.seq ?? 0, seq)
        }
        if let sent, n.updatedAt == sent.updatedAt { n.dirty = false }
        if let sent, heads[id] == nil, !n.deleted {
            // sent without heads (unknown): to everyone else it starts the history
            let h: SyncHeads = [device: SyncHead(at: sent.updatedAt, hash: sent.bodyHash)]
            heads[id] = h
            record(id, h, sent.body)
        }
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
        if let h = sentHeads(n) {
            heads[n.id] = h
            record(n.id, h, n.body)
        }
        inflight[n.id, default: []].append(Sent(updatedAt: n.updatedAt, bodyHash: NoteText.hash(n.deleted ? "" : n.body), body: n.deleted ? "" : n.body))
    }

    /// The put for a note.
    func encode(_ n: Note) -> [String: Any] { NoteWire.encode(n, device: device, heads: sentHeads(n)) }

    /// What a version we send contains: what the local text contains, plus itself.
    func sentHeads(_ n: Note) -> SyncHeads? {
        guard !n.deleted, var h = heads[n.id] else { return nil }
        h[device] = SyncHead(at: n.updatedAt, hash: NoteText.hash(n.body))
        return h
    }

    var hasInflight: Bool { !inflight.isEmpty }

    /// Connection lost: nothing is in flight any more, though what was may still reach
    /// the server (see `uncertain`).
    func reset() {
        uncertain.formUnion(inflight.keys)
        inflight.removeAll()
    }

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
           existing.isLive, existing.updatedAt == c.updatedAt,
           TextMerge.edits(from: existing.body, to: copyBody).allSatisfy({ $0.range.length == 0 }) { // only more text: nothing in it is lost
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
        guard !n.dirty, !n.deleted, editBases[n.id] != n.updatedAt, let h = heads[n.id] else { return }
        editBases[n.id] = n.updatedAt
        record(n.id, h, n.body)
    }

    private var editBases: [String: Int64] = [:]

    /// A known text containing exactly what `want` says. (When several Macs edited at
    /// once there may be none: merging two versions into one isn't exact, as merges
    /// don't compose, so nothing is merged then.)
    private func text(_ id: String, containing want: SyncHeads) -> String? {
        versions[id]?.last(where: { $0.heads == want })?.body
    }

    /// What both contain; nil when they disagree about a version.
    static func meet(_ a: SyncHeads, _ b: SyncHeads) -> SyncHeads? {
        var out: SyncHeads = [:]
        for (d, h) in a {
            guard let t = b[d] else { continue }
            if h.at == t.at, h.hash != t.hash { return nil }
            out[d] = h.at <= t.at ? h : t
        }
        return out
    }

    /// What either contains.
    static func join(_ a: SyncHeads, _ b: SyncHeads) -> SyncHeads {
        a.merging(b) { $0.at >= $1.at ? $0 : $1 }
    }

    /// Keeps a text whose content is exactly what `h` says, for merges.
    private func record(_ id: String, _ h: SyncHeads, _ body: String) {
        var list = versions[id, default: []]
        list.removeAll { $0.heads == h }
        list.append((h, body))
        var bytes = 0
        let keep = list.reversed().prefix { v in
            bytes += v.body.utf8.count
            return bytes <= Self.versionBytes
        }.prefix(Self.versionsKept)
        list = Array(keep.reversed())
        if list.isEmpty { list = [(h, body)] }
        versions[id] = list
        versionNotes.removeAll { $0 == id }
        versionNotes.append(id)
        if versionNotes.count > Self.versionNotesKept { versions.removeValue(forKey: versionNotes.removeFirst()) }
    }

    private func merged(local: Note, remote r: Note) -> Note {
        var n = r
        n.remoteHeads = nil
        n.dirty = false
        n.openedAt = local.openedAt
        n.createdAt = min(local.createdAt, r.createdAt)
        return n
    }

    private func sameContent(_ a: Note, _ b: Note) -> Bool {
        a.body == b.body && a.deleted == b.deleted && a.meta == b.meta && a.updatedAt == b.updatedAt && a.createdAt == b.createdAt
    }
}
