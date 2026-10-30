package com.charles.bento.core.xcheck

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocSyncEngine
import com.charles.bento.core.fielddoc.FieldDocWire
import com.charles.bento.core.fielddoc.InMemoryFieldDocRepository
import com.charles.bento.core.json.JSONValue
import com.charles.bento.core.todo.newTask
import com.charles.bento.core.todo.setCompleted
import com.charles.bento.core.todo.setLabels
import com.charles.bento.core.todo.setOrder
import com.charles.bento.core.todo.setPriority
import com.charles.bento.core.todo.setTitle
import com.charles.bento.core.xcheck.Vectors.arr
import com.charles.bento.core.xcheck.Vectors.boolOrNull
import com.charles.bento.core.xcheck.Vectors.intValue
import com.charles.bento.core.xcheck.Vectors.obj
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Replays sync sessions recorded from the Mac's TodoSyncEngine (two devices editing the same
 * tasks through a last-writer-wins server, puts delivered late, refused, over WebSocket- and
 * REST-style acks, reconnects, a server rollback) and checks after every step that both
 * devices, the server and the engines' queues are in exactly the state the Mac's were.
 */
class EngineXcheckTest {
    private val wire = FieldDocWire("todos")

    private inner class FakeServer {
        val docs = LinkedHashMap<String, FieldDoc>()
        var seq = 0L

        fun put(d: FieldDoc, device: String): Pair<FieldDoc, Boolean> {
            docs[d.id]?.let { s -> if (d.updatedAt < s.updatedAt) return s to false }
            var n = d.copy()
            seq++
            n.seq = seq
            n.dirty = false
            docs[d.id]?.let { n.createdAt = it.createdAt }
            val encoded = wire.encode(n, device)
            n = wire.decode(JsonObject(encoded + ("seq" to JsonPrimitive(seq))))!!
            docs[d.id] = n
            return n to true
        }

        fun rollback(k: Long) {
            docs.entries.removeAll { (it.value.seq ?: 0) > k }
            seq = k
        }
    }

    private fun docLine(d: FieldDoc): String {
        val clocks = d.clocks.keys.sorted().joinToString(",") { "$it=${d.clocks.getValue(it)}" }
        return "${d.id}|${d.type}|${d.deleted}|c=${d.createdAt}|u=${d.updatedAt}|s=${d.seq ?: "nil"}|dirty=${d.dirty}|dev=${d.device}" +
            "|f=${JSONValue.Obj(d.fields).canonical}|k=$clocks|x=${JSONValue.Obj(d.extra).canonical}\n"
    }

    private fun stateText(devices: List<InMemoryFieldDocRepository>, engines: List<FieldDocSyncEngine>, server: FakeServer): String {
        val sb = StringBuilder()
        for ((i, r) in devices.withIndex()) {
            val e = engines[i]
            sb.append("D$i pending=${e.pendingCount} blocked=${e.blockedCount}\n")
            for (d in r.allDocs.sortedBy { it.id }) sb.append(docLine(d))
            sb.append("inflight=" + e.inflight.keys.sorted().joinToString(";") { "$it:" + e.inflight.getValue(it).joinToString(",") } + "\n")
            sb.append("failed=" + e.failed.keys.sorted().joinToString(";") { "$it:${e.failed.getValue(it)}" } + "\n")
        }
        sb.append("S seq=${server.seq}\n")
        for (id in server.docs.keys.sorted()) sb.append(docLine(server.docs.getValue(id)))
        return sb.toString()
    }

    private fun fnv(s: String): String {
        var h = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
        for (b in s.toByteArray(Charsets.UTF_8)) {
            h = h xor (b.toLong() and 0xff)
            h *= 0x100000001b3L
        }
        return java.lang.Long.toUnsignedString(h, 16)
    }

