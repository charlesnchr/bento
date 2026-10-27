package com.charles.bento.core.voice.meeting

import com.charles.bento.core.voice.FakeTransport
import com.charles.bento.core.voice.Frames
import com.charles.bento.core.voice.Spelling
import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.audio.FlacTestDecoder
import com.charles.bento.core.voice.audio.WavWriter
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.format.ReplacementEngine
import com.charles.bento.core.voice.json
import com.charles.bento.core.voice.tempDir
import com.charles.bento.core.voice.tone
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val T0: Instant = Instant.parse("2026-10-27T14:00:00Z")

private fun segment(id: Int, chunk: Int, text: String, receivedAt: Instant = T0, start: Double = id.toDouble()) =
    MeetingSegment(id, chunk, start, text, fromBatch = false, receivedAt = receivedAt)

private fun words(n: Int, word: String = "word") = List(n) { word }.joinToString(" ")

class MeetingCleanupPlannerTest {
    private fun document(chunks: List<MeetingChunk>, segments: List<MeetingSegment>, blocks: List<MeetingBlock> = emptyList()) =
        MeetingDocument(File("/tmp/x"), MeetingMeta(id = "m", startedAt = T0, chunks = chunks,
            parts = listOf(MeetingPart(1, T0, frames = 16_000 * 600))), MeetingTranscript(segments, blocks, segments.size + 1))

    private val streaming = MeetingChunk(1, 1, 0, status = MeetingChunk.Status.STREAMING)

    @Test fun waitsForEnoughWordsOrTime() {
        val doc = document(listOf(streaming), listOf(segment(1, 1, words(50))))
        assertNull(MeetingCleanupPlanner.next(doc, T0.plusSeconds(10), force = false))
        assertNotNull(MeetingCleanupPlanner.next(doc, T0.plusSeconds(75), force = false), "the oldest text is 75 s old")
        val many = document(listOf(streaming), listOf(segment(1, 1, words(80)), segment(2, 1, words(70))))
        assertEquals(listOf(1, 2), MeetingCleanupPlanner.next(many, T0, force = false)!!.segments.map { it.id })
    }

    @Test fun capsWordsPerCall() {
        val doc = document(listOf(streaming), (1..5).map { segment(it, 1, words(200)) })
        assertEquals(listOf(1, 2), MeetingCleanupPlanner.next(doc, T0, force = false)!!.segments.map { it.id })
        // A single oversized segment still goes.
        val big = document(listOf(streaming), listOf(segment(1, 1, words(900))))
        assertEquals(1, MeetingCleanupPlanner.next(big, T0, force = false)!!.segments.size)
    }

    @Test fun provisionalChunksWaitUntilForced() {
        val buffering = MeetingChunk(1, 1, 0, status = MeetingChunk.Status.BUFFERING)
        val doc = document(listOf(buffering), listOf(segment(1, 1, words(500))))
        assertNull(MeetingCleanupPlanner.next(doc, T0.plusSeconds(1_000), force = false), "about to be replaced by batch")
        assertNotNull(MeetingCleanupPlanner.next(doc, T0, force = true))
    }

    @Test fun settledChunksCleanImmediately() {
        val done = MeetingChunk(1, 1, 0, endFrame = 100, status = MeetingChunk.Status.COMPLETE)
        assertNotNull(MeetingCleanupPlanner.next(document(listOf(done), listOf(segment(1, 1, "short"))), T0, force = false))
    }

    @Test fun skipsCleanedSegmentsAndCarriesContext() {
        val long = "First paragraph. " + words(200, "earlier")
        val doc = document(listOf(streaming), listOf(segment(1, 1, "old"), segment(2, 1, words(150))),
            listOf(MeetingBlock(1, 1, 1, 0.0, long, cleaned = true)))
        val batch = MeetingCleanupPlanner.next(doc, T0, force = false)!!
        assertEquals(listOf(2), batch.segments.map { it.id })
        assertTrue(batch.context.length <= 600)
        assertTrue(batch.context.startsWith("earlier"), "cut at a word boundary")
        assertEquals("tiny", MeetingCleanupPlanner.context(1, 9, MeetingTranscript(blocks = listOf(MeetingBlock(1, 1, 2, 0.0, "tiny", true)))))
    }
}

