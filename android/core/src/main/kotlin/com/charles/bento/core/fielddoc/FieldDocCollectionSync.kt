package com.charles.bento.core.fielddoc

import com.charles.bento.core.sync.CollectionSync
import com.charles.bento.core.sync.Outgoing
import kotlinx.serialization.json.JsonObject

/**
 * [CollectionSync] for a field-doc collection (`todos`, `voice`): what the generic transport
 * drives. Mirrors how the Mac's FieldSyncClient uses its engine: hello and polls always ask
 * for the full set (`lastSeq` is 0), which the engine reconciles, and every new connection
 * clears refused puts so they get another try.
 */
class FieldDocCollectionSync(
    override val collection: String,
    val engine: FieldDocSyncEngine,
    /** Human label for errors ("Buy milk"): what a document is called in the UI. */
    private val label: (FieldDoc) -> String,
) : CollectionSync {
    constructor(collection: String, repo: FieldDocRepository, label: (FieldDoc) -> String) :
        this(collection, FieldDocSyncEngine(repo), label)

    val wire = FieldDocWire(collection)

    /** No cursor: every hello and poll fetches the full set. */
    override val lastSeq: Long get() = 0

    override var device: String
        get() = engine.device
        set(value) { engine.device = value }

    /** Never asks for a resync: the snapshot is already the full set. */
    override fun applySnapshot(docs: List<JsonObject>, seq: Long): Boolean {
        engine.applySnapshot(docs.mapNotNull(wire::decode), docs.mapNotNull { wire.id(it) }.toSet())
        return false
    }

    override fun applyRemote(doc: JsonObject, ordered: Boolean) {
        wire.decode(doc)?.let { engine.applyRemote(it) }
    }

    override fun ack(id: String, seq: Long?, accepted: Boolean, version: Long?, ordered: Boolean) =
        engine.ack(id, seq, accepted, version)

    override fun putFailed(id: String, version: Long?) = engine.putFailed(id, version)

    override fun outgoing(): List<Outgoing> = engine.docsToSend().map { d ->
        val body = d.body
        Outgoing(
            id = d.id,
            doc = wire.encode(d, device, body),
            updatedAt = d.updatedAt,
            bodyBytes = if (d.deleted) 0 else utf8Length(body),
            label = label(d),
        )
    }

    override fun markSent(out: Outgoing) = engine.markSent(out.id, out.updatedAt)

    override fun markUnsendable(out: Outgoing) = engine.markUnsendable(out.id, out.updatedAt)

    override fun connectionOpened() = engine.clearFailed()

    override fun reset() = engine.reset()

    override val hasInflight: Boolean get() = engine.hasInflight
    override val pendingCount: Int get() = engine.pendingCount
    override val blockedCount: Int get() = engine.blockedCount

    companion object {
        /** The Mac's label rule: the title (or name), "Untitled" when empty, at most 40 Characters. */
        fun shortLabel(text: String): String {
            if (text.isEmpty()) return "Untitled"
            val b = SwiftText.characterBoundaries(text)
            return if (b.size - 1 <= 40) text else text.substring(0, b[40])
        }

        fun utf8Length(s: String): Int {
            var n = 0
            var i = 0
            while (i < s.length) {
                val c = s[i]
                when {
                    c.code < 0x80 -> n += 1
                    c.code < 0x800 -> n += 2
                    Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> { n += 4; i++ }
                    else -> n += 3
                }
                i++
            }
            return n
        }
    }
}
