package com.charles.bento.core.notes

import com.charles.bento.core.json.JSONValue
import com.charles.bento.core.json.compareCodePoints
import com.charles.bento.core.json.wireBool
import com.charles.bento.core.json.wireLong
import com.charles.bento.core.json.wireString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.max
import kotlin.math.min

/** Wire format conversions for the sync protocol's note object. */
object NoteWire {
    /**
     * JSON object for a client put (no `seq`). `origin`: this install's id; `heads`: which
     * versions of each device's text it contains (null: unknown, e.g. right after a
     * relaunch).
     */
    fun encode(n: Note, device: String, origin: String? = null, heads: SyncHeads? = null, retired: Set<String> = emptySet()): JsonObject {
        val meta = LinkedHashMap(n.meta)
        meta.remove(BASE_KEY)
        if (origin != null && !n.deleted) {
            // Tied to this version's updated_at: an older client that edits the note keeps
            // the key but not the timestamp, so a stale base is never trusted.
            val base = LinkedHashMap<String, JSONValue>()
            base["at"] = JSONValue.Number(n.updatedAt.toDouble())
            base["from"] = JSONValue.Str(origin)
            if (retired.isNotEmpty()) base["retired"] = JSONValue.Arr(retired.sortedWith(::compareCodePoints).take(8).map { JSONValue.Str(it) })
            if (heads != null) {
                base["heads"] = JSONValue.Obj(heads.mapValues { (_, h) ->
                    JSONValue.Arr(listOf(JSONValue.Number(h.at.toDouble()), JSONValue.Str(h.hash.toString(16))))
                })
            }
            meta[BASE_KEY] = JSONValue.Obj(base)
        }
        return buildJsonObject {
            put("id", n.id)
            put("body", if (n.deleted) "" else n.body)
            put("created_at", n.createdAt)
            put("updated_at", n.updatedAt)
            put("deleted", n.deleted)
            put("device", device)
            put("meta", JSONValue.encodeObject(meta))
        }
    }

    /**
     * `meta` key saying which device sent a version and which versions of each device's
     * text it contains.
     */
    const val BASE_KEY = "base"

    fun decode(obj: JsonElement?): Note? {
        val d = obj as? JsonObject ?: return null
        val id = d.wireString("id")
        if (id.isNullOrEmpty()) return null
        val updated = d.wireLong("updated_at") ?: return null
        val deleted = d.wireBool("deleted") ?: false
        var meta: Map<String, JSONValue> = JSONValue.objectOf(d["meta"])
        val b = meta[BASE_KEY]
        meta = meta - BASE_KEY
        var remoteOrigin: String? = null
        var remoteRetired: List<String> = emptyList()
        var remoteHeads: SyncHeads? = null
        if (b is JSONValue.Obj && b.fields["at"]?.double == updated.toDouble()) {
            val base = b.fields
            (base["from"] as? JSONValue.Str)?.value?.takeIf { it.isNotEmpty() }?.let { remoteOrigin = it }
            (base["retired"] as? JSONValue.Arr)?.let { ids -> remoteRetired = ids.items.take(8).mapNotNull { (it as? JSONValue.Str)?.value } }
            val heads = base["heads"]
            if (heads is JSONValue.Obj && heads.fields.size <= 64) {
                var out = LinkedHashMap<String, SyncHead>()
                for ((mac, v) in heads.fields) {
                    val a = (v as? JSONValue.Arr)?.items
                    val at = if (a != null && a.size == 2) a[0].double?.let(Note::int64) else null
                    val hash = if (a != null && a.size == 2) (a[1] as? JSONValue.Str)?.value?.let(::parseHex64) else null
                    if (at == null || hash == null) {
                        out = LinkedHashMap()
                        break
                    }
                    out[mac] = SyncHead(at, hash)
                }
                if (out.isNotEmpty()) remoteHeads = out
            }
        }
        return Note(
            id = id,
            body = if (deleted) "" else d.wireString("body") ?: "",
            createdAt = d.wireLong("created_at") ?: updated,
            updatedAt = updated,
            deleted = deleted,
            seq = d.wireLong("seq"),
            device = d.wireString("device") ?: "",
            meta = meta,
            remoteHeads = remoteHeads,
            remoteOrigin = remoteOrigin,
            remoteRetired = remoteRetired,
        )
    }
}

