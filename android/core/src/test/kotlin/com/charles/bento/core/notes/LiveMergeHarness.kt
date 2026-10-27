package com.charles.bento.core.notes

import com.charles.bento.core.json.wireLong
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.min

// The live-editing harness of Tests/NotesTests/SyncTests.swift (LiveMergeTests): devices
// with an engine and a repository, a step-by-step server, and Swift's random number
// generation, so the fuzz replays the Mac's runs exactly.

fun remote(id: String, body: String, updated: Long, seq: Long, deleted: Boolean = false): Note =
    Note(id = id, body = if (deleted) "" else body, createdAt = 1, updatedAt = updated, seq = seq, deleted = deleted)

fun local(id: String, body: String, updated: Long, dirty: Boolean, seq: Long? = null): Note =
    Note(id = id, body = body, createdAt = 1, updatedAt = updated, dirty = dirty, seq = seq)

/** One device: its engine and repository, with note "a" synced at seq 1. */
class Mac(
    val name: String,
    body: String,
    installID: String = InMemoryNoteRepository.newInstallID(),
    makeInstallID: () -> String = InMemoryNoteRepository::newInstallID,
) {
    val repo = InMemoryNoteRepository(installID, makeInstallID)
    var e = SyncEngine(repo)
        private set
    val changes = mutableListOf<SyncEngine.RemoteResult>()
    var caret: Int
    private var shown: String

    init {
        e.device = name
        e.applyRemote(remote("a", body, updated = 100, seq = 1).copy(device = "x")) // the note as it came from the server
        caret = body.length
        shown = body
        e.onRemoteChange = { _, r -> changes.add(r) }
    }

    /** Quit or crash and start again: only what's in the repository survives. */
    fun relaunch() {
        e = SyncEngine(repo)
        e.device = name
        e.onRemoteChange = { _, r -> changes.add(r) }
    }

    /** A meta-only change (pin, trash, delete), as NotesController.mutate makes it. */
    fun mutate(change: (Note) -> Note) {
        val n = change(note)
        repo.save(n.copy(updatedAt = Note.nextUpdate(n.updatedAt), dirty = true))
    }

    /** The server refused this version for good (e.g. too large): edit it again. */
    fun touchBlocked() {
        if (e.blockedNotes.any { it.id == "a" }) mutate { it }
    }

    val note: Note get() = repo.notes.getValue("a")
    val copies: List<Note> get() = repo.notes.values.filter { it.meta["conflictOf"] != null }

    /** What NotesController.editorChanged + flushPendingSave do. */
    fun type(edit: (String) -> String) {
        val n = note
        e.willEdit(n)
        repo.save(n.copy(body = edit(n.body), updatedAt = Note.nextUpdate(n.updatedAt), dirty = true))
    }

    /**
     * Types at the caret (or at `elsewhere`, clamped), optionally deleting the character
     * before it first; the caret ends after the typing.
     */
    fun typeAtCaret(text: String, elsewhere: Int?, backspace: Boolean) {
        followCaret()
        type { body ->
            val s = StringBuilder(body)
            var at = min(elsewhere ?: caret, s.length)
            if (backspace && at > 0) {
                s.deleteCharAt(at - 1)
                at -= 1
            }
            s.insert(at, text)
            caret = at + text.length
            s.toString()
        }
        shown = note.body
    }

    /** What the editor does when the note changes underneath (TextMerge.map). */
    fun followCaret() {
        val body = note.body
        if (body == shown) return
        caret = TextMerge.map(TextRange(min(caret, shown.length), 0), TextMerge.edits(shown, body)).location
        shown = body
    }

    fun put(): JsonObject? {
        val n = e.notesToSend().firstOrNull { it.id == "a" } ?: return null // copies are other notes
        e.markSent(n)
        return e.encode(n)
    }

    fun receive(obj: JsonObject) {
        e.applyRemote(NoteWire.decode(obj)!!)
    }
}

fun withSeq(doc: JsonObject, seq: Long): JsonObject = JsonObject(doc + ("seq" to JsonPrimitive(seq)))

/** bento-sync's rule: accept iff updated_at >= stored; broadcast to the others first. */
class Server(body: String) {
    var stored: JsonObject = initialDoc(body)
    var seq = 1L

    fun sync(macs: List<Mac>, rounds: Int = 8) {
        repeat(rounds) {
            // every device sends what it has before hearing from the others (concurrent puts)
            val puts = macs.mapNotNull { m -> m.put()?.let { m to it } }
            if (puts.isEmpty()) return
            for ((m, p) in puts) {
                val accepted = p.wireLong("updated_at")!! >= stored.wireLong("updated_at")!!
                if (accepted) {
                    seq++
                    stored = withSeq(p, seq)
                    for (o in macs) if (o !== m) o.receive(stored)
                }
                m.e.ack("a", stored.wireLong("seq")!!, accepted)
                if (!accepted) m.receive(stored)
            }
        }
    }
}

