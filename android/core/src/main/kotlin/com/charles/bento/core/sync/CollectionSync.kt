package com.charles.bento.core.sync

import kotlinx.serialization.json.JsonObject

/**
 * One collection's sync engine as the transport ([SyncConnection]) sees it: the notes
 * engine, the todo engine and the voice engine each implement it. The transport is
 * protocol plumbing (hello, snapshot, put, ack, REST fallback); everything about
 * documents, merges and `last_seq` lives behind this interface.
 *
 * Not thread safe: the transport calls it only on its own single-threaded dispatcher,
 * and the app makes local changes on the same one.
 */
interface CollectionSync {
    /** Wire collection name (`notes`, `todos`, `voice`). */
    val collection: String

    /** Whether hello must name the collection and the server must report `collections`. */
    val needsCollections: Boolean get() = collection != "notes"

    /**
     * Where hello and polls start: the highest server seq applied for notes (held below
     * deferred versions), 0 for field-doc collections, which fetch the full set every time.
     */
    val lastSeq: Long

    /** This device's name, carried by puts. */
    var device: String

    /** Reply to hello / REST poll. True when the server's seq went backwards and a full resync from 0 is needed. */
    fun applySnapshot(docs: List<JsonObject>, seq: Long): Boolean

    /**
     * A document from the server. `ordered`: every earlier change was delivered first
     * (WebSocket, polls); false for a REST put's stored winner.
     */
    fun applyRemote(doc: JsonObject, ordered: Boolean = true)

    /** An ack for a put. `version`: the updated_at that was sent, when the transport knows it (REST). */
    fun ack(id: String, seq: Long?, accepted: Boolean, version: Long? = null, ordered: Boolean = false)

    /** The server refused a put (validation, size, id in another collection). */
    fun putFailed(id: String, version: Long? = null)

    /** Documents to put now, oldest change first. */
    fun outgoing(): List<Outgoing>

    /** The put went out. */
    fun markSent(out: Outgoing)

    /** The put can never be accepted (too large): park it until edited again. */
    fun markUnsendable(out: Outgoing)

    /** A new connection is about to say hello (Todo retries refused puts on every connection). */
    fun connectionOpened() {}

    /** Connection lost: nothing is in flight any more. */
    fun reset()

    val hasInflight: Boolean
    val pendingCount: Int
    val blockedCount: Int
}

/** A put the engine wants to send: the wire document plus what the transport needs to know about it. */
data class Outgoing(
    val id: String,
    /** The document as sent (`id`, `body`, `created_at`, `updated_at`, `deleted`, `device`, `meta`, `collection`). */
    val doc: JsonObject,
    val updatedAt: Long,
    /** UTF-8 bytes of the body, for the size limits. */
    val bodyBytes: Int,
    /** Human label for errors ("Shopping list"). */
    val label: String,
)

/** Server limits, see server/src/store.rs. */
object SyncLimits {
    const val MAX_BODY_BYTES = 1024 * 1024
    const val MAX_MESSAGE_BYTES = 3 * 1024 * 1024
    const val MAX_META_BYTES = 4 * 1024
}
