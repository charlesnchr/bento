package com.charles.bento.core.fielddoc

import kotlin.math.max

/**
 * The client side of the sync protocol for field-clock documents (transport independent).
 * Exact port of the Mac's `FieldSyncEngine`; the collection only matters to the wire layer.
 *
 * - Every connection (and every poll) fetches the server's full set and reconciles it with
 *   ours ([applySnapshot]); there is no cursor, so a document missed once (unreadable, lost
 *   in a crash) arrives with the next pass instead of never.
 * - `dirty` documents have local changes the server hasn't acknowledged.
 * - [inflight] remembers which versions (updated_at) of a document were sent, oldest first.
 *   Acks arrive in send order on a connection, so each ack pops the version it acknowledges
 *   and only clears `dirty` when that is still the current version.
 * - Remote versions are merged field by field (per-field clocks), so concurrent edits of
 *   different fields on two devices both survive. When the merge differs from what the
 *   server has, the result stays dirty with an `updated_at` the server will accept.
 *
 * Not thread safe: call it from one dispatcher.
 */
class FieldDocSyncEngine(val repo: FieldDocRepository) {
    enum class RemoteResult { INSERTED, OVERWRITTEN, MERGED, KEPT_LOCAL, UNCHANGED }

    /** This client's device name (puts carry it). */
    var device: String = ""

    private val inflightMap = HashMap<String, MutableList<Long>>()
    val inflight: Map<String, List<Long>> get() = inflightMap

    /** Documents the server refused in this version; not resent until edited again. */
    private val failedMap = HashMap<String, Long>()
    val failed: Map<String, Long> get() = failedMap

    /** Called for every document whose stored content changed because of the server. */
    var onRemoteChange: ((FieldDoc, RemoteResult) -> Unit)? = null

    // MARK: Incoming

    fun applyRemote(r: FieldDoc): RemoteResult {
        val local = repo.doc(r.id)
        if (local == null) {
            val d = r.copy(dirty = false)
            repo.save(d, remote = true)
            onRemoteChange?.invoke(d, RemoteResult.INSERTED)
            return RemoteResult.INSERTED
        }
        val result = resolve(local, r)
        if (result.sameContent(local) && result.dirty == local.dirty) {
            if (result.seq != local.seq) repo.save(result, remote = true)
            return if (local.dirty) RemoteResult.KEPT_LOCAL else RemoteResult.UNCHANGED
        }
        repo.save(result, remote = true)
        val ownContent = result.fields == local.fields && result.deleted == local.deleted
        val kind = if (result.dirty) (if (ownContent) RemoteResult.KEPT_LOCAL else RemoteResult.MERGED) else RemoteResult.OVERWRITTEN
        onRemoteChange?.invoke(result, kind)
        return kind
    }

    /**
     * Our version (dirty or not) against a version from the server. Always a merge, even
     * when nothing is pending locally: a stale put that landed after a newer version would
     * otherwise regress fields everywhere; merging heals the server instead.
     */
    private fun resolve(local: FieldDoc, r: FieldDoc): FieldDoc {
        // A version of ours is still unacknowledged: whatever we adopt must outrank it,
        // or the server ends up with the older content we sent.
        val pending = inflightMap[r.id] != null
        fun adopt(x: FieldDoc): FieldDoc {
            val d = x.copy()
            if (d.deleted) d.type = local.type // tombstones carry no body
            d.dirty = false
            return if (pending) outranking(d, x, local) else d
        }
        // Tombstones: a deletion wins over field changes older than it, and loses to newer ones.
        if (r.deleted) {
            // Both deleted: the later deletion stamp wins, so a newer local one is kept and
            // resent (an edit between the two stamps must not resurrect the document).
            if (local.deleted) return if (r.updatedAt >= local.updatedAt) adopt(r) else outranking(local, r, local)
            return if (r.updatedAt >= local.maxClock) adopt(r) else outranking(local, r, local)
        }
        if (local.deleted) {
            return if (r.maxClock > local.updatedAt) adopt(r) else outranking(local, r, local)
        }
        val m = local.merged(r)
        // Nothing of ours is missing from the server's version: take it as is.
        if (m.fields == r.fields && m.clocks == r.clocks) return adopt(r)
        return outranking(m, r, local)
    }