fun initialDoc(body: String): JsonObject = buildJsonObject {
    put("id", "a")
    put("body", body)
    put("created_at", 1)
    put("updated_at", 100)
    put("seq", 1)
    put("device", "x")
    put("meta", JsonObject(emptyMap()))
}

/**
 * bento-sync over WebSockets, step by step: puts wait at the server and are handled one
 * at a time; every connection is a FIFO (so a broadcast with a lower seq always arrives
 * before an ack); a reconnect drops the old connection's queue, and a put it left at the
 * server comes back to the new connection as a broadcast.
 */
class Network(val macs: List<Mac>, body: String) {
    sealed class Message {
        data class Doc(val doc: JsonObject) : Message()
        data class Ack(val seq: Long, val ok: Boolean) : Message()
        data object Error : Message()
    }

    data class Put(val mac: Int, val conn: Int, val put: JsonObject)

    var stored: JsonObject = initialDoc(body)
    var seq = 1L
    val inbox = ArrayDeque<Put>()
    val queues: List<ArrayDeque<Message>> = macs.map { ArrayDeque() }
    val conns = IntArray(macs.size)
    /** Runs before every settle round (the fuzz advances its clock). */
    var tick: () -> Unit = {}

    fun send(i: Int) {
        macs[i].put()?.let { inbox.addLast(Put(i, conns[i], it)) }
    }

    /**
     * Handles the next put. `refuse`: as if it lost last-writer-wins; `fail`: an error
     * reply (validation, size); `lose`: it never arrives.
     */
    fun serve(refuse: Boolean = false, fail: Boolean = false, lose: Boolean = false) {
        val (i, conn, p) = inbox.removeFirstOrNull() ?: return
        if (lose) return
        if (fail) {
            if (conns[i] == conn) queues[i].addLast(Message.Error)
            return
        }
        val accepted = !refuse && p.wireLong("updated_at")!! >= stored.wireLong("updated_at")!!
        if (accepted) {
            seq++
            stored = withSeq(p, seq)
            for (j in macs.indices) if (!(j == i && conns[j] == conn)) queues[j].addLast(Message.Doc(stored))
        }
        if (conns[i] != conn) return // that connection is gone: no ack
        queues[i].addLast(Message.Ack(seq, accepted))
        if (!accepted) queues[i].addLast(Message.Doc(stored))
    }

    fun deliver(i: Int) {
        when (val m = queues[i].removeFirstOrNull() ?: return) {
            is Message.Doc -> macs[i].receive(m.doc)
            is Message.Ack -> macs[i].e.ack("a", if (m.ok) m.seq else null, m.ok)
            Message.Error -> macs[i].e.putFailed("a")
        }
        macs[i].followCaret()
    }

    /** A quit or crash and a fresh start, then a new connection. */
    fun relaunch(i: Int) {
        macs[i].relaunch()
        reconnect(i)
    }

    fun reconnect(i: Int) {
        conns[i]++
        queues[i].clear()
        macs[i].e.reset()
        val s = stored.wireLong("seq")!!
        macs[i].e.applySnapshot(if (s > macs[i].repo.lastSeq) listOf(NoteWire.decode(stored)!!) else emptyList(), seq)
        macs[i].followCaret()
    }

    val quiet: Boolean
        get() = inbox.isEmpty() && queues.all { it.isEmpty() } && macs.all { m -> m.e.notesToSend().all { it.id != "a" } }

    /** Lets everything settle without typing; false if it never goes quiet. */
    fun settle(steps: Int = 300): Boolean {
        repeat(steps) {
            tick()
            macs.forEach { it.touchBlocked() }
            if (quiet) return true
            for (i in macs.indices) send(i)
            while (inbox.isNotEmpty()) serve()
            for (i in macs.indices) while (queues[i].isNotEmpty()) deliver(i)
        }
        return quiet
    }
}

/** Swift's `RandomNumberGenerator` algorithms over the tests' generator. */
class SeededRNG(var state: ULong, private val rotate: Boolean = true) {
    /** LiveMergeTests' generator (rotated); `rotate = false` is CommandFuzz's plain LCG. */
    fun next(): ULong {
        state = state * 6364136223846793005UL + 1442695040888963407UL
        return if (rotate) (state shr 11) or (state shl 53) else state
    }

    /** `randomElement(using:)`. */
    fun <T> pick(items: List<T>): T = items[int(0, items.size)]

