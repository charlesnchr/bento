package com.charles.bento.core.notes

import com.charles.bento.core.json.compareCodePoints
import java.util.UUID

/**
 * Storage the sync engine works against (the app's SQLite store, or an in-memory one in
 * tests). Not thread safe: the engine and the app use it on one thread.
 *
 * Notes to keep when implementing it (what the Mac's NoteStore does):
 * - `save` replaces the note with the same id; `note`/`allNotes` return what was saved
 *   (local-only fields included; `remoteHeads`/`remoteOrigin`/`remoteRetired` need not be
 *   persisted).
 * - Store `syncHeads` with the hash of the body they describe ([SyncHeadsCodec]) and drop
 *   them on load when the body no longer matches (an older build edited the note).
 * - `baseHash` is a full 64-bit value (store its bit pattern, e.g. `toLong()`).
 * - The Mac drops NUL characters from bodies when saving (SQLite C strings); do the same
 *   so both hold the same text.
 * - `installID`: a random uppercase UUID, stable across launches, tied to this device
 *   (a database restored onto another device must get a new one there).
 */
interface NoteRepository {
    fun note(id: String): Note?
    fun save(note: Note)
    /** Highest server seq applied (`last_seq`). */
    var lastSeq: Long
    fun allNotes(includeTombstones: Boolean): List<Note>
    /**
     * Random id of this install, stable across launches: names this device in sync
     * history (device names can repeat).
     */
    val installID: String
    /**
     * Another device turned out to use the same id (a copied database): pick a new one
     * and retire the old, whose history mixes both devices.
     */
    fun renewInstallID()
    /** Ids retired that way: history naming them isn't trusted. */
    val retiredInstallIDs: Set<String>
}

/** In-memory repository (tests, previews). Notes keep their insertion order. */
open class InMemoryNoteRepository(
    installID: String = newInstallID(),
    private val makeInstallID: () -> String = ::newInstallID,
) : NoteRepository {
    val notes = LinkedHashMap<String, Note>()
    override var lastSeq: Long = 0
    override var installID: String = installID
    override var retiredInstallIDs: Set<String> = emptySet()

    override fun renewInstallID() {
        retiredInstallIDs = retiredInstallIDs + installID
        installID = makeInstallID()
    }

    override fun note(id: String): Note? = notes[id]
    override fun save(note: Note) {
        notes[note.id] = note
    }

    override fun allNotes(includeTombstones: Boolean): List<Note> = notes.values.filter { includeTombstones || !it.deleted }

    companion object {
        fun newInstallID(): String = UUID.randomUUID().toString().uppercase()
    }
}

/** The notes list queries of the Mac's NoteStore. */
object NoteQueries {
    /** Live notes: pinned first (by pin order), then by last opened, newest first. */
    fun liveNotes(notes: Collection<Note>): List<Note> = notes.filter { it.isLive }.sortedWith(listOrder)

    /** Recently Deleted, most recently trashed first. */
    fun trashedNotes(notes: Collection<Note>): List<Note> =
        notes.filter { !it.deleted && it.isTrashed }.sortedWith(compareByDescending<Note> { it.trashedAt ?: 0 }.thenComparator { a, b -> compareCodePoints(a.id, b.id) })

    /**
     * The list order (NoteStore.listOrder); notes the Mac's order leaves tied (dictionary
     * order there) are ordered by id.
     */
    val listOrder: Comparator<Note> = Comparator { a, b ->
        if (a.pinned != b.pinned) return@Comparator if (a.pinned) -1 else 1
        if (a.pinned && a.pinOrder != b.pinOrder) return@Comparator a.pinOrder.compareTo(b.pinOrder)
        if (!a.pinned) {
            val ka = maxOf(a.openedAt, a.createdAt)
            val kb = maxOf(b.openedAt, b.createdAt)
            if (ka != kb) return@Comparator kb.compareTo(ka)
            if (a.updatedAt != b.updatedAt) return@Comparator b.updatedAt.compareTo(a.updatedAt)
        }
        compareCodePoints(a.id, b.id)
    }
}