    /**
     * `d` kept dirty with an updated_at the server's LWW rule accepts over `r`. When its
     * content differs from `local`, it is a new version: its stamp must differ from every
     * version already sent, or the ack of an older put would mark it clean.
     */
    private fun outranking(d0: FieldDoc, r: FieldDoc, local: FieldDoc): FieldDoc {
        val d = d0.copy(dirty = true)
        r.seq?.let { s -> if ((d.seq ?: -1) < s) d.seq = s }
        var floor = max(d.maxClock, plusOne(r.updatedAt))
        if (d.fields != local.fields || d.deleted != local.deleted) floor = max(floor, plusOne(local.updatedAt))
        if (d.updatedAt < floor) d.updatedAt = floor
        return d
    }

    private fun plusOne(t: Long) = if (t == Long.MAX_VALUE) Long.MAX_VALUE else t + 1

    /**
     * The server's full set (reply to hello / REST poll): every document is merged into ours,
     * and ours that the server doesn't have (restored from a backup, a new server) are sent
     * again. [ids] names every document the server sent, including any [docs] lacks because
     * its body couldn't be read: those are the server's, never overwritten from here.
     */
    fun applySnapshot(docs: List<FieldDoc>, ids: Set<String>) {
        for (d in repo.allDocs) {
            if (!d.dirty && d.id !in ids) repo.save(d.copy(dirty = true, seq = null), remote = false)
        }
        for (d in docs.sortedBy { it.seq ?: 0 }) applyRemote(d)
    }

    /**
     * An ack for a put. `version` is the updated_at that was sent when the transport knows
     * it (REST); WebSocket acks arrive in send order and pop the oldest version.
     */
    fun ack(id: String, seq: Long?, accepted: Boolean, version: Long? = null) {
        val sent = popInflight(id, version)
        if (!accepted) return // the stored winner follows as a `note` message
        val d = repo.doc(id)?.copy() ?: return
        if (seq != null) d.seq = max(d.seq ?: 0, seq)
        if (sent != null && d.updatedAt == sent) d.dirty = false
        repo.save(d, remote = false)
    }

    /** The server rejected a put with an error (validation, size, id in another collection). */
    fun putFailed(id: String, version: Long? = null) {
        popInflight(id, version)?.let { failedMap[id] = it }
    }

    fun markUnsendable(d: FieldDoc) = markUnsendable(d.id, d.updatedAt)

    fun markUnsendable(id: String, updatedAt: Long) {
        failedMap[id] = updatedAt
    }

    /**
     * New connection: refused documents are tried again (the refusal may have been
     * transient; oversized ones are caught again before sending).
     */
    fun clearFailed() = failedMap.clear()

    val blockedCount: Int
        get() = failedMap.count { (id, v) -> repo.doc(id)?.let { it.dirty && it.updatedAt == v } ?: false }

    private fun popInflight(id: String, version: Long?): Long? {
        val q = inflightMap[id]
        if (q.isNullOrEmpty()) return null
        val i = if (version != null) q.indexOf(version) else -1
        val sent = if (i >= 0) q.removeAt(i) else q.removeAt(0)
        if (q.isEmpty()) inflightMap.remove(id)
        return sent
    }

    // MARK: Outgoing

    /** Dirty documents that aren't already in flight in their current version, oldest change first. */
    fun docsToSend(): List<FieldDoc> = repo.allDocs.filter { d ->
        d.dirty && inflightMap[d.id]?.lastOrNull() != d.updatedAt && failedMap[d.id] != d.updatedAt
    }.sortedBy { it.updatedAt }

    fun markSent(d: FieldDoc) = markSent(d.id, d.updatedAt)

    fun markSent(id: String, updatedAt: Long) {
        inflightMap.getOrPut(id) { mutableListOf() }.add(updatedAt)
    }

    val hasInflight: Boolean get() = inflightMap.isNotEmpty()

    /** Connection lost: nothing is in flight any more. */
    fun reset() = inflightMap.clear()

    val pendingCount: Int get() = repo.allDocs.count { it.dirty }
}
