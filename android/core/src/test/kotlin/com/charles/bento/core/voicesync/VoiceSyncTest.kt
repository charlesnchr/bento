package com.charles.bento.core.voicesync

import com.charles.bento.core.fielddoc.FakeServer
import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocSyncEngine
import com.charles.bento.core.fielddoc.FieldDocWire
import com.charles.bento.core.fielddoc.InMemoryFieldDocRepository
import com.charles.bento.core.json.JSONValue
import com.charles.bento.core.todo.newTask
import kotlinx.serialization.json.Json
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The `voice` collection on the generic field-doc engine. */
class VoiceSyncTest {
    private var ms = 1_761_000_000_000L

    @BeforeTest fun clock() {
        FieldDoc.clock = { ms++ }
    }

    @AfterTest fun restoreClock() {
        FieldDoc.clock = { System.currentTimeMillis() }
    }

    private val voiceWire = FieldDocWire(VOICE_COLLECTION)
    private val todoWire = FieldDocWire("todos")

    @Test fun wireRejectsOtherCollections() {
        val entry = FieldDoc.newEntry("Kubernetes", "cooper netties")
        val task = FieldDoc.newTask("t", order = 1.0)
        assertNull(todoWire.decode(voiceWire.encode(entry, "pixel")))
        assertNull(voiceWire.decode(todoWire.encode(task, "pixel")))
        val back = voiceWire.decode(voiceWire.encode(entry, "pixel"))!!
        assertEquals("Kubernetes", back.term)
        assertEquals("cooper netties", back.misspelling)
        assertTrue(back.isEntry)
        // notes and old servers' documents aren't ours either
        assertNull(voiceWire.decode(Json.parseToJsonElement("""{"id":"x","updated_at":1,"body":"# a note","collection":"notes"}""")))
        assertNull(voiceWire.decode(Json.parseToJsonElement("""{"id":"x","updated_at":1,"deleted":true}""")))
    }

    @Test fun bodyMatchesTheTodoFormat() {
        val e = FieldDoc.newEntry("gRPC", now = 1000)
        e.id = "6F1C2D3E-0000-0000-0000-000000000000"
        assertEquals(
            """{"clocks":{"created_at":1000,"misspelling":1000,"starred":1000,"term":1000},"fields":{"created_at":1000,"misspelling":null,"starred":false,"term":"gRPC"},"type":"entry"}""",
            e.body,
        )
        assertEquals(e.id.uppercase(), e.id)
        assertTrue(FieldDoc.newEntry("x").id.matches(Regex("[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}")))
    }

