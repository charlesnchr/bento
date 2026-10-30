package com.charles.bento.notes

import android.content.Context
import com.charles.bento.core.notes.Note
import com.charles.bento.core.notes.NoteImageStore
import com.charles.bento.core.notes.NoteImageSync
import com.charles.bento.core.notes.NoteQueries
import com.charles.bento.core.notes.NoteText
import com.charles.bento.core.notes.NotesCollectionSync
import com.charles.bento.core.notes.SyncEngine
import com.charles.bento.core.notes.ThoughtCapture
import com.charles.bento.core.sync.SyncState
import com.charles.bento.data.NoteStore
import com.charles.bento.settings.Prefs
import com.charles.bento.sync.SyncHub
import com.charles.bento.widget.Widgets
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/**
 * The Notes module: notes in `notes.db`, synced as the `notes` collection with the Mac's
 * engine (ported), edited the way the Mac's NotesController does it: `willEdit` before
 * each edit so concurrent edits merge, a debounced save that never waits more than 1.5 s,
 * pending text flushed before a remote version is applied. Everything that touches the
 * store or the engine runs on the engine thread.
 */
class NotesModule(
    private val context: Context,
    private val prefs: Prefs,
    private val hub: SyncHub,
    http: OkHttpClient,
    private val engineDispatcher: CoroutineDispatcher,
    private val engineScope: CoroutineScope,
) {
    val store = NoteStore(context)
    val sync = NotesCollectionSync(store, prefs.deviceName.value)
    private val engine: SyncEngine get() = sync.engine
    val connection = hub.register(sync)

    /** The notes' images: a local cache, uploaded to and fetched from the server (docs/SYNC_PROTOCOL.md, Images). */
    val images = NoteImageSync(NoteImageStore(java.io.File(context.filesDir, "note-images")), http, hub::endpointNow, engineScope,
                               log = { android.util.Log.i("BentoImages", it) })

    /** Every note incl. tombstones, as of the last change. */
    val notes: StateFlow<List<Note>> = store.notes

    /** A note's stored text changed other than by the editor; `before` is what the store had just before. */
    data class Change(val note: Note, val before: String)

    private val _remote = MutableSharedFlow<Change>(extraBufferCapacity = 1024)
    /** Changes from the server, a widget or a captured thought (the open editor merges them in). */
    val remote: SharedFlow<Change> = _remote

    private val _conflicts = MutableSharedFlow<Pair<Note, String>>(extraBufferCapacity = 8)
    /** A conflicted copy was created or updated (the copy, the original's id). */
    val conflicts: SharedFlow<Pair<Note, String>> = _conflicts

    // the editor's unsaved version (engine thread)
    private var pending: Note? = null
    private var pendingSince = 0L
    private var pendingJob: Job? = null
    // the note a remote version is being applied to, and its text just before
    private var applying: Pair<String, String>? = null

    init {
        engine.onRemoteChange = { n, _ ->
            val before = applying?.takeIf { it.first == n.id }?.second
            if (before != null) applying = null
            _remote.tryEmit(Change(n, before ?: n.body))
            Widgets.refresh(context)
        }
        // typed text reaches the store before a remote version is applied over it
        engine.beforeApply = { id ->
            if (pending?.id == id) flushPending()
            applying = id to store.note(id)?.body.orEmpty()
        }
        engine.onConflictCopy = { copy, original -> _conflicts.tryEmit(copy to original) }
        engineScope.launch { purgeOldTrash() }
        // connected (or polling): images made while offline go up, missing ones are asked for again
        engineScope.launch {
            connection.status.map { it.state == SyncState.Connected || it.state == SyncState.Polling }.distinctUntilChanged()
                .collect { if (it) images.connected() }
        }
    }

    /** Stores images (bytes the server takes) for a note and starts uploading them; their hashes. */
    fun addImages(images: List<ByteArray>): List<String> =
        images.mapNotNull { this.images.store.add(it) }.also { if (it.isNotEmpty()) this.images.uploadPending() }

    suspend fun <T> onEngine(block: () -> T): T = withContext(engineDispatcher) { block() }

    // MARK: Editing

    /** A new note (empty notes aren't synced until they have text). Returns its id. */
    suspend fun create(body: String = ""): String = onEngine {
        flushPending()
        val n = Note(body = body, openedAt = System.currentTimeMillis(), device = sync.device, dirty = body.isNotEmpty())
        store.save(n)
        if (n.dirty) changed()
        n.id
    }

    /**
     * The editor's text changed from `base` (its previous text) to `body`. Kept in memory at
     * once, written within 300 ms (1.5 s at most while typing). When a change from elsewhere
     * landed after `base`, the edit is merged into it, as the editor does with that change;
     * when both touch the same text the typing wins and the other text is kept as a copy.
     */
    fun edited(id: String, base: String, body: String) {
        engineScope.launch {
            val stored = if (pending?.id == id) pending else { flushPending(); store.note(id) }
            stored ?: return@launch
            val text = EditMerge.edit(stored.body, base, body) ?: body.also {
                store.note(id)?.let { n -> engine.preserve(stored.body, n) }
            }
            if (stored.body == text) return@launch
            store.note(id)?.let(engine::willEdit) // the text this edit starts from: what a concurrent edit merges against
            if (pending?.id != id) pendingSince = System.currentTimeMillis()
            pending = stored.copy(body = text, updatedAt = Note.nextUpdate(stored.updatedAt), dirty = true)
            pendingJob?.cancel()
            val wait = minOf(300L, maxOf(0L, 1_500L - (System.currentTimeMillis() - pendingSince)))
            pendingJob = engineScope.launch {
                delay(wait)
                flushPending()
            }
        }
    }

    /** Leaving a note: save now, and drop it if it never had text. */
    fun closed(id: String) {
        engineScope.launch {
            flushPending()
            val n = store.note(id) ?: return@launch
            if (n.seq == null && !n.dirty && n.body.isBlank()) store.remove(id)
        }
    }

    fun opened(id: String) {
        engineScope.launch { store.markOpened(id) }
    }

    /** Port of NotesController.flushPendingSave. Engine thread. */
    private fun flushPending() {
        pendingJob?.cancel()
        pendingJob = null
        val n = pending ?: return
        pending = null
        val stored = store.note(n.id)
        if (stored == null) {
            // removed underneath (shouldn't happen): never drop typed text
            store.save(n.copy(id = Note.newId(), seq = null, baseHash = null))
            changed()
            return
        }
        if (stored.deleted || (stored.updatedAt > n.updatedAt && !stored.dirty)) {
            // replaced remotely before this edit reached the store: keep the text as a conflicted copy
            if (n.body != stored.body) engine.preserve(n.body, stored)
            changed()
            return
        }
        var toSave = n.copy(meta = stored.meta, seq = stored.seq, openedAt = stored.openedAt, baseHash = stored.baseHash, syncHeads = stored.syncHeads)
        if (stored.updatedAt >= n.updatedAt && stored.body != n.body) toSave = toSave.copy(updatedAt = Note.nextUpdate(stored.updatedAt))
        store.save(toSave)
        changed()
    }

    private fun mutate(id: String, change: (Note) -> Note) {
        flushPending()
        val n = store.note(id) ?: return
        store.save(change(n).copy(updatedAt = Note.nextUpdate(n.updatedAt), dirty = true))
        changed()
    }

    private fun changed() {
        hub.localChange(sync.collection)
        Widgets.refresh(context)
    }

    suspend fun togglePin(id: String) = onEngine {
        val maxOrder = NoteQueries.liveNotes(store.allNotes(false)).filter { it.pinned }.maxOfOrNull { it.pinOrder } ?: 0.0
        mutate(id) { n -> if (n.pinned) n.withPinned(false) else n.withPinned(true).withPinOrder(maxOrder + 1) }
    }

    suspend fun trash(id: String) = onEngine { mutate(id) { it.withTrashedAt(System.currentTimeMillis()) } }
    suspend fun restore(id: String) = onEngine { mutate(id) { it.withTrashedAt(null) } }
    suspend fun deletePermanently(id: String) = onEngine { mutate(id) { it.copy(deleted = true, body = "") } }

    /** Recently Deleted keeps notes for 60 days (as on the Mac). */
    private fun purgeOldTrash() {
        val cutoff = System.currentTimeMillis() - 60L * 24 * 3600 * 1000
        NoteQueries.trashedNotes(store.allNotes(false)).filter { (it.trashedAt ?: 0) < cutoff }.forEach { n ->
            mutate(n.id) { it.copy(deleted = true, body = "") }
        }
    }

    /** Changes a note's stored text (widget checklist taps); `change` returns the new text, or null to leave it. */
    suspend fun changeBody(id: String, change: (String) -> String?) = onEngine {
        flushPending()
        val n = store.note(id)?.takeIf { it.isLive } ?: return@onEngine
        val body = change(n.body) ?: return@onEngine
        if (n.body == body) return@onEngine
        engine.willEdit(n)
        store.save(n.copy(body = body, updatedAt = Note.nextUpdate(n.updatedAt), dirty = true))
        changed()
        _remote.tryEmit(Change(store.note(id)!!, n.body)) // an open editor merges it like a change from elsewhere
    }

    // MARK: Thought capture

    /**
     * Appends a dictated thought to the capture note as a "### date time · first words"
     * heading section (the Mac's Capture Thought to Note, whose editor shows it collapsed),
     * creating a "Thoughts" note when none is set or it was deleted. Returns the note's title.
     */
    suspend fun captureThought(noteId: String?, text: String): String? = onEngine {
        val entry = ThoughtCapture.entry(text) ?: return@onEngine null
        flushPending()
        val target = (noteId ?: prefs.thoughtNote.value.ifEmpty { null })?.let { store.note(it) }?.takeIf { it.isLive }
        val base = target ?: Note(body = "# Thoughts", device = sync.device)
        if (target != null) engine.willEdit(target)
        val n = base.copy(body = ThoughtCapture.append(entry, base.body), device = sync.device,
                          updatedAt = Note.nextUpdate(base.updatedAt), dirty = true)
        store.save(n)
        if (target == null) prefs.thoughtNote.value = n.id
        changed()
        _remote.tryEmit(Change(n, target?.body.orEmpty()))
        NoteText.displayTitle(n.body)
    }
}
