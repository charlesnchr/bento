package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.gemini.GeminiModels
import com.charles.bento.core.voice.live.LiveProtocol
import com.charles.bento.core.voice.live.LiveTransport
import com.charles.bento.core.voice.meeting.MeetingLiveEvent
import com.charles.bento.core.voice.meeting.MeetingLiveProtocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ChannelResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeoutOrNull

/** What the captioner hears of the user's speech: display only, never a request. */
sealed interface Caption {
    /** The user started an utterance; [at] is when its first audio was captured (the call's clock), if known. */
    data class Started(val at: Double? = null) : Caption
    /** The utterance so far: each one replaces the last. */
    data class Partial(val text: String) : Caption
    /** The utterance ended (or the captioner lost it). */
    data object Ended : Caption
}

/** Live captions of the user's speech during a call; faked in tests. */
interface CallCaptions {
    /** [onCaption] is called from the captioner's own thread. */
    fun start(onCaption: (Caption) -> Unit)
    /** Microphone audio the call sent to Gemini (16 kHz PCM16). Must not block. */
    fun feed(pcm: ByteArray)
    /** The microphone went quiet (muted, standby): the utterance ends now, not at the next pause. */
    fun pause()
    fun stop()
}

/**
 * The words a user is saying in a call, shown while they speak. Gemini Live sends the
 * user's transcript in one piece just after they stop: measured on gemini-3.8-live on
 * 2026-10-30, 12.4 s of speech came as one inputTranscription 0.9 s after it ended, with
 * nothing during it. So the call also streams the audio it sends Gemini to Gemini's
 * transcription model, which sends a growing hypothesis about every half second.
 *
 * Display only: Hermes still gets Gemini Live's own transcript ([CallProtocol]), and
 * the call drops a caption once that transcript arrives. A captioner that can't connect
 * gives up quietly; the call goes on without captions.
 *
 * A socket opens with the first audio, so a muted call opens none, and closes after
 * [idleSeconds] without audio (a long mute, standby). One that ends (Gemini rotates
 * connections after about ten minutes) is replaced at the next audio: captions need no
 * memory of earlier speech.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LiveCaptions(
    private val transport: () -> LiveTransport,
    private val model: String = GeminiModels.TRANSCRIBE_LIVE,
    private val idleSeconds: Double = 20.0,
    private val setupSeconds: Double = 10.0,
    private val retrySeconds: Double = 5.0,
    private val maxFailures: Int = 3,
    /** The call's clock ([AssistantCall]'s), for when an utterance's audio was captured. */
    private val clock: () -> Double = { System.nanoTime() / 1e9 },
) : CallCaptions {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1))
    /** Audio ([pcm] null: "the microphone went quiet") and when it came. */
    private class Frame(val pcm: ByteArray?, val at: Double)

    /** About two seconds wait while a socket opens. */
    private val audio = Channel<Frame>(100, BufferOverflow.DROP_OLDEST)
    @Volatile private var stopped = false

    override fun start(onCaption: (Caption) -> Unit) {
        scope.launch { run(onCaption) }
    }

    override fun feed(pcm: ByteArray) {
        if (!stopped) audio.trySend(Frame(pcm, clock()))
    }

    override fun pause() {
        if (!stopped) audio.trySend(Frame(null, clock()))
    }

    override fun stop() {
        stopped = true
        audio.close()
        scope.cancel()
    }

    private suspend fun run(onCaption: (Caption) -> Unit) {
        var failures = 0
        while (scope.isActive) {
            // Nothing opens until there is something to hear.
            val first = audio.receiveCatching().getOrNull() ?: return
            if (first.pcm == null) continue
            val socket = transport()
            val end = try {
                if (open(socket)) stream(socket, first, onCaption) else End(broke = true, captioned = false)
            } finally {
                socket.close()
            }
            // Only captions prove the captioner works; a socket that broke waits before the next.
            if (end.captioned) failures = 0
            if (!end.broke) continue
            if (!end.captioned && ++failures >= maxFailures) return
            delay((retrySeconds * 1000).toLong())
            while (audio.tryReceive().isSuccess) Unit // what was said meanwhile is gone
        }
    }

    private suspend fun open(socket: LiveTransport): Boolean = try {
        withTimeoutOrNull((setupSeconds * 1000).toLong()) {
            socket.connect()
            socket.send(MeetingLiveProtocol.setupFrame(model, VOCABULARY))
            var events = emptyList<MeetingLiveEvent>()
            while (events.none { it == MeetingLiveEvent.SetupComplete || it is MeetingLiveEvent.Failed }) {
                events = MeetingLiveProtocol.decode(socket.receive())
            }
            MeetingLiveEvent.SetupComplete in events
        } == true
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        false
    }

    /** How a socket ended: [broke] by an error or a drop (not idle, goAway or stop), having [captioned] or not. */
    private data class End(val broke: Boolean, val captioned: Boolean)

    /** Sends audio and relays captions until the socket ends or goes idle. */
    private suspend fun stream(socket: LiveTransport, first: Frame, onCaption: (Caption) -> Unit): End {
        var speaking = false
        var captioned = false
        var broke = false
        // Seconds of audio sent on this socket, and where it jumped in time (a mute, dropped frames):
        // the server counts an utterance's start in audio, the call in time.
        var sent = 0.0
        val marks = ArrayDeque<Pair<Double, Double>>()
        fun capturedAt(offset: Double): Double? = marks.lastOrNull { it.first <= offset }?.let { it.second + offset - it.first }
        suspend fun send(frame: Frame) {
            val pcm = frame.pcm
            if (pcm == null) { socket.send(MeetingLiveProtocol.streamEndFrame()); return }
            val expected = marks.lastOrNull()?.let { it.second + sent - it.first }
            if (expected == null || kotlin.math.abs(frame.at - expected) > 0.1) {
                marks.addLast(sent to frame.at)
                if (marks.size > 64) marks.removeFirst()
            }
            socket.send(LiveProtocol.audioFrame(pcm))
            sent += pcm.size / 32_000.0
        }
        val reader = scope.launch {
            try {
                while (isActive) {
                    for (event in MeetingLiveProtocol.decode(socket.receive())) when (event) {
                        is MeetingLiveEvent.ActivityStart -> { speaking = true; onCaption(Caption.Started(capturedAt(event.offset))) }
                        is MeetingLiveEvent.Interim -> { captioned = true; onCaption(Caption.Partial(event.text)) }
                        is MeetingLiveEvent.Final, is MeetingLiveEvent.ActivityEnd -> if (speaking) { speaking = false; onCaption(Caption.Ended) }
                        MeetingLiveEvent.GoAway -> return@launch
                        is MeetingLiveEvent.Failed -> { broke = true; return@launch }
                        else -> Unit
                    }
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                broke = true
            }
        }
        try {
            send(first)
            while (reader.isActive) {
                val next = withTimeoutOrNull((idleSeconds * 1000).toLong()) {
                    select<ChannelResult<Frame>?> { reader.onJoin { null }; audio.onReceiveCatching { it } }
                } ?: break
                send(next.getOrNull() ?: break)
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            broke = true
        } finally {
            reader.cancel()
            if (speaking) onCaption(Caption.Ended)
        }
        return End(broke, captioned)
    }

    companion object {
        /** The call's own words, as Gemini Live's setup has them. */
        val VOCABULARY = listOf("Hermes", "Bento")
    }
}