/**
 * The client side of the sync protocol's state machine (transport independent); a port of
 * the Mac's SyncEngine.swift.
 *
 * - `dirty` notes have local changes the server hasn't acknowledged.
 * - `inflight` remembers which versions (updated_at) of a note were sent, oldest first.
 *   Acks arrive in send order on a connection, so each ack pops the version it
 *   acknowledges and only clears `dirty` when that is still the current version.
 * - Concurrent text edits are merged like Google Docs. Every put says which version of
 *   each device's text it contains (`meta.base`: per device, that device's `updated_at`
 *   and body hash, like a version vector). Exactly one side merges a pair of concurrent
 *   versions: the one whose version the server doesn't have (overwritten by the other,
 *   or refused) rebases onto the server's and sends the result, which the other side
 *   takes as a fast-forward. A remote version arriving while a put of ours is in flight
 *   waits for that put's ack, which tells which of the two the server kept. The merge
 *   base is a known text containing exactly what both contain; when there is none (or
 *   two devices did merge each other's versions), nothing is merged. Heads are stored
 *   with the note; the base texts are in memory only.
 * - Otherwise remote notes are applied with last-writer-wins on `updated_at`. When a real
 *   concurrent edit would be overwritten (both sides changed the body since the last
 *   version they share, and the changes overlap or can't be merged), the losing body is
 *   kept as a "conflicted copy" note, so no edit is ever silently lost.
 *
 * Not thread safe: call it (and change the repository) on one thread.
 *
 * Differences from the Swift code, all deliberate: bodies, meta strings and notes compare
 * as exact UTF-16 where Swift's `==` is canonical equivalence (both texts are kept as
 * sent); where Swift's result follows dictionary order (random per process) the order is
 * fixed: ties in `sentHeads` keep the smaller install id, `notesToSend` orders equal
 * `updated_at`s by id, and of several identical conflicted copies the one with the
 * smallest id is the twin a new copy is compared with.
 */
class SyncEngine(val repo: NoteRepository) {
    enum class RemoteResult {
        Inserted, Overwritten, Adopted, KeptLocal, Unchanged,
        /** Remote text merged with a local meta-only change, or remote meta with local text. */
        Merged,
    }

    data class Sent(
        val updatedAt: Long,
        val bodyHash: ULong,
        val body: String,
        val meta: Map<String, JSONValue>,
        /** The install id it was sent under. */
        val origin: String,
    )

    /** This client's device name (puts carry it; notes from it are our own echoes). */
    var device = ""
    private val inflightMap = LinkedHashMap<String, MutableList<Sent>>()
    val inflight: Map<String, List<Sent>> get() = inflightMap
    /** Notes the server refused (e.g. too large); not resent until edited again. */
    private val failedMap = LinkedHashMap<String, Long>()
    val failed: Map<String, Long> get() = failedMap
    /** Notes re-sent after the server lost them (seq regression): their base is unknown. */
    private val resyncing = HashSet<String>()

    /**
     * Conflicted copies made this session, by "<note id>|<losing device>", so a burst of
     * concurrent typing updates one copy instead of creating dozens.
     */
    private val conflictCopies = HashMap<String, CopyRecord>()
    private class CopyRecord(val id: String, val updatedAt: Long, val created: Long)

    /**
     * Recent versions of each note whose text is exactly what their heads say (sent or
     * received, never one with unsent typing), oldest first: the bases of merges.
     */
    private val versions = HashMap<String, MutableList<Version>>()
    private class Version(val heads: SyncHeads, val body: String, val meta: Map<String, JSONValue>)
    /** Notes with versions, least recently used first. */
    private val versionNotes = ArrayList<String>()

    /**
     * A concurrent remote version that arrived while a put of ours was in flight. Kept in
     * memory only, so `lastSeq` stays below it until it's resolved: after a crash the next
     * hello fetches it again.
     */
    private val deferred = HashMap<String, Note>()
    /** The highest seq applied (`repo.lastSeq` is held below deferred versions). */
    private var seenSeq: Long? = null
    /**
     * Notes whose put was in flight when the connection dropped: it may still reach the
     * server, so they wait like an in-flight put until the resent version's ack.
     */
    private val uncertain = HashSet<String>()

