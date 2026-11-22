package com.charles.bento.assistant

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.charles.bento.core.assistant.live.AssistantCall
import com.charles.bento.core.assistant.live.CallAudio
import com.charles.bento.core.assistant.live.CoreCall
import com.charles.bento.core.assistant.live.HermesCall
import com.charles.bento.core.assistant.live.ToolReply
import com.charles.bento.core.voice.live.LiveTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The voice core as the app ships it, on a device: the bundle in the APK's assets, in the phone's
 * QuickJS (the native library for this ABI), running a call against a scripted Gemini socket. The
 * JVM tests (CoreCallTest in :core) cover what a call does; this covers that it runs here at all.
 *
 *     ANDROID_SERIAL=emulator-5554 gradle :app:connectedDebugAndroidTest
 */
@RunWith(AndroidJUnit4::class)
class CoreCallOnDeviceTest {
    /** A socket that takes what's sent and gives back what the test pushes. */
    private class ScriptedSocket : LiveTransport {
        val sent = CopyOnWriteArrayList<String>()
        private val inbox = Channel<String>(Channel.UNLIMITED)
        fun push(frame: String) { inbox.trySend(frame) }
        override suspend fun connect() {}
        override suspend fun send(frame: String) { sent.add(frame) }
        override suspend fun receive(): String = inbox.receiveCatching().getOrNull() ?: throw IOException("closed")
        override fun close() { inbox.close() }
    }

    /** A quiet room in 20 ms frames, and a speaker that counts. */
    private class QuietAudio : CallAudio {
        @Volatile var stopped = false
        @Volatile var played = 0
        override fun start(onPcm: (ByteArray) -> Unit): Boolean {
            Thread {
                while (!stopped) { onPcm(ByteArray(640) { i -> if (i % 64 == 0) 1 else 0 }); Thread.sleep(20) }
            }.apply { isDaemon = true; start() }
            return true
        }
        override fun play(pcm: ByteArray) { played += pcm.size }
        override fun flush() {}
        override fun restartMicrophone() {}
        override fun stop() { stopped = true }
    }

    @Test fun theBundleInTheApkRunsACall() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val bundle = context.assets.open(AssistantController.CORE_BUNDLE).bufferedReader().use { it.readText() }
        val socket = ScriptedSocket()
        val audio = QuietAudio()
        val asked = CompletableDeferred<HermesCall>()
        val call = CoreCall(bundle, CoreCall.config(today = "2026-11-22"), { socket }, audio, { asked.complete(it); ToolReply("Sunny, twelve degrees.") })
        call.start()
        socket.push("""{"setupComplete":{}}""")
        withTimeout(20_000) { call.status.first { it == AssistantCall.Status.Listening } }
        withTimeout(10_000) { while (socket.sent.count { "realtimeInput" in it } < 10) delay(20) }
        assertTrue("the core's setup goes first", socket.sent.first().contains("\"setup\"") && socket.sent.first().contains("Bento on Android"))

        socket.push("""{"voiceActivity":{"type":"ACTIVITY_START"}}""")
        socket.push("""{"serverContent":{"inputTranscription":{"text":"What's the weather in Copenhagen?"}}}""")
        socket.push("""{"voiceActivity":{"type":"ACTIVITY_END"}}""")
        socket.push("""{"toolCall":{"functionCalls":[{"id":"c1","name":"ask_hermes","args":{"label":"Copenhagen weather"}}]}}""")
        val request = withTimeout(20_000) { asked.await() }
        assertEquals("What's the weather in Copenhagen?", request.task)
        withTimeout(20_000) { while (socket.sent.none { "Sunny, twelve degrees." in it }) delay(20) }

        call.stop()
        val ended = withTimeout(10_000) { call.status.first { it is AssistantCall.Status.Ended } as AssistantCall.Status.Ended }
        assertNull(ended.message)
        assertTrue(audio.stopped)
    }
}