class MeetingPromptsTest {
    @Test fun cleanupPromptLayout() {
        val prompt = MeetingPrompts.cleanup("so um the budget", "Earlier text.", listOf("Priya"), listOf(Spelling("pria", "Priya")))
        assertTrue(prompt.startsWith("You turn an automatically transcribed stretch of a meeting into clean, readable text."))
        assertTrue(prompt.contains("Vocabulary — prefer these exact spellings when they match: Priya"))
        assertTrue(prompt.contains("Spellings: \"pria\" means \"Priya\"."))
        assertTrue(prompt.contains("EARLIER (already cleaned; context only, never repeat it):\n<<<\nEarlier text.\n>>>"))
        assertTrue(prompt.endsWith("NEW TRANSCRIPT:\n<<<\nso um the budget\n>>>\nCleaned new transcript:"))
        assertFalse(MeetingPrompts.cleanup("x", "  ", emptyList(), emptyList()).contains("EARLIER"))
    }

    @Test fun acceptCleanupStripsMarkersAndRejectsAnswers() {
        assertEquals("So the budget is approved.", MeetingPrompts.acceptCleanup("so um the budget is approved", "<<<\nSo the budget is approved.\n>>>"))
        assertNull(MeetingPrompts.acceptCleanup("what should we do about the budget", "Sure! Here is my advice: cut marketing spend by half and hire two engineers."))
        assertNull(MeetingPrompts.acceptCleanup("x y z", "   "))
    }

    @Test fun summaryPromptMentionsTheStart() {
        val prompt = MeetingPrompts.summary("text", T0, Locale.US, ZoneId.of("UTC"))
        assertTrue(prompt.contains("Return JSON only, with exactly this shape:"))
        assertTrue(prompt.contains("The meeting started Tuesday, October 27, 2026"))
        assertTrue(prompt.endsWith("TRANSCRIPT:\n<<<\ntext\n>>>"))
    }

    @Test fun parseSummaryToleratesFencesAndShapes() {
        val parsed = assertNotNull(MeetingPrompts.parseSummary("""
            Here you go:
            ```json
            {"title":"Q4 budget review","summary":["Budget approved"," "],"decisions":["Hire two engineers"],
             "action_items":[{"task":"Send the deck","owner":"Priya","due":"Friday"},{"task":"Book room","owner":null,"due":"null"},"Email finance"]}
            ```
        """.trimIndent()))
        assertEquals("Q4 budget review", parsed.title)
        assertEquals(listOf("Budget approved"), parsed.overview)
        assertEquals(listOf("Hire two engineers"), parsed.decisions)
        assertEquals(listOf(MeetingActionItem("Send the deck", "Priya", "Friday"), MeetingActionItem("Book room"), MeetingActionItem("Email finance")),
            parsed.actionItems)
        assertNull(MeetingPrompts.parseSummary("no json here"))
        assertNull(MeetingPrompts.parseSummary("""{"title":"","summary":[],"decisions":[],"actionItems":[]}"""))
        assertEquals(80, MeetingPrompts.parseSummary("""{"title":"${"x".repeat(200)}"}""")!!.title.length)
    }
}

class MeetingLiveProtocolTest {
    @Test fun setupFrameIsVerbatimWithAutomaticActivity() {
        assertEquals("""{"setup":{"model":"models/gemini-3.5-transcribe-live","generationConfig":{"responseModalities":["TEXT"]},"inputAudioTranscription":{"mode":"VERBATIM"}}}""",
            MeetingLiveProtocol.setupFrame("gemini-3.5-transcribe-live", emptyList()))
        assertEquals("""{"realtimeInput":{"audioStreamEnd":true}}""", MeetingLiveProtocol.streamEndFrame())
    }