    /** Called for every note whose stored content changed because of the server. */
    var onRemoteChange: ((Note, RemoteResult) -> Unit)? = null
    /** Called before a remote note is applied (lets the editor flush unsaved edits). */
    var beforeApply: ((String) -> Unit)? = null
    /** Called after a conflicted copy was created or updated (the copy, the original's id). */
    var onConflictCopy: ((Note, String) -> Unit)? = null
    /** The server lost what we sent (restored from a backup, or a new one): its images are checked too. */
    var onServerReset: (() -> Unit)? = null

    // MARK: Incoming

    fun applyRemote(incoming: Note): RemoteResult {
        var r = incoming
        r.seq?.let { advanceSeq(it) }
        // another device uses our id (a copied database), or found that and retired it
        if (r.remoteOrigin == installID && r.device.isNotEmpty() && r.device != device || r.remoteRetired.contains(installID)) {
            installIDCollision()
        }
        val fromNewClient = r.remoteOrigin != null
        val retired = repo.retiredInstallIDs
        if (retired.isNotEmpty()) {
            // history naming an id two devices shared can't be trusted: no merge from it
            if (r.remoteHeads?.keys?.any { it in retired } == true) r = r.copy(remoteHeads = null)
            if (r.remoteOrigin?.let { it in retired } == true) r = r.copy(remoteOrigin = null)
        }
        beforeApply?.invoke(r.id)
        val local = repo.note(r.id)
        if (local == null) {
            val n = r.copy(remoteHeads = null, remoteOrigin = null, dirty = false, openedAt = 0, baseHash = NoteText.hash(r.body))
            repo.save(n)
            adoptHeads(r)
            onRemoteChange?.invoke(n, RemoteResult.Inserted)
            dedupeConflictCopy(n)
            return RemoteResult.Inserted
        }
        val wasResyncing = resyncing.remove(r.id)
        if (!wasResyncing) threeWay(local, r)?.let { return it }
        try {
            if (local.dirty) {
                if (wasResyncing) return applyAfterRestore(local, r)
                // A version from another device that this local edit was not based on.
                val elsewhere = r.remoteOrigin?.let { it != installID } ?: (r.device != device)
                val concurrent = (r.seq ?: 0) > (local.seq ?: 0) && elsewhere && r.body != local.body
                // deleting counts as changing the text (a tombstone never takes their text)
                val localBodyChanged = local.deleted || (local.baseHash?.let { it != NoteText.hash(local.body) } ?: true)
                val remoteBodyChanged = local.baseHash?.let { it != NoteText.hash(r.body) } ?: true
                if (r.updatedAt > local.updatedAt) {
                    if (concurrent && localBodyChanged && !remoteBodyChanged && !r.deleted) {
                        // They only changed meta (pin, trash…), we changed the text: keep both,
                        // and of the meta what each changed (all theirs when we can't tell).
                        val n = local.copy(
                            meta = baseMeta(local)?.let { mergeMeta(it, local.meta, r.meta, remoteNewer = true) } ?: r.meta,
                            seq = r.seq,
                            updatedAt = Note.nextUpdate(r.updatedAt, local.updatedAt),
                            dirty = true,
                        )
                        repo.save(n)
                        onRemoteChange?.invoke(n, RemoteResult.Merged)
                        return RemoteResult.Merged
                    }
                    if (concurrent && localBodyChanged && !local.deleted) {
                        conflictCopy(local.body, device, local)
                    }
                    return adopt(local, r)
                }
                // Ours is newer and will be (re)sent.
                var n: Note = local
                if (concurrent && remoteBodyChanged && !r.deleted) {
                    if (!localBodyChanged) {
                        // We only changed meta, they changed the text: take their text (and
                        // their meta changes, when we can tell them from ours).
                        n = n.copy(body = r.body)
                        baseMeta(local)?.let { b -> n = n.copy(meta = mergeMeta(b, local.meta, r.meta, remoteNewer = false)) }
                        n = n.copy(updatedAt = Note.nextUpdate(local.updatedAt), seq = r.seq, baseHash = NoteText.hash(r.body))
                        repo.save(n)
                        onRemoteChange?.invoke(n, RemoteResult.Merged)
                        return RemoteResult.Merged
                    }
                    conflictCopy(r.body, r.device, local)
                    n = n.copy(baseHash = NoteText.hash(r.body)) // their version is preserved; ours supersedes it
                    // ...so ours accounts for theirs: they replace theirs with ours, no second copy
                    val mine = local.syncHeads
                    val theirs = r.remoteHeads
                    if (mine != null && theirs != null) n = n.copy(syncHeads = join(mine, theirs))
                }
                // Remember the server's seq so the same version isn't treated as unseen again.
                val s = r.seq
                if (s != null && (local.seq ?: -1) < s) n = n.copy(seq = s)
                if (n != local) repo.save(n)
                return RemoteResult.KeptLocal
            }
            if (fromNewClient && r.remoteHeads == null && local.syncHeads != null && !r.deleted && !local.deleted &&
                TextMerge.edits(local.body, r.body).any { it.range.length > 0 }
            ) {
                // A version that can't say what it contains (its device lost its history)
                // would remove text from our synced one, whose history we know: it may never
                // have had it, keep ours. (Without history on both sides, e.g. right after
                // upgrading, it's an ordinary edit.)
                conflictCopy(local.body, device, local)
            }
            val n = merged(local, r).copy(baseHash = NoteText.hash(r.body))
            if (sameContent(local, n)) {
                if (local.seq != n.seq || local.baseHash != n.baseHash) repo.save(n)
                return RemoteResult.Unchanged
            }
            repo.save(n)
            onRemoteChange?.invoke(n, RemoteResult.Overwritten)
            return RemoteResult.Overwritten
        } finally {
            settle(local, r)
        }
    }

