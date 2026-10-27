package com.charles.bento.core.voice.meeting

import com.charles.bento.core.voice.live.LiveError
import com.charles.bento.core.voice.live.LiveProtocol
import com.charles.bento.core.voice.live.LiveProtocol.has
import com.charles.bento.core.voice.live.LiveProtocol.obj
import com.charles.bento.core.voice.live.LiveProtocol.string
import com.charles.bento.core.voice.live.LiveTransport
import com.charles.bento.core.voice.live.PcmRing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

sealed class MeetingLiveEvent {
    data object SetupComplete : MeetingLiveEvent()
    /** Speculative text for the utterance in progress. Display only. */
    data class Interim(val text: String) : MeetingLiveEvent()
    /** Authoritative text for one finished utterance. */
    data class Final(val text: String) : MeetingLiveEvent()
    data class Usage(val audioTokens: Int, val textTokens: Int) : MeetingLiveEvent()
    /** Server voice activity, in seconds of audio received by this session. */
    data class ActivityStart(val offset: Double) : MeetingLiveEvent()
    data class ActivityEnd(val offset: Double) : MeetingLiveEvent()
    /** The server will close this session soon: rotate now. */
    data object GoAway : MeetingLiveEvent()
    data class Failed(val message: String) : MeetingLiveEvent()
}

object MeetingLiveProtocol {
    /**
     * Automatic activity detection (nobody holds a key; the server's pauses are where
     * utterances end) and VERBATIM (SMART was seen dropping a meeting's content words;
     * cleanup runs in its own pass with the raw text as the reference). No languageCodes.
     */
    fun setupFrame(model: String, vocabulary: List<String>): String = LiveProtocol.encode(buildJsonObject {
        putJsonObject("setup") {
            put("model", "models/$model")
            putJsonObject("generationConfig") { putJsonArray("responseModalities") { add("TEXT") } }
            putJsonObject("inputAudioTranscription") {
                put("mode", "VERBATIM")
                if (vocabulary.isNotEmpty()) putJsonArray("customVocabulary") { vocabulary.forEach { add(it) } }
            }
        }
    })

    fun streamEndFrame(): String = """{"realtimeInput":{"audioStreamEnd":true}}"""

    /** Everything one frame says, in the order it matters: a final also carries its usage. */
    fun decode(frame: String): List<MeetingLiveEvent> {
        val root = LiveProtocol.parseObject(frame) ?: return emptyList()
        if (root.has("setupComplete", "setup_complete")) return listOf(MeetingLiveEvent.SetupComplete)
        (root["error"] as? JsonObject)?.let { return listOf(MeetingLiveEvent.Failed(it.string("message") ?: "unknown live error")) }
        val events = ArrayList<MeetingLiveEvent>()
        var activityEnd: Double? = null
        root.obj("voiceActivity", "voice_activity")?.let { activity ->
            val type = activity.string("type") ?: activity.string("voiceActivityType") ?: ""
            val offset = LiveProtocol.parseDuration(activity["audioOffset"] ?: activity["audio_offset"]) ?: 0.0
            if (type.endsWith("START")) events += MeetingLiveEvent.ActivityStart(offset)
            else if (type.endsWith("END")) activityEnd = offset
        }
        root.obj("serverContent", "server_content")?.let { content ->
            LiveProtocol.transcriptText(content, "interimInputTranscription", "interim_input_transcription", trim = true)
                ?.let { events += MeetingLiveEvent.Interim(it) }
            LiveProtocol.transcriptText(content, "inputTranscription", "input_transcription", trim = true)
                ?.let { events += MeetingLiveEvent.Final(it) }
            if (content.has("goAway", "go_away")) events += MeetingLiveEvent.GoAway
        }
        root.obj("usageMetadata", "usage_metadata")?.let { usage ->
            val audio = audioTokens(usage)
            val text = (usage["candidatesTokenCount"] ?: usage["candidates_token_count"])?.let { (it as? JsonPrimitive)?.intOrNull } ?: 0
            if (audio > 0 || text > 0) events += MeetingLiveEvent.Usage(audio, text)
        }
        activityEnd?.let { events += MeetingLiveEvent.ActivityEnd(it) }
        if (root.has("goAway", "go_away")) events += MeetingLiveEvent.GoAway
        return events
    }

    private fun audioTokens(usage: JsonObject): Int {
        val details = (usage["promptTokensDetails"] ?: usage["prompt_tokens_details"]) as? JsonArray ?: JsonArray(emptyList())
        val audio = details.mapNotNull { it as? JsonObject }
            .filter { it.string("modality") == "AUDIO" }
            .sumOf { ((it["tokenCount"] ?: it["token_count"]) as? JsonPrimitive)?.intOrNull ?: 0 }
        if (audio > 0) return audio
        return ((usage["promptTokenCount"] ?: usage["prompt_token_count"]) as? JsonPrimitive)?.intOrNull ?: 0
    }
}