    @Test fun unknownFieldsAndTypesArePreserved() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val text = """{"id":"M1","updated_at":5,"seq":1,"collection":"voice","body":"{\"type\":\"preset\",\"fields\":{\"x\":[1,2]},\"clocks\":{\"x\":5},\"v\":2}"}"""
        e.applyRemote(voiceWire.decode(Json.parseToJsonElement(text))!!)
        val d = repo.doc("M1")!!
        assertEquals("preset", d.type)
        assertEquals(JSONValue.Arr(listOf(JSONValue.Number(1.0), JSONValue.Number(2.0))), d.fields["x"])
        assertEquals(mapOf("v" to JSONValue.Number(2.0)), d.extra)
        val store = VoiceStore(repo)
        assertEquals(emptyList(), store.dictionary())
        assertEquals(emptyList(), store.modes())
    }

    @Test fun entryEditsOnTwoDevicesMerge() {
        val server = FakeServer(VOICE_COLLECTION)
        val repos = List(2) { InMemoryFieldDocRepository() }
        val engines = repos.map { FieldDocSyncEngine(it) }
        val stores = repos.map { VoiceStore(it) }
        val entry = stores[0].addEntry("Kubernetes")!!
        fun sync(from: Int) {
            for (d in engines[from].docsToSend()) {
                engines[from].markSent(d)
                val (stored, accepted) = server.put(d)
                engines[from].ack(d.id, if (accepted) stored.seq else null, accepted, d.updatedAt)
                if (!accepted) engines[from].applyRemote(stored)
                if (accepted) engines.forEachIndexed { i, e -> if (i != from) e.applyRemote(stored) }
            }
        }
        sync(0)
        assertEquals(listOf("Kubernetes"), stores[1].dictionary().map { it.term })
        // device 0 stars it, device 1 adds a misspelling, concurrently
        stores[0].toggleStar(entry.id)
        stores[1].setMisspelling(entry.id, "cooper netties")
        sync(0)
        sync(1)
        sync(0)
        for (s in stores) {
            val e = s.dictionary().single()
            assertTrue(e.starred, "starred on every device")
            assertEquals("cooper netties", e.misspelling)
        }
        assertEquals(stores[0].dictionary(), stores[1].dictionary())
        // a deletion wins over older edits
        stores[1].removeEntry(entry.id)
        sync(1)
        assertTrue(stores[0].dictionary().isEmpty())
    }

    @Test fun settingsSingletonOnlyStampsWhatChanged() {
        val server = FakeServer(VOICE_COLLECTION)
        val repos = List(2) { InMemoryFieldDocRepository() }
        val engines = repos.map { FieldDocSyncEngine(it) }
        val stores = repos.map { VoiceStore(it) }
        assertEquals(VoiceSettings(), stores[0].settings)
        assertTrue(stores[0].settings.cleanupEnabled)
        stores[0].setCustomInstructions("Write in British English")
        stores[0].setCustomInstructionsEnabled(true)
        // a fresh device changes one other setting before it has synced
        stores[1].setCleanupEnabled(false)
        val doc1 = repos[1].doc(VOICE_SETTINGS_ID)!!
        assertEquals(setOf("cleanupEnabled"), doc1.fields.keys)
        assertEquals(VoiceKind.SETTINGS, doc1.type)
        fun sync(from: Int) {
            for (d in engines[from].docsToSend()) {
                engines[from].markSent(d)
                val (stored, accepted) = server.put(d)
                engines[from].ack(d.id, if (accepted) stored.seq else null, accepted, d.updatedAt)
                if (!accepted) engines[from].applyRemote(stored)
                if (accepted) engines.forEachIndexed { i, e -> if (i != from) e.applyRemote(stored) }
            }
        }
        sync(0)
        sync(1)
        sync(0)
        sync(1)
        for (s in stores) {
            assertEquals(VoiceSettings("Write in British English", customInstructionsEnabled = true, cleanupEnabled = false), s.settings)
            assertEquals("Write in British English", s.settings.effectiveInstructions)
        }
        assertFalse(stores[0].setCleanupEnabled(false)) // unchanged: no new version
    }

    @Test fun dictionaryRulesMatchTheMac() {
        val store = VoiceStore(InMemoryFieldDocRepository(), device = { "pixel" })
        assertNotNull(store.addEntry("  Kubernetes \n", " cooper netties "))
        assertNull(store.addEntry("kubernetes")) // case-insensitive duplicate
        assertNull(store.addEntry("   "))
        assertNull(store.addEntry("x".repeat(61)))
        assertNotNull(store.addEntry("👨‍👩‍👧".repeat(60))) // 60 Characters
        val grpc = store.addEntry("gRPC", "")!!
        assertNull(grpc.misspelling)
        val ammaar = store.addEntry("Ammaar", "amar")!!
        store.toggleStar(grpc.id)
        // starred first, then newest
        assertEquals(listOf("gRPC", "Ammaar", "👨‍👩‍👧".repeat(60), "Kubernetes"), store.dictionary().map { it.term })
        assertEquals(listOf("Kubernetes"), store.search("cooper").map { it.term }) // matches the misspelling
        assertEquals(listOf("Ammaar"), store.search("AMMA").map { it.term })
        assertEquals(listOf("amar" to "Ammaar", "cooper netties" to "Kubernetes"), store.spellings())
        assertEquals(listOf("cooper netties" to "Kubernetes", "amar" to "Ammaar"), store.replacementRules())
        assertFalse(store.setTerm(ammaar.id, "GRPC"))
        assertTrue(store.setTerm(ammaar.id, "Ammaar Reshi"))
        assertEquals(listOf("gRPC", "Ammaar Reshi"), store.vocabulary().take(2))
        val v = VoiceDictionary.sanitizedVocabulary(listOf(DictionaryEntry("1", "a\nb", null, false, 1), DictionaryEntry("2", "c", null, false, 2)), maxBytes = 6)
        assertEquals(listOf("c", "a b"), v)
    }

    @Test fun duplicateTermsFromTwoDevicesShowOnce() {
        val repo = InMemoryFieldDocRepository()
        val engine = FieldDocSyncEngine(repo)
        val store = VoiceStore(repo)
        val mine = store.addEntry("Kubernetes")!!
        val theirs = FieldDoc.newEntry("kubernetes", now = mine.createdAt - 10).apply { seq = 3 }
        engine.applyRemote(theirs)
        assertEquals(2, store.allEntries.size)
        assertEquals(listOf(theirs.id), store.dictionary().map { it.id }) // the earlier one, on every device
    }

    @Test fun modes() {
        val store = VoiceStore(InMemoryFieldDocRepository())
        assertNull(store.addMode("  "))
        val a = store.addMode("Email", "Write it as an email", language = "en-GB")!!
        val b = store.addMode("Notes", cleanup = false)!!
        assertEquals(listOf("Email", "Notes"), store.modes().map { it.name })
        assertTrue(store.moveMode(b.id, -1))
        assertEquals(listOf("Notes", "Email"), store.modes().map { it.name })
        assertTrue(store.updateMode(a.id, prompt = "Formal", language = ""))
        val m = store.mode(a.id)!!
        assertEquals("Formal", m.prompt)
        assertNull(m.language)
        assertFalse(store.mode(b.id)!!.cleanup)
        assertTrue(store.deleteMode(b.id))
        assertEquals(listOf("Email"), store.modes().map { it.name })
        assertEquals("Email", voiceLabel(store.repo.doc(a.id)!!))
        assertEquals("Voice settings", voiceLabel(FieldDoc.newVoiceSettings()))
    }
}