    /**
     * The server lost our version (restored backup) and now sends what it has, usually an
     * older version: plain last-writer-wins, keeping our text if theirs wins.
     */
    private fun applyAfterRestore(local: Note, r: Note): RemoteResult {
        if (r.updatedAt > local.updatedAt) {
            if (r.body != local.body && !local.deleted) conflictCopy(local.body, device, local)
            return adopt(local, r)
        }
        val n = local.copy(seq = r.seq, baseHash = NoteText.hash(r.body))
        if (n != local) repo.save(n)
        return RemoteResult.KeptLocal
    }

    /**
     * A remote text edit that says what it contains. null when that doesn't apply (no
     * heads on either side, deletes) and last-writer-wins decides as before.
     */
    private fun threeWay(local: Note, r: Note): RemoteResult? {
        val theirs = r.remoteHeads ?: return null
        if (r.deleted || local.deleted) return null
        record(r.id, theirs, r.body, r.meta)
        if (r.body == local.body) return null // heads settle afterwards
        val rs = r.seq
        val ls = local.seq
        if (rs != null && ls != null && rs <= ls) return RemoteResult.Unchanged // older than what we have
        // what the local text contains (sent, adopted or merged; unsent typing on top)
        val mine = local.syncHeads ?: return null
        if (!local.dirty) uncertain.remove(r.id) // nothing of ours left to resend
        if ((inflightMap[r.id]?.isNotEmpty() == true || uncertain.contains(r.id)) && theirs[installID] != mine[installID]) {
            // Our put is on its way and theirs was made without it: the server will keep ours
            // (then they rebase onto it) or refuse it (then we rebase onto theirs). Its ack
            // decides.
            if ((deferred[r.id]?.seq ?: -1) < (r.seq ?: 0)) deferred[r.id] = r
            storeSeq()
            return RemoteResult.KeptLocal
        }
        // The server's latest version: merge from exactly what both contain.
        val common = meet(mine, theirs)
        val base = common?.let { version(r.id, it) }
        val body = base?.let { TextMerge.merge(it.body, local.body, r.body) }
        if (common == null || base == null || body == null) return fallBack(local, r, mine, theirs)
        // pin, trash…: per key, what changed here since the base stays
        val meta = mergeMeta(base.meta, local.meta, r.meta, remoteNewer = r.updatedAt > local.updatedAt)
        if (body == r.body && meta == r.meta) {
            // all of ours is in theirs: a fast-forward
            if (!local.dirty) return null
            val result = adopt(local, r)
            adoptHeads(r)
            return result
        }
        return keepMerged(local, r, theirs, body, meta)
    }

    /**
     * Can't merge: last-writer-wins. When theirs is about to replace ours and lacks some of
     * what ours contains (by the heads), ours is kept as a conflicted copy first.
     */
    private fun fallBack(local: Note, r: Note, mine: SyncHeads?, theirs: SyncHeads): RemoteResult? {
        val theirsHasOurs = mine?.let { join(it, theirs) == theirs } ?: false
        if (!theirsHasOurs && (!local.dirty || r.updatedAt > local.updatedAt)) {
            conflictCopy(local.body, device, local)
        }
        return null
    }