    @Test fun oneFrameCanSayEverything() {
        val frame = json(
            "voiceActivity" to mapOf("type" to "ACTIVITY_END", "audioOffset" to "4.5s"),
            "serverContent" to mapOf("inputTranscription" to mapOf("text" to " Final words. ")),
            "usageMetadata" to mapOf("promptTokensDetails" to listOf(mapOf("modality" to "AUDIO", "tokenCount" to 120)), "candidatesTokenCount" to 7),
        )
        assertEquals(listOf(MeetingLiveEvent.Final("Final words."), MeetingLiveEvent.Usage(120, 7), MeetingLiveEvent.ActivityEnd(4.5)),
            MeetingLiveProtocol.decode(frame))
        assertEquals(listOf(MeetingLiveEvent.ActivityStart(1.25)), MeetingLiveProtocol.decode(Frames.activity("ACTIVITY_START", "1.25s")))
        assertEquals(listOf(MeetingLiveEvent.Usage(33, 0)), MeetingLiveProtocol.decode("""{"usageMetadata":{"promptTokenCount":33}}"""))
        assertEquals(listOf(MeetingLiveEvent.Failed("boom")), MeetingLiveProtocol.decode(Frames.error("boom")))
        assertEquals(listOf(MeetingLiveEvent.GoAway), MeetingLiveProtocol.decode("""{"goAway":{"timeLeft":"10s"}}"""))
    }

    @Test fun sessionFinishesCleanOnlyWhenEverythingArrived() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.final("hello there")))
        val session = MeetingLiveSession(transport, "{\"setup\":{}}")
        session.start()
        session.enqueue(ByteArray(3_200))
        val first = withTimeout(3_000) { session.events.first() }
        assertEquals(MeetingLiveEvent.Final("hello there"), first)
        assertTrue(session.finish(2.0))
        assertTrue(transport.sentKinds.last() == "audioStreamEnd")

        val failing = FakeTransport(listOf(Frames.setupComplete(), Frames.error("quota")))
        val bad = MeetingLiveSession(failing, "{\"setup\":{}}")
        bad.start()
        delay(150)
        assertFalse(bad.finish(1.0))
        assertTrue(bad.hasFailed)
    }

    @Test fun refusedHandshakeClosesTheSession() = blocking {
        val transport = FakeTransport(listOf(Frames.error("API key not valid")))
        val session = MeetingLiveSession(transport, "{}")
        runCatching { session.start(1.0) }.also { assertTrue(it.isFailure) }
        assertEquals(1, transport.closeCount)
    }
}

/** Fake models: batch returns scripted text per call; the text model tidies or summarizes. */
class FakeMeetingModels(private val batchTexts: ArrayDeque<String> = ArrayDeque()) : MeetingBatchTranscribing, MeetingTextGenerating {
    val batchAudio = ArrayList<ShortArray>()
    val prompts = ArrayList<String>()
    @Volatile var batchError: Exception? = null
    @Volatile var summary = """{"title":"Budget sync","summary":["The Q4 budget was approved"],"decisions":["Hire two engineers"],"actionItems":[{"task":"Send the deck","owner":"Priya","due":"Friday"}]}"""

    override suspend fun transcribe(flac: ByteArray, durationSeconds: Double, vocabulary: List<String>): String {
        batchError?.let { throw it }
        synchronized(this) { batchAudio += FlacTestDecoder.decode(flac).samples }
        return synchronized(this) { batchTexts.removeFirstOrNull() } ?: "batch words"
    }