/**
 * One Live session of a meeting: streams the ring, relays events, and on [finish]
 * flushes and waits for the utterance in progress. A session that saw every byte
 * and ended cleanly keeps its chunk's finals; anything else re-transcribes the chunk
 * from the recording.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MeetingLiveSession(
    private val transport: LiveTransport,
    private val setupFrame: String,
    ringSeconds: Double = 30.0,
) {
    private enum class Command { PCM_AVAILABLE, END_STREAM }

    /** A meeting can afford a long stall: anything dropped is recovered from disk by batch. */
    val ring = PcmRing(ringSeconds)
    private val confined = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + confined)
    private val commands = Channel<Command>(Channel.UNLIMITED)
    private val eventChannel = Channel<MeetingLiveEvent>(Channel.UNLIMITED)

    /** Events, in order. Collect once. Completes when the session closes. */
    val events: Flow<MeetingLiveEvent> = eventChannel.receiveAsFlow()

    private var sendLoop: Job? = null
    private var receiveLoop: Job? = null
    private var didSetup = false
    private var closed = false
    @Volatile private var failure: String? = null
    private var streamEndSent = false
    private var speechActive = false
    private var activityEndedAfterStreamEnd = false

    /** Called from the audio thread. Must not block or suspend. */
    fun enqueue(pcm: ByteArray) {
        ring.append(pcm)
        commands.trySend(Command.PCM_AVAILABLE)
    }

    /** Connects and handshakes. A session that throws here is already closed. */
    suspend fun start(setupTimeout: Double = 8.0) = withContext(confined) {
        try {
            handshake(setupTimeout)
        } catch (e: Exception) {
            close()
            throw e
        }
        receiveLoop = scope.launch { runReceiveLoop() }
        sendLoop = scope.launch { runSendLoop() }
    }

    private suspend fun handshake(timeout: Double) {
        if (closed) throw LiveError.setupTimedOut()
        transport.connect()
        transport.send(setupFrame)
        val deadline = System.nanoTime() + (timeout * 1e9).toLong()
        while (!didSetup) {
            val remaining = (deadline - System.nanoTime()) / 1_000_000
            if (remaining <= 0) break
            val frame = withTimeoutOrNull(remaining) { transport.receive() } ?: break
            for (event in MeetingLiveProtocol.decode(frame)) {
                when (event) {
                    MeetingLiveEvent.SetupComplete -> didSetup = true
                    is MeetingLiveEvent.Failed -> throw LiveError.refused(event.message)
                    else -> {}
                }
            }
        }
        if (!didSetup) throw LiveError.setupTimedOut()
    }

    private suspend fun runSendLoop() {
        for (command in commands) {
            if (closed) return
            for (chunk in ring.drain()) {
                try {
                    transport.send(LiveProtocol.audioFrame(chunk))
                    ring.markAccepted(chunk.size)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    fail("send failed: ${e.message}")
                    return
                }
            }
            if (command == Command.END_STREAM) {
                try {
                    transport.send(MeetingLiveProtocol.streamEndFrame())
                    streamEndSent = true
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    fail("audioStreamEnd failed: ${e.message}")
                }
                return
            }
        }
    }

    private suspend fun runReceiveLoop() {
        while (!closed) {
            val frame = try {
                transport.receive()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!closed) fail("receive failed: ${e.message}")
                return
            }
            for (event in MeetingLiveProtocol.decode(frame)) {
                when (event) {
                    is MeetingLiveEvent.ActivityStart -> speechActive = true
                    is MeetingLiveEvent.ActivityEnd -> {
                        speechActive = false
                        if (streamEndSent) activityEndedAfterStreamEnd = true
                    }
                    is MeetingLiveEvent.Failed -> { fail(event.message); return }
                    else -> {}
                }
                eventChannel.trySend(event)
            }
        }
    }

    private fun fail(why: String) {
        if (failure != null || closed) return
        failure = why
        eventChannel.trySend(MeetingLiveEvent.Failed(why))
        close()
    }

    /** Flushes and waits for the utterance in progress. True only when every byte was seen and it ended cleanly. */
    suspend fun finish(deadline: Double = 6.0): Boolean = withContext(confined) {
        if (!didSetup || failure != null || closed) {
            close()
            return@withContext false
        }
        commands.trySend(Command.END_STREAM)
        val flushDeadline = System.nanoTime() + 5_000_000_000L
        while (!streamEndSent && failure == null && System.nanoTime() < flushDeadline) delay(20)
        if (!streamEndSent || failure != null) {
            close()
            return@withContext false
        }
        // The server needs a beat to notice an utterance that began just before the end
        // marker; past that, an idle session has nothing left to say.
        val grace = System.nanoTime() + 800_000_000L
        val finalDeadline = System.nanoTime() + (deadline * 1e9).toLong()
        while (failure == null && System.nanoTime() < finalDeadline) {
            if (!speechActive && (activityEndedAfterStreamEnd || System.nanoTime() >= grace)) break
            delay(40)
        }
        val clean = failure == null && !speechActive && !ring.didDrop
        close()
        clean
    }

    /** Tear down without waiting. Idempotent. */
    suspend fun abort() = withContext(confined) { close() }

    private fun close() {
        if (closed) return
        closed = true
        sendLoop?.cancel()
        receiveLoop?.cancel()
        commands.close()
        eventChannel.close()
        transport.close()
    }

    val hasFailed: Boolean get() = failure != null
}