    /**
     * Stores a text that includes the remote version as a new local version (it goes to
     * the server, which only has theirs).
     */
    private fun keepMerged(local: Note, r: Note, theirs: SyncHeads, body: String, meta: Map<String, JSONValue>): RemoteResult {
        var n = local.copy(body = body, meta = meta)
        val s = r.seq
        if (s != null && (local.seq ?: -1) < s) n = n.copy(seq = s)
        if (body != local.body || n.meta != local.meta || !local.dirty || local.updatedAt <= r.updatedAt) {
            n = n.copy(updatedAt = Note.nextUpdate(r.updatedAt, local.updatedAt))
        }
        n = n.copy(dirty = true, baseHash = NoteText.hash(r.body), syncHeads = join(local.syncHeads ?: emptyMap(), theirs))
        repo.save(n)
        if (body != local.body || n.meta != local.meta) onRemoteChange?.invoke(n, RemoteResult.Merged)
        return if (body == local.body) RemoteResult.KeptLocal else RemoteResult.Merged
    }

    /**
     * After last-writer-wins: when our text was replaced by theirs, so were our heads; the
     * same text from both contains what either says.
     */
    private fun settle(local: Note, r: Note) {
        val now = repo.note(r.id) ?: return
        if (now.body != r.body) return
        if (local.body != r.body || now.syncHeads == null) {
            adoptHeads(r)
        } else {
            val mine = now.syncHeads
            val theirs = r.remoteHeads
            if (theirs != null && !r.deleted) setHeads(r.id, join(mine, theirs))
        }
    }

    /**
     * The local text is now exactly `r`'s. A version that doesn't say what it contains
     * (older client, or sent right after a relaunch) counts as the start of the history.
     */
    private fun adoptHeads(r: Note) {
        if (r.deleted) {
            setHeads(r.id, null)
            return
        }
        val h = r.remoteHeads ?: mapOf((r.remoteOrigin ?: r.device) to SyncHead(r.updatedAt, NoteText.hash(r.body)))
        setHeads(r.id, h)
        record(r.id, h, r.body, r.meta)
    }

    private fun setHeads(id: String, h: SyncHeads?) {
        val n = repo.note(id) ?: return
        if (n.syncHeads == h) return
        repo.save(n.copy(syncHeads = h))
    }

    private fun adopt(local: Note, r: Note): RemoteResult {
        val n = merged(local, r).copy(baseHash = NoteText.hash(r.body))
        repo.save(n)
        onRemoteChange?.invoke(n, RemoteResult.Adopted)
        return RemoteResult.Adopted
    }

    /**
     * Applies a snapshot (reply to hello). Returns true when the server's seq went
     * backwards (backup restore) and a full resync is needed.
     */
    fun applySnapshot(notes: List<Note>, seq: Long): Boolean {
        if (seq < (seenSeq ?: repo.lastSeq)) {
            // Server restored from a backup: everything we have that it lost must be resent.
            onServerReset?.invoke()
            for (n in repo.allNotes(includeTombstones = true)) {
                if (!((n.seq ?: 0) > seq || n.seq == null)) continue
                if (n.seq == null && !n.dirty && !n.deleted && n.body.isEmpty()) continue // blank, never synced
                // Our base is gone from the server: forget it, so what it sends back is
                // never mistaken for a newer concurrent edit.
                repo.save(n.copy(dirty = true, seq = null, baseHash = null))
                resyncing.add(n.id)
            }
            seenSeq = 0
            repo.lastSeq = 0
            return true
        }
        for (n in notes.sortedBy { it.seq ?: 0 }) applyRemote(n)
        advanceSeq(seq)
        return false
    }