    override suspend fun generate(prompt: String, json: Boolean, deadline: Double): String {
        synchronized(this) { prompts += prompt }
        if (json) return summary
        val raw = prompt.substringAfter("NEW TRANSCRIPT:\n<<<\n").substringBefore("\n>>>")
        return raw.replaceFirstChar { it.uppercase() }.removeSuffix(".") + "."
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class MeetingProcessorTest {
    private val root = tempDir("meetings")
    private val store = MeetingStore(root)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)

    private fun services(models: FakeMeetingModels, rules: List<ReplacementEngine.Rule> = emptyList()) =
        MeetingServices(models, models, replacementRules = rules)

    /** A meeting with one 3 s part on disk and the given chunks. */
    private fun document(chunks: List<MeetingChunk>, mutedRanges: List<MeetingFrameRange> = emptyList(),
                         segments: List<MeetingSegment> = emptyList()): MeetingDocument {
        val folder = store.makeFolder("ABCDEF12-0000", T0)
        val part = MeetingPart(1, T0, frames = 48_000, mutedRanges = mutedRanges, ended = true)
        WavWriter.write(File(folder, part.micFileName), tone(3.0))
        return MeetingDocument(folder, MeetingMeta(id = "ABCDEF12-0000", startedAt = T0, status = MeetingMeta.Status.FINISHING,
            parts = listOf(part), chunks = chunks), MeetingTranscript(segments, emptyList(), segments.size + 1))
    }

    @Test fun finishBackfillsCleansAndSummarizes() = blocking {
        val models = FakeMeetingModels(ArrayDeque(listOf("the budget for q4 was approved by priya and the team agreed to hire two engineers next month")))
        val doc = document(listOf(
            MeetingChunk(1, 1, 0, endFrame = 16_000, status = MeetingChunk.Status.COMPLETE),
            MeetingChunk(2, 1, 16_000, endFrame = 48_000, status = MeetingChunk.Status.AWAITING_BATCH),
        ), mutedRanges = listOf(MeetingFrameRange(20_000, 24_000)),
            segments = listOf(segment(1, 1, "so we are here to talk about the budget for the last quarter of the year and what it means for hiring", start = 0.0)))
        val processor = MeetingProcessor(doc, services(models, listOf(ReplacementEngine.Rule("q4", "Q4"))), store, scope, dispatcher) { T0 }
        processor.finish()
        val result = processor.document
        assertEquals(MeetingMeta.Status.COMPLETE, result.meta.status)
        assertEquals(MeetingChunk.Status.BATCHED, result.meta.chunk(2)!!.status)
        // The batch upload was exactly chunk 2's span with the dictation range silenced.
        val sent = models.batchAudio.single()
        assertEquals(32_000, sent.size)
        assertTrue((4_000 until 8_000).all { sent[it] == 0.toShort() })
        assertTrue(sent[100] != 0.toShort())
        assertEquals(1, result.transcript.segments.count { it.fromBatch })
        assertEquals(1.0, result.transcript.segments.single { it.fromBatch }.start)
        // Everything was cleaned, rules applied, and the summary set the title.
        assertTrue(result.transcript.blocks.all { it.cleaned })
        assertTrue(result.plainTranscript.contains("Q4"))
        assertEquals("Budget sync", result.meta.title)
        assertEquals(listOf("Hire two engineers"), result.meta.summary!!.decisions)
        assertEquals(2.0, result.meta.usage.batchSeconds)
        assertTrue(result.meta.usage.textCalls >= 3)
        assertNull(processor.step.value)
        assertFalse(processor.canRetry)
        // On disk: meta, transcript and the Mac-style notes.md.
        delay(200)
        val loaded = assertNotNull(store.load(doc.folder))
        assertEquals(MeetingMeta.Status.COMPLETE, loaded.meta.status)
        assertTrue(MeetingStore.notesFile(doc.folder).readText().startsWith("# Budget sync"))
    }

    @Test fun permanentBatchFailureLeavesAVisibleGapAndARetry() = blocking {
        val models = FakeMeetingModels().apply { batchError = TranscriptionError.Auth }
        val doc = document(listOf(MeetingChunk(1, 1, 0, endFrame = 48_000, status = MeetingChunk.Status.AWAITING_BATCH)))
        val processor = MeetingProcessor(doc, services(models), store, scope, dispatcher) { T0 }
        processor.finish()
        val result = processor.document
        assertEquals(MeetingChunk.Status.FAILED, result.meta.chunk(1)!!.status)
        assertEquals("Authentication failed", result.meta.chunk(1)!!.lastError)
        val gap = assertIs<MeetingParagraph.Kind.Gap>(result.paragraphs.single().kind)
        assertTrue(gap.failed)
        assertEquals(3.0, gap.seconds)
        assertTrue(processor.canRetry)
        assertNull(result.meta.summary, "too few words to summarize")

        models.batchError = null
        processor.retry()
        assertEquals(MeetingChunk.Status.BATCHED, processor.document.meta.chunk(1)!!.status)
        assertFalse(processor.canRetry)
    }

    @Test fun silentSpansAreNotUploaded() = blocking {
        val models = FakeMeetingModels()
        val doc = document(listOf(MeetingChunk(1, 1, 0, endFrame = 48_000, status = MeetingChunk.Status.AWAITING_BATCH)),
            mutedRanges = listOf(MeetingFrameRange(0, 48_000)))
        val processor = MeetingProcessor(doc, services(models), store, scope, dispatcher) { T0 }
        processor.finish()
        assertTrue(models.batchAudio.isEmpty(), "a fully muted stretch has nothing to transcribe")
        assertEquals(MeetingChunk.Status.BATCHED, processor.document.meta.chunk(1)!!.status)
    }

    @Test fun recoveryReTranscribesUnsettledLiveSpans() {
        val doc = MeetingDocument(File("/tmp/m"), MeetingMeta(id = "m", startedAt = T0, status = MeetingMeta.Status.RECORDING,
            parts = listOf(MeetingPart(1, T0, frames = 16_000)),
            chunks = listOf(MeetingChunk(1, 1, 0, endFrame = 16_000, status = MeetingChunk.Status.COMPLETE),
                MeetingChunk(2, 1, 16_000, status = MeetingChunk.Status.STREAMING))), MeetingTranscript())
        val recovered = MeetingProcessor.recovered(doc) { 40_000 }
        assertEquals(40_000L, recovered.meta.parts.single().frames, "the recording on disk is the truth")
        assertTrue(recovered.meta.parts.single().ended)
        assertEquals(MeetingChunk.Status.COMPLETE, recovered.meta.chunk(1)!!.status)
        assertEquals(MeetingChunk.Status.AWAITING_BATCH, recovered.meta.chunk(2)!!.status)
        assertEquals(40_000L, recovered.meta.chunk(2)!!.endFrame)
        assertEquals(MeetingMeta.Status.FINISHING, recovered.meta.status)
        assertEquals(T0.plusMillis(2_500), recovered.meta.endedAt)
    }

    @Test fun windowsCutAtTheQuietestMoment() {
        val samples = tone(600.0, amplitude = 4_000.0)
        // A quiet second 5 s after the ideal 300 s cut.
        for (i in 16_000 * 305 until 16_000 * 306) samples[i] = 0
        val windows = MeetingAudioExtractor.windows(samples)
        assertEquals(2, windows.size)
        assertEquals(0, windows.first().first)
        assertEquals(samples.size - 1, windows.last().last)
        assertTrue(windows[0].last + 1 == windows[1].first, "contiguous")
        assertTrue(windows[1].first in 16_000 * 305..16_000 * 306, "the cut falls in the pause: ${windows[1].first}")
        assertEquals(listOf(0 until 100), MeetingAudioExtractor.windows(ShortArray(100)))
    }
}

class MeetingNoteRendererTest {
    private val document = MeetingDocument(
        File("/tmp/m"),
        MeetingMeta(id = "m", startedAt = T0, status = MeetingMeta.Status.COMPLETE, title = "Budget sync",
            parts = listOf(MeetingPart(1, T0, frames = 16_000L * 125)),
            chunks = listOf(MeetingChunk(1, 1, 0, endFrame = 16_000L * 100, status = MeetingChunk.Status.COMPLETE),
                MeetingChunk(2, 1, 16_000L * 100, endFrame = 16_000L * 125, status = MeetingChunk.Status.FAILED)),
            summary = MeetingSummary("Budget sync", listOf("Q4 budget approved"), listOf("Hire two engineers"),
                listOf(MeetingActionItem("Send the deck", "Priya", "Friday"), MeetingActionItem("Book a room")))),
        MeetingTranscript(segments = listOf(segment(1, 1, "a"), segment(2, 1, "b")), blocks = listOf(
            MeetingBlock(1, 1, 2, 5.0, "We approved the budget.\n\nPriya will send the deck.\n</details>\n```kotlin", cleaned = true))),
    )

