package com.charles.bento.core.notes

import com.charles.bento.core.sync.CollectionSync
import com.charles.bento.core.sync.Outgoing
import kotlinx.serialization.json.JsonObject

/**
 * The notes collection for the transport: [SyncEngine] behind [CollectionSync].
 *
 * Threading: like the engine, call it only on the transport's single-threaded
 * dispatcher, and make local edits (repository saves, [SyncEngine.willEdit]) there too.
 * Send each [Outgoing] and call [markSent] before handling the next server message: the
 * put's heads are those of the moment [outgoing] encoded it.
 *
 * The engine's callbacks are the app's hooks: [SyncEngine.onRemoteChange] (refresh the
 * list and the open editor), [SyncEngine.beforeApply] (flush unsaved editor text before
 * a remote version is applied), [SyncEngine.onConflictCopy] (a copy was made or updated).
 */
class NotesCollectionSync(val engine: SyncEngine) : CollectionSync {
    constructor(repo: NoteRepository, device: String) : this(SyncEngine(repo).also { it.device = device })

    override val collection: String = "notes"
    override val needsCollections: Boolean = false

    override val lastSeq: Long get() = engine.repo.lastSeq

    override var device: String
        get() = engine.device
        set(value) {
            engine.device = value
        }

    /** The notes as encoded by [outgoing], until sent. */
    private val pending = HashMap<String, Note>()

    override fun applySnapshot(docs: List<JsonObject>, seq: Long): Boolean =
        engine.applySnapshot(docs.mapNotNull(NoteWire::decode), seq)

    /** `ordered` doesn't matter to notes: a version that must wait does so by its heads. */
    override fun applyRemote(doc: JsonObject, ordered: Boolean) {
        NoteWire.decode(doc)?.let { engine.applyRemote(it) }
    }

    override fun ack(id: String, seq: Long?, accepted: Boolean, version: Long?, ordered: Boolean) {
        engine.ack(id, seq, accepted, version)
    }

    override fun putFailed(id: String, version: Long?) {
        engine.putFailed(id, version)
    }

    override fun outgoing(): List<Outgoing> {
        pending.clear()
        return engine.notesToSend().map { n ->
            pending[n.id] = n
            Outgoing(
                id = n.id,
                doc = engine.encode(n),
                updatedAt = n.updatedAt,
                bodyBytes = if (n.deleted) 0 else SyncEngine.utf8Length(n.body),
                label = NoteText.displayTitle(n.body),
            )
        }
    }

    override fun markSent(out: Outgoing) {
        engine.markSent(noteFor(out))
    }

    override fun markUnsendable(out: Outgoing) {
        engine.markUnsendable(noteFor(out))
    }

    /** The note as it was encoded (else as the put describes it, with the stored local fields). */
    private fun noteFor(out: Outgoing): Note {
        pending[out.id]?.takeIf { it.updatedAt == out.updatedAt }?.let {
            pending.remove(out.id)
            return it
        }
        val stored = engine.repo.note(out.id)
        if (stored != null && stored.updatedAt == out.updatedAt) return stored
        val wire = NoteWire.decode(out.doc) ?: return stored ?: Note(id = out.id, updatedAt = out.updatedAt)
        return wire.copy(remoteHeads = null, remoteOrigin = null, remoteRetired = emptyList(), syncHeads = stored?.syncHeads, dirty = true)
    }

    override fun reset() {
        engine.reset()
    }

    override val hasInflight: Boolean get() = engine.hasInflight
    override val pendingCount: Int get() = engine.pendingCount
    override val blockedCount: Int get() = engine.blockedNotes.size
}