    /**
     * An ack for a put. `version` is the updated_at that was sent when the transport knows
     * it (REST); WebSocket acks arrive in send order and pop the oldest version.
     */
    fun ack(id: String, seq: Long?, accepted: Boolean, version: Long? = null) {
        val sent = popInflight(id, version)
        // Nothing in flight any more: a version that came in meanwhile and was stored after
        // ours (it overwrote ours) is ours to rebase onto. One stored before ours (ours
        // overwrote it, they rebase) or a refused put (the winner follows) needs nothing.
        uncertain.remove(id)
        val waiting = if (inflightMap[id] == null) deferred.remove(id) else null
        try {
            if (!accepted) return // the stored winner follows as a `note` message
            var n = repo.note(id) ?: return
            if (seq != null) {
                if (seq == (seenSeq ?: repo.lastSeq) + 1) advanceSeq(seq)
                if (sent != null && seq >= (n.seq ?: 0)) n = n.copy(baseHash = sent.bodyHash)
                n = n.copy(seq = max(n.seq ?: 0, seq))
            }
            if (sent != null && n.updatedAt == sent.updatedAt) n = n.copy(dirty = false)
            if (sent != null && n.syncHeads == null && !n.deleted && inflightMap[id] == null && sent.origin == installID) {
                // sent without heads (unknown): to everyone else it starts the history (only
                // the last one sent: an earlier one would describe less than our text holds)
                val h: SyncHeads = mapOf(installID to SyncHead(sent.updatedAt, sent.bodyHash))
                n = n.copy(syncHeads = h)
                record(id, h, sent.body, sent.meta)
            }
            resyncing.remove(id)
            repo.save(n)
        } finally {
            if (waiting != null && accepted && (seq?.let { (waiting.seq ?: 0) > it } ?: true)) applyRemote(waiting)
            storeSeq()
        }
    }

    /** The server rejected a put with an error (validation, size). */
    fun putFailed(id: String, version: Long? = null) {
        popInflight(id, version)?.let { failedMap[id] = it.updatedAt }
        // the server kept theirs: a version that waited for this put is ours to merge onto
        if (inflightMap[id] == null) {
            val d = deferred.remove(id)
            if (d != null) {
                uncertain.remove(id)
                applyRemote(d)
            }
        }
        storeSeq()
    }

    /** The note can't be sent (too large to ever be accepted): park it until edited again. */
    fun markUnsendable(n: Note) {
        failedMap[n.id] = n.updatedAt
        // it won't be resent, so nothing will resolve a version waiting for it
        uncertain.remove(n.id)
        if (inflightMap[n.id] == null) deferred.remove(n.id)?.let { applyRemote(it) }
        storeSeq()
    }

    /** Dirty notes the server refused in their current version (kept locally, not resent). */
    val blockedNotes: List<Note>
        get() = failedMap.mapNotNull { (id, v) -> repo.note(id)?.takeIf { it.dirty && it.updatedAt == v } }

    private fun popInflight(id: String, version: Long?): Sent? {
        val q = inflightMap[id]
        if (q == null || q.isEmpty()) return null
        val i = if (version != null) q.indexOfFirst { it.updatedAt == version } else -1
        val sent = if (i >= 0) q.removeAt(i) else q.removeAt(0)
        if (q.isEmpty()) inflightMap.remove(id)
        return sent
    }

    /**
     * Another device sends with our install id (a copied database): our history may mix
     * both devices' versions. Take a new id, retire the old and forget all heads, so
     * nothing is merged from that history (last-writer-wins with conflicted copies until
     * new history arrives).
     */
    private fun installIDCollision() {
        repo.renewInstallID()
        for (n in repo.allNotes(includeTombstones = true)) {
            if (n.syncHeads != null) repo.save(n.copy(syncHeads = null))
        }
        versions.clear()
        versionNotes.clear()
    }

    // MARK: Outgoing

    /** Dirty notes that aren't already in flight in their current version, oldest change first. */
    fun notesToSend(): List<Note> =
        repo.allNotes(includeTombstones = true).filter { n ->
            n.dirty && inflightMap[n.id]?.lastOrNull()?.updatedAt != n.updatedAt && failedMap[n.id] != n.updatedAt
        }.sortedWith(compareBy<Note> { it.updatedAt }.thenComparator { a, b -> compareCodePoints(a.id, b.id) })

    fun markSent(n: Note) {
        sentHeads(n)?.let { h ->
            setHeads(n.id, h)
            record(n.id, h, n.body, n.meta)
        }
        val body = if (n.deleted) "" else n.body
        inflightMap.getOrPut(n.id) { mutableListOf() }.add(Sent(n.updatedAt, NoteText.hash(body), body, n.meta, installID))
    }

    /** The put for a note. */
    fun encode(n: Note): JsonObject = NoteWire.encode(n, device, origin = installID, heads = sentHeads(n), retired = repo.retiredInstallIDs)