    @Test fun rendersABentoNoteWithTheTranscriptInAnExpander() {
        val note = MeetingNoteRenderer.render(document, Locale.US, ZoneId.of("UTC"))
        val expected = """
            # Budget sync

            _${document.subtitle(Locale.US, ZoneId.of("UTC"))}_

            ## Summary
            - Q4 budget approved

            ## Decisions
            - Hire two engineers

            ## Action items
            - [ ] **Priya**: Send the deck (due Friday)
            - [ ] Book a room

            <details><summary>Transcript</summary>

            **[0:05]** We approved the budget.

            Priya will send the deck.
            \</details>
            ```kotlin

            **[1:40]** _0:25 of audio could not be transcribed. Retry from Bento's Meetings screen._
            ```

            </details>

        """.trimIndent()
        assertEquals(expected, note)
        // The Notes module's title is the first line without markdown.
        assertEquals("# Budget sync", note.lines().first())
    }

    @Test fun anEmptyMeetingStillRendersAClosedExpander() {
        val empty = MeetingDocument(File("/tmp/e"), MeetingMeta(id = "e", startedAt = T0), MeetingTranscript())
        val note = MeetingNoteRenderer.render(empty, Locale.US, ZoneId.of("UTC"))
        val us = Locale.US to ZoneId.of("UTC")
        assertTrue(note.startsWith("# ${empty.displayTitle(us.first, us.second)}\n\n_${empty.subtitle(us.first, us.second)}_\n\n<details><summary>Transcript</summary>"))
        assertTrue(empty.displayTitle(us.first, us.second).startsWith("Meeting, Oct 27, 2026"))
        assertTrue(note.endsWith("_Nothing was transcribed._\n\n</details>\n"))
    }