    @Test fun replaysTheMacsSyncSessionsStepByStep() {
        val traces = Vectors.load("engine").arr
        var steps = 0
        for (trace in traces) {
            val seed = trace.obj["seed"]!!.intValue()
            val server = FakeServer()
            val devices = List(2) { InMemoryFieldDocRepository() }
            val engines = devices.map { FieldDocSyncEngine(it) }
            engines.forEachIndexed { i, e -> e.device = "d$i" }
            val queued = ArrayList<Pair<Int, FieldDoc>>()

            fun deliver(mode: Int) {
                val (dev, doc) = queued.removeAt(0)
                val e = engines[dev]
                if (mode == 3) {
                    e.putFailed(doc.id, doc.updatedAt)
                    return
                }
                val (stored, accepted) = server.put(doc, "d$dev")
                if (mode == 1) e.ack(doc.id, if (accepted) stored.seq else null, accepted)
                else e.ack(doc.id, if (accepted) stored.seq else null, accepted, version = doc.updatedAt)
                if (!accepted) e.applyRemote(stored)
                if (accepted) engines.forEachIndexed { j, o -> if (j != dev) o.applyRemote(stored) }
            }

            fun reconnect(dev: Int) {
                queued.removeAll { it.first == dev }
                engines[dev].reset()
                engines[dev].clearFailed()
                engines[dev].applySnapshot(server.docs.values.toList(), server.docs.keys.toSet())
            }

            for ((step, ev) in trace.obj["events"]!!.arr.withIndex()) {
                val o = ev.obj
                when (o["t"]!!.jsonPrimitive.content) {
                    "edit" -> {
                        val dev = o["dev"]!!.intValue()
                        val id = o["id"]!!.jsonPrimitive.content
                        val op = o["op"]!!.intValue()
                        val clock = o["clock"]!!.jsonPrimitive.long
                        val v = o["v"]!!
                        val d = devices[dev].doc(id) ?: FieldDoc.newTask(title = "", order = 0.0, now = 1).also { it.id = id }
                        if (d.deleted && op != 4) { d.deleted = false; d.updatedAt = clock }
                        when (op) {
                            0 -> d.setTitle(v.jsonPrimitive.content, clock)
                            1 -> d.setPriority(v.intValue(), clock)
                            2 -> d.setCompleted(if (v is JsonNull) null else v.jsonPrimitive.long, clock)
                            3 -> d.setLabels(if (v.boolOrNull() == true) listOf("x") else emptyList(), clock)
                            4 -> d.markDeleted(clock)
                            else -> d.setOrder(v.jsonPrimitive.double, clock)
                        }
                        d.dirty = true
                        devices[dev].save(d, remote = false)
                    }
                    "send" -> {
                        val dev = o["dev"]!!.intValue()
                        val mac = o["docs"]!!.arr.map { it.arr[0].jsonPrimitive.content to it.arr[1].jsonPrimitive.long }
                        val ours = engines[dev].docsToSend()
                        assertEquals(mac.sortedWith(compareBy({ it.second }, { it.first })), ours.map { it.id to it.updatedAt }.sortedWith(compareBy({ it.second }, { it.first })),
                            "seed $seed step $step: docsToSend")
                        for ((id, _) in mac) {
                            val d = ours.first { it.id == id }
                            engines[dev].markSent(d)
                            queued += dev to d
                        }
                    }
                    "deliver" -> deliver(o["mode"]!!.intValue())
                    "reconnect" -> reconnect(o["dev"]!!.intValue())
                    "rollback" -> server.rollback(o["to"]!!.jsonPrimitive.long)
                    else -> error("unknown event")
                }
                val text = stateText(devices, engines, server)
                if (fnv(text) != o["h"]!!.jsonPrimitive.content) {
                    throw AssertionError("seed $seed step $step (${o["t"]}): state differs from the Mac's. Kotlin state:\n$text")
                }
                steps++
            }
            assertEquals(Vectors.str(trace.obj["final"]!!), stateText(devices, engines, server), "seed $seed final state")
        }
        println("engine: ${traces.size} sessions, $steps steps match the Mac exactly")
    }
}