    /**
     * What a version we send contains: what the local text contains, plus itself (the
     * devices edited longest ago left out past `HEADS_SENT`: then nothing older is merged).
     */
    fun sentHeads(n: Note): SyncHeads? {
        if (n.deleted) return null
        val known = repo.note(n.id)?.syncHeads ?: n.syncHeads ?: return null
        var h: SyncHeads = known + (installID to SyncHead(n.updatedAt, NoteText.hash(n.body)))
        if (h.size > HEADS_SENT) {
            val keep = h.entries
                .sortedWith(compareByDescending<Map.Entry<String, SyncHead>> { it.value.at }.thenComparator { a, b -> compareCodePoints(a.key, b.key) })
                .take(HEADS_SENT).map { it.key }.toSet()
            h = h.filterKeys { it in keep || it == installID }
        }
        return h
    }

    /** This install's id (sync history names devices by it). */
    val installID: String get() = repo.installID

    val hasInflight: Boolean get() = inflightMap.isNotEmpty()

    /**
     * Connection lost: nothing is in flight any more, though what was may still reach the
     * server (see `uncertain`).
     */
    fun reset() {
        uncertain.addAll(inflightMap.keys)
        inflightMap.clear()
    }

    val pendingCount: Int get() = repo.allNotes(includeTombstones = true).count { it.dirty }

    // MARK: Conflicts

    /** Keeps text that can't be applied to its note any more as a conflicted copy. */
    fun preserve(body: String, original: Note) {
        conflictCopy(body, device, original)
    }

    /**
     * Two devices kept the same text as a copy of the same note: the one with the smaller
     * id stays (both devices pick the same), the other is deleted.
     */
    private fun dedupeConflictCopy(n: Note) {
        val of = n.meta["conflictOf"] ?: return
        if (!n.isLive) return
        val twin = repo.allNotes(includeTombstones = false)
            .filter { it.id != n.id && it.isLive && it.meta["conflictOf"] == of && it.body == n.body }
            .minWithOrNull { a, b -> compareCodePoints(a.id, b.id) } ?: return
        val extra = if (compareCodePoints(n.id, twin.id) < 0) twin else n
        val tomb = extra.copy(deleted = true, body = "", updatedAt = Note.nextUpdate(extra.updatedAt), dirty = true)
        repo.save(tomb)
        onRemoteChange?.invoke(tomb, RemoteResult.Overwritten)
    }

    /** Keeps a body that lost a last-writer-wins race as its own note (synced like any edit). */
    private fun conflictCopy(body: String, loser: String, original: Note) {
        val copyBody = NoteText.conflictCopyBody(body, loser) ?: return
        // already kept (e.g. the other device's copy of the same text arrived first)
        val of = JSONValue.Str(original.id)
        if (repo.allNotes(includeTombstones = false).any { it.isLive && it.meta["conflictOf"] == of && it.body == copyBody }) return
        val key = original.id + "|" + loser
        val now = Note.now()
        val c = conflictCopies[key]
        if (c != null && now - c.created < 10 * 60_000) {
            val existing = repo.note(c.id)
            if (existing != null && existing.isLive && existing.updatedAt == c.updatedAt &&
                TextMerge.edits(existing.body, copyBody).all { it.range.length == 0 } // only more text: nothing in it is lost
            ) {
                if (existing.body == copyBody) return
                val updated = existing.copy(body = copyBody, updatedAt = Note.nextUpdate(existing.updatedAt), dirty = true)
                repo.save(updated)
                conflictCopies[key] = CopyRecord(updated.id, updated.updatedAt, c.created)
                onConflictCopy?.invoke(updated, original.id)
                return
            }
        }
        val n = Note(body = copyBody, createdAt = now).copy(device = device, dirty = true, meta = mapOf("conflictOf" to of))
        repo.save(n)
        conflictCopies[key] = CopyRecord(n.id, n.updatedAt, now)
        onConflictCopy?.invoke(n, original.id)
    }

    // MARK: Helpers

    /** The local note is about to be edited: keep its text, the base of the edit. */
    fun willEdit(n: Note) {
        // keystrokes before the debounced save all see the same stored version
        if (n.dirty || n.deleted || editBases[n.id] == n.updatedAt) return
        val h = n.syncHeads ?: return
        editBases[n.id] = n.updatedAt
        record(n.id, h, n.body, n.meta)
    }

    private val editBases = HashMap<String, Long>()

    /**
     * A known text containing exactly what `want` says. (When several devices edited at
     * once there may be none: merging two versions into one isn't exact, as merges don't
     * compose, so nothing is merged then.)
     */
    private fun version(id: String, want: SyncHeads): Version? = versions[id]?.lastOrNull { it.heads == want }