    @Test fun expanderSyntaxDetection() {
        for (line in listOf("<details>", "<DETAILS open>", "</details>", "::: details Idea", ":::")) assertTrue(MeetingNoteRenderer.isExpanderSyntax(line), line)
        for (line in listOf("details", "a <details>", "</details> more", "<detailsx>", "::: note")) assertFalse(MeetingNoteRenderer.isExpanderSyntax(line), line)
    }

    @Test fun macNotesMarkdownMatchesTheMacLayout() {
        val md = document.markdown(Locale.US, ZoneId.of("UTC"))
        assertTrue(md.startsWith("# Budget sync\n\n_${document.subtitle(Locale.US, ZoneId.of("UTC"))}_\n\n## Summary\n- Q4 budget approved\n"))
        assertTrue(document.subtitle(Locale.US, ZoneId.of("UTC")).startsWith("October 27, 2026") && document.subtitle(Locale.US, ZoneId.of("UTC")).endsWith("2:00 PM · 2 min"))
        assertTrue(md.contains("## Transcript\n\n**[0:05]** We approved the budget.\n\nPriya will send the deck.\n"))
    }
}

/** The facade end to end with fake models and a scripted Live socket. */
class MeetingSessionTest {
    private val root = tempDir("meeting-session")

    @Test fun liveMeetingProducesCleanedNotesWithSummary() = blocking {
        val models = FakeMeetingModels()
        val transports = ArrayList<FakeTransport>()
        val engine = MeetingEngine.forTesting(root, services = { MeetingServices(models, models, summaryEnabled = it.summary) }, live = {
            {
                val t = FakeTransport(listOf(Frames.setupComplete()))
                transports += t
                MeetingLiveSession(t, MeetingLiveProtocol.setupFrame(it.liveModel, emptyList()))
            }
        })
        engine.locale = Locale.US
        engine.zone = ZoneId.of("UTC")
        val session = engine.start(MeetingConfig(apiKey = "k"))
        withTimeout(3_000) { session.connection.first { it == MeetingRecorder.Connection.LIVE } }
        val transport = transports.single()
        assertTrue(session.feed(tone(2.0)))
        transport.push(Frames.activity("ACTIVITY_START", "0.2s"))
        transport.push(json("serverContent" to mapOf("interimInputTranscription" to mapOf("text" to "so the q4"))))
        withTimeout(3_000) { session.interim.first { it == "so the q4" } }
        val said = "so the q4 budget was approved and priya will send the deck to the finance team on friday afternoon " +
            "after she checks the numbers with marcus and the two new engineers start in january"
        transport.push(Frames.final(said))
        transport.push(Frames.activity("ACTIVITY_END", "2.0s"))
        withTimeout(3_000) { session.paragraphs.first { it.isNotEmpty() } }
        assertEquals(MeetingParagraph.Kind.Pending, session.paragraphs.first().single().kind)
        assertFailsWith<IllegalStateException>("one meeting at a time") { engine.start(MeetingConfig(apiKey = "k")) }

        val notes = session.stop()
        assertEquals("Budget sync", notes.title)
        assertFalse(notes.incomplete)
        assertEquals(MeetingChunk.Status.COMPLETE, notes.document.meta.chunks.single().status, "a clean Live session keeps its finals")
        assertTrue(models.batchAudio.isEmpty(), "nothing needed re-transcribing")
        assertEquals(MeetingParagraph.Kind.Cleaned, notes.document.paragraphs.single().kind)
        assertTrue(notes.noteMarkdown.contains("**[0:00]** So the q4 budget was approved"))
        assertTrue(notes.noteMarkdown.contains("- [ ] **Priya**: Send the deck (due Friday)"))
        assertTrue(notes.noteMarkdown.contains("<details><summary>Transcript</summary>"))
        assertEquals(MeetingMeta.Status.COMPLETE, engine.load(session.id)!!.meta.status)
        assertEquals(2.0, notes.document.meta.durationSeconds)
        assertTrue(transports.single().sentKinds.contains("audioStreamEnd"))
        assertNull(engine.activeSession)
    }

