import Foundation

/// The client side of the sync protocol for todo documents (transport independent).
///
/// - `dirty` documents have local changes the server hasn't acknowledged.
/// - `inflight` remembers which versions (updated_at) of a document were sent, oldest
///   first. Acks arrive in send order on a connection, so each ack pops the version it
///   acknowledges and only clears `dirty` when that is still the current version.
/// - Remote versions are merged field by field (per-field clocks), so concurrent edits
///   of different fields on two devices both survive. When the merge differs from what
///   the server has, the result stays dirty with an `updated_at` the server will accept.
final class TodoSyncEngine {
    enum RemoteResult: Equatable { case inserted, overwritten, merged, keptLocal, unchanged }

    let repo: TodoRepository
    /// This client's device name (puts carry it).
    var device = ""
    private(set) var inflight: [String: [Int64]] = [:]
    /// Documents the server refused in this version; not resent until edited again.
    private(set) var failed: [String: Int64] = [:]

    /// Called for every document whose stored content changed because of the server.
    var onRemoteChange: ((TodoDoc, RemoteResult) -> Void)?

    init(repo: TodoRepository) { self.repo = repo }

    // MARK: Incoming

    @discardableResult
    func applyRemote(_ r: TodoDoc) -> RemoteResult {
        if let s = r.seq, s > repo.lastSeq { repo.lastSeq = s }
        guard let local = repo.doc(r.id) else {
            var d = r
            d.dirty = false
            repo.save(d, remote: true)
            onRemoteChange?(d, .inserted)
            return .inserted
        }
        let result = resolve(local: local, remote: r)
        if result.sameContent(local), result.dirty == local.dirty {
            if result.seq != local.seq { repo.save(result, remote: true) }
            return local.dirty ? .keptLocal : .unchanged
        }
        repo.save(result, remote: true)
        let ownContent = result.fields == local.fields && result.deleted == local.deleted
        let kind: RemoteResult = result.dirty ? (ownContent ? .keptLocal : .merged) : .overwritten
        onRemoteChange?(result, kind)
        return kind
    }

    /// Our version (dirty or not) against a version from the server. Always a merge, even
    /// when nothing is pending locally: a stale put that landed after a newer version
    /// would otherwise regress fields everywhere; merging heals the server instead.
    private func resolve(local: TodoDoc, remote r: TodoDoc) -> TodoDoc {
        // A version of ours is still unacknowledged: whatever we adopt must outrank it,
        // or the server ends up with the older content we sent.
        let pending = inflight[r.id] != nil
        func adopt(_ r: TodoDoc) -> TodoDoc {
            var d = r
            if d.deleted { d.type = local.type } // tombstones carry no body
            d.dirty = false
            return pending ? outranking(d, r, local: local) : d
        }
        // Tombstones: a deletion wins over field changes older than it, and loses to newer ones.
        if r.deleted {
            return local.deleted || r.updatedAt >= local.maxClock ? adopt(r) : outranking(local, r, local: local)
        }
        if local.deleted {
            return r.maxClock > local.updatedAt ? adopt(r) : outranking(local, r, local: local)
        }
        let m = local.merged(with: r)
        // Nothing of ours is missing from the server's version: take it as is.
        if m.fields == r.fields, m.clocks == r.clocks { return adopt(r) }
        return outranking(m, r, local: local)
    }

    /// `d` kept dirty with an updated_at the server's LWW rule accepts over `r`. When its
    /// content differs from `local`, it is a new version: its stamp must differ from every
    /// version already sent, or the ack of an older put would mark it clean.
    private func outranking(_ d: TodoDoc, _ r: TodoDoc, local: TodoDoc) -> TodoDoc {
        var d = d
        d.dirty = true
        if let s = r.seq, (d.seq ?? -1) < s { d.seq = s }
        var floor = max(d.maxClock, r.updatedAt == .max ? .max : r.updatedAt + 1)
        if d.fields != local.fields || d.deleted != local.deleted {
            floor = max(floor, local.updatedAt == .max ? .max : local.updatedAt + 1)
        }
        if d.updatedAt < floor { d.updatedAt = floor }
        return d
    }

    /// Applies a snapshot (reply to hello / REST poll). Returns true when the server's seq
    /// went backwards (backup restore) and a full resync is needed.
    @discardableResult
    func applySnapshot(_ docs: [TodoDoc], seq: Int64) -> Bool {
        if seq < repo.lastSeq {
            // Everything the server lost must be resent.
            for var d in repo.allDocs where (d.seq ?? 0) > seq || d.seq == nil {
                d.dirty = true
                d.seq = nil
                repo.save(d, remote: false)
            }
            repo.lastSeq = 0
            return true
        }
        for d in docs.sorted(by: { ($0.seq ?? 0) < ($1.seq ?? 0) }) { applyRemote(d) }
        if seq > repo.lastSeq { repo.lastSeq = seq }
        return false
    }

    /// An ack for a put. `version` is the updated_at that was sent when the transport
    /// knows it (REST); WebSocket acks arrive in send order and pop the oldest version.
    /// `ordered`: the server sent every earlier change of our collections before this ack
    /// (WebSocket), so last_seq may jump to it over other collections' seqs.
    func ack(id: String, seq: Int64?, accepted: Bool, version: Int64? = nil, ordered: Bool = false) {
        let sent = popInflight(id, version: version)
        guard accepted else { return } // the stored winner follows as a `note` message
        guard var d = repo.doc(id) else { return }
        if let seq {
            if seq == repo.lastSeq + 1 || (ordered && seq > repo.lastSeq) { repo.lastSeq = seq }
            d.seq = max(d.seq ?? 0, seq)
        }
        if let sent, d.updatedAt == sent { d.dirty = false }
        repo.save(d, remote: false)
    }

    /// The server rejected a put with an error (validation, size, id in another collection).
    func putFailed(id: String, version: Int64? = nil) {
        if let sent = popInflight(id, version: version) { failed[id] = sent }
    }

    func markUnsendable(_ d: TodoDoc) { failed[d.id] = d.updatedAt }

    /// New connection: refused documents are tried again (the refusal may have been transient;
    /// oversized ones are caught again before sending).
    func clearFailed() { failed.removeAll() }

    var blockedCount: Int {
        failed.filter { id, v in repo.doc(id).map { $0.dirty && $0.updatedAt == v } ?? false }.count
    }

    private func popInflight(_ id: String, version: Int64?) -> Int64? {
        guard var q = inflight[id], !q.isEmpty else { return nil }
        let sent: Int64
        if let version, let i = q.firstIndex(of: version) {
            sent = q.remove(at: i)
        } else {
            sent = q.removeFirst()
        }
        inflight[id] = q.isEmpty ? nil : q
        return sent
    }

    // MARK: Outgoing

    /// Dirty documents that aren't already in flight in their current version.
    func docsToSend() -> [TodoDoc] {
        repo.allDocs.filter { d in
            d.dirty && inflight[d.id]?.last != d.updatedAt && failed[d.id] != d.updatedAt
        }.sorted { $0.updatedAt < $1.updatedAt }
    }

    func markSent(_ d: TodoDoc) { inflight[d.id, default: []].append(d.updatedAt) }

    var hasInflight: Bool { !inflight.isEmpty }

    /// Connection lost: nothing is in flight any more.
    func reset() { inflight.removeAll() }

    var pendingCount: Int { repo.allDocs.filter(\.dirty).count }
}