    /** The meta of the text the local version was made from, when known. */
    private fun baseMeta(local: Note): Map<String, JSONValue>? = local.syncHeads?.let { version(local.id, it)?.meta }

    /** Records a seq as applied; `repo.lastSeq` follows, held below any deferred version. */
    private fun advanceSeq(s: Long) {
        seenSeq = max(seenSeq ?: repo.lastSeq, s)
        storeSeq()
    }

    private fun storeSeq() {
        val seen = seenSeq ?: repo.lastSeq
        val held = deferred.values.mapNotNull { it.seq }.minOrNull()?.let { min(seen, it - 1) } ?: seen
        if (repo.lastSeq != held) repo.lastSeq = held
    }

    /** Keeps a text whose content is exactly what `h` says, for merges. */
    private fun record(id: String, h: SyncHeads, body: String, meta: Map<String, JSONValue>) {
        val list = versions[id]?.toMutableList() ?: mutableListOf()
        list.removeAll { it.heads == h }
        list.add(Version(h, body, meta))
        // the newest that fit in VERSION_BYTES, at most VERSIONS_KEPT
        var bytes = 0
        val keep = ArrayList<Version>()
        for (v in list.asReversed()) {
            bytes += utf8Length(v.body)
            if (bytes > VERSION_BYTES || keep.size == VERSIONS_KEPT) break
            keep.add(v)
        }
        keep.reverse()
        if (keep.isEmpty()) keep.add(Version(h, body, meta))
        versions[id] = keep
        versionNotes.remove(id)
        versionNotes.add(id)
        if (versionNotes.size > VERSION_NOTES_KEPT) versions.remove(versionNotes.removeAt(0))
    }

    private fun merged(local: Note, r: Note): Note = r.copy(
        remoteHeads = null,
        remoteOrigin = null,
        syncHeads = local.syncHeads, // settled by the caller
        dirty = false,
        openedAt = local.openedAt,
        createdAt = min(local.createdAt, r.createdAt),
    )

    private fun sameContent(a: Note, b: Note): Boolean =
        a.body == b.body && a.deleted == b.deleted && a.meta == b.meta && a.updatedAt == b.updatedAt && a.createdAt == b.createdAt

    companion object {
        private const val VERSIONS_KEPT = 64
        private const val VERSION_BYTES = 1 shl 20
        private const val VERSION_NOTES_KEPT = 16
        /** Most devices a put names (newest first), well inside the server's meta limit. */
        const val HEADS_SENT = 16

        /**
         * Meta merged key by key: what changed here since the base stays, the rest is
         * theirs (both changed one: the newer note's).
         */
        fun mergeMeta(base: Map<String, JSONValue>, local: Map<String, JSONValue>, remote: Map<String, JSONValue>, remoteNewer: Boolean): Map<String, JSONValue> {
            val out = LinkedHashMap<String, JSONValue>()
            for (k in base.keys + local.keys + remote.keys) {
                val ours = local[k] != base[k]
                val theirs = remote[k] != base[k]
                val v = if (ours && (!theirs || !remoteNewer)) local[k] else remote[k]
                if (v != null) out[k] = v
            }
            if (out["pinned"] == null) out.remove("pinOrder") // as Note.withPinned does
            return out
        }

        /** What both contain; null when they disagree about a version. */
        fun meet(a: SyncHeads, b: SyncHeads): SyncHeads? {
            val out = LinkedHashMap<String, SyncHead>()
            for ((d, h) in a) {
                val t = b[d] ?: continue
                if (h.at == t.at && h.hash != t.hash) return null
                out[d] = if (h.at <= t.at) h else t
            }
            return out
        }

        /** What either contains. */
        fun join(a: SyncHeads, b: SyncHeads): SyncHeads {
            val out = LinkedHashMap(a)
            for ((k, v) in b) {
                val x = out[k]
                out[k] = if (x == null || x.at < v.at) v else x
            }
            return out
        }

        internal fun utf8Length(s: String): Int {
            var n = 0
            var i = 0
            while (i < s.length) {
                val c = s[i]
                n += when {
                    c.code < 0x80 -> 1
                    c.code < 0x800 -> 2
                    Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> { i++; 4 }
                    else -> 3
                }
                i++
            }
            return n
        }
    }
}