    /** `next(upperBound:)`: Lemire's nearly divisionless method. */
    private fun next(upperBound: ULong): ULong {
        var random = next()
        var high = Math.unsignedMultiplyHigh(random.toLong(), upperBound.toLong()).toULong()
        var low = random * upperBound
        if (low < upperBound) {
            val t = (0UL - upperBound) % upperBound
            while (low < t) {
                random = next()
                high = Math.unsignedMultiplyHigh(random.toLong(), upperBound.toLong()).toULong()
                low = random * upperBound
            }
        }
        return high
    }

    /** `Int.random(in: lo..<hi)`. */
    fun int(lo: Int, hiExclusive: Int): Int = lo + next((hiExclusive - lo).toULong()).toInt()

    /** `Int.random(in: lo...hi)`. */
    fun intClosed(lo: Int, hi: Int): Int = lo + next((hi - lo + 1).toULong()).toInt()

    fun bool(): Boolean = (next() shr 17) and 1UL == 0UL
}

enum class Fuzz { insertOnly, withDeletes, threeMacs, sameName, metaAndRelaunch, sharedInstallID }

class FuzzRun(
    val macs: List<Mac>,
    val net: Network,
    val start: String,
    val typed: Set<Char>,
    val deleted: Boolean,
    val quiet: Boolean,
    val putWhileQuiet: Boolean,
    val actions: List<Int>,
)

/**
 * LiveMergeTests.fuzz with the deterministic clock and ids the Mac's vectors were made
 * with (xcheck/notes/Fuzz.swift): two devices (or three) typing, mostly at their caret,
 * also after sending a put and before the other's arrives; random delivery delays and
 * reconnects; then quiet.
 */
fun runFuzz(seed: Int, kind: Fuzz): FuzzRun {
    var counter = 0
    fun nextID(): String {
        counter++
        return "ID-%06d".format(counter)
    }
    var clock = 1_800_000_000_000L
    Note.clock = { clock }
    Note.idSource = ::nextID
    try {
        val rng = SeededRNG(seed.toULong() * 0x9E3779B97F4A7C15UL + 1UL)
        val start = "# Notes\nfirst line\n\nsecond line\n"
        val names = when (kind) {
            Fuzz.threeMacs -> listOf("A", "B", "C")
            Fuzz.sameName -> listOf("MacBook Pro", "MacBook Pro")
            else -> listOf("A", "B")
        }
        val macs = names.mapIndexed { i, name -> Mac(name, start, "install-$i") { "install-" + nextID() } }
        if (kind == Fuzz.sharedInstallID) macs[1].repo.installID = macs[0].repo.installID // a copied database
        val net = Network(macs, start)
        net.tick = { clock += 1 }
        var next = 0x4E00 // every typed character is unique (CJK block)
        val typed = HashSet<Char>()
        var deleted = false
        val actions = ArrayList<Int>()
        for (step in 0 until 120) {
            clock += step % 4
            val i = rng.int(0, macs.size)
            val extra = kind == Fuzz.metaAndRelaunch
            val action = rng.int(0, 1000)
            actions.add(i * 1000 + action)
            when {
                action < 350 -> {
                    val m = macs[i]
                    if (!m.note.deleted) {
                        val run = (0 until rng.intClosed(1, 3)).map {
                            next++
                            next.toChar()
                        }
                        typed.addAll(run)
                        val elsewhere = rng.int(0, 10) == 0
                        val backspace = kind == Fuzz.withDeletes && rng.int(0, 4) == 0
                        m.typeAtCaret(run.joinToString(""), if (elsewhere) rng.intClosed(0, 1000) else null, backspace)
                    }
                }
                action < 550 -> net.send(i)
                action < 680 -> net.serve()
                action < 690 -> net.serve(refuse = true)
                action < 700 -> net.serve(fail = true)
                action < 960 -> net.deliver(i)
                extra && action < 975 -> macs[i].mutate { it.withPinned(!it.pinned) }
                extra && action < 985 -> macs[i].mutate { n ->
                    n.copy(meta = if (n.meta["trashedAt"] == null) n.meta + ("trashedAt" to com.charles.bento.core.json.JSONValue.Number(Note.now().toDouble())) else n.meta - "trashedAt")
                }
                extra && action < 990 -> net.relaunch(i)
                extra && action < 991 -> {
                    deleted = true
                    macs[i].mutate { it.copy(deleted = true, body = "") }
                }
                else -> net.reconnect(i)
            }
        }
        val quiet = net.settle()
        var putWhileQuiet = false
        repeat(30) {
            for (i in macs.indices) net.send(i)
            if (net.inbox.isNotEmpty()) putWhileQuiet = true
            net.serve()
        }
        return FuzzRun(macs, net, start, typed, deleted, quiet, putWhileQuiet, actions)
    } finally {
        Note.clock = null
        Note.idSource = null
    }
}