    @Test fun withoutLiveTheRecordingIsTranscribedInBatches() = blocking {
        val models = FakeMeetingModels(ArrayDeque(listOf("first stretch of the meeting where we talked about plans for the launch and the dates that matter most to the team")))
        val engine = MeetingEngine.forTesting(root, services = { MeetingServices(models, models) }, live = { null })
        val session = engine.start(MeetingConfig(apiKey = "k", live = false))
        assertEquals(MeetingRecorder.Connection.UNAVAILABLE, session.connection.value)
        session.feed(tone(1.5))
        session.setMicMuted(true)
        session.feed(tone(0.5))
        session.setMicMuted(false)
        session.pause()
        assertFalse(session.feed(tone(0.1)), "paused: no audio wanted")
        session.resume()
        session.feed(tone(1.0))
        val notes = session.stop()
        val meta = notes.document.meta
        assertEquals(2, meta.parts.size)
        assertEquals(listOf(MeetingFrameRange(24_000, 32_000)), meta.parts[0].mutedRanges)
        assertEquals(3.0, meta.durationSeconds)
        assertTrue(meta.chunks.all { it.status == MeetingChunk.Status.BATCHED })
        assertEquals(2, models.batchAudio.size)
        assertTrue((24_000 until 32_000).all { models.batchAudio[0][it] == 0.toShort() }, "the dictation stays out of the notes")
        assertTrue(notes.noteMarkdown.contains("First stretch of the meeting"))
    }

    @Test fun interruptedMeetingsAreFinishedAtLaunch() = blocking {
        val models = FakeMeetingModels()
        val engine = MeetingEngine.forTesting(root, services = { MeetingServices(models, models) }, live = { null })
        val session = engine.start(MeetingConfig(apiKey = "k", live = false))
        session.feed(tone(2.0))
        session.prepareForTermination()
        engine.close()
        // A new process: the recording on disk is all there is.
        val relaunched = MeetingEngine.forTesting(root, services = { MeetingServices(models, models) }, live = { null })
        val recovered = relaunched.recoverInterrupted(MeetingConfig(apiKey = "k"))
        val notes = recovered.single()
        assertEquals(MeetingMeta.Status.COMPLETE, notes.document.meta.status)
        assertEquals(2.0, notes.document.meta.durationSeconds)
        assertTrue(notes.document.meta.chunks.all { it.status == MeetingChunk.Status.BATCHED })
        assertEquals(1, models.batchAudio.size)
        assertTrue(relaunched.recoverInterrupted(MeetingConfig(apiKey = "k")).isEmpty(), "finished once")
    }

    @Test fun storePurgesOnlySettledMeetingAudio() = blocking {
        val store = MeetingStore(root)
        val folder = store.makeFolder("PURGE000", T0)
        val part = MeetingPart(1, T0, frames = 16_000, ended = true)
        WavWriter.write(File(folder, part.micFileName), tone(1.0))
        store.save(MeetingDocument(folder, MeetingMeta(id = "PURGE000", startedAt = T0, endedAt = T0, status = MeetingMeta.Status.COMPLETE,
            parts = listOf(part), chunks = listOf(MeetingChunk(1, 1, 0, 16_000, MeetingChunk.Status.FAILED))), MeetingTranscript()))
        assertEquals(0, store.purgeExpiredAudio(7, T0.plusSeconds(30 * 86_400)), "a failed span still needs its audio")
        store.save(store.load(folder)!!.let { it.copy(meta = it.meta.updatingChunk(1) { c -> c.copy(status = MeetingChunk.Status.BATCHED) }) })
        assertEquals(1, store.purgeExpiredAudio(7, T0.plusSeconds(30 * 86_400)))
    }
}
