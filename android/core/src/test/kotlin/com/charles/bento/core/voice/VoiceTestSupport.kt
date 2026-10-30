package com.charles.bento.core.voice

import com.charles.bento.core.voice.live.LiveTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.io.IOException
import java.nio.file.Files
import kotlin.math.PI
import kotlin.math.sin

/** JUnit 5 skips non-void test methods, so every coroutine test goes through this. */
fun blocking(block: suspend CoroutineScope.() -> Unit): Unit = runBlocking { block() }

fun tempDir(prefix: String): File = Files.createTempDirectory("bento-voice-$prefix").toFile().also { it.deleteOnExit() }

/** Speech-ish test audio: a few harmonics with a slow amplitude envelope. */
fun tone(seconds: Double, amplitude: Double = 8_000.0, frequency: Double = 220.0, sampleRate: Int = 16_000): ShortArray {
    val n = (seconds * sampleRate).toInt()
    return ShortArray(n) { i ->
        val t = i.toDouble() / sampleRate
        val envelope = 0.6 + 0.4 * sin(2 * PI * 3 * t)
        val v = amplitude * envelope * (sin(2 * PI * frequency * t) + 0.5 * sin(2 * PI * 2 * frequency * t) + 0.25 * sin(2 * PI * 3 * frequency * t)) / 1.75
        v.toInt().coerceIn(-32768, 32767).toShort()
    }
}

fun silence(seconds: Double): ShortArray = ShortArray((seconds * 16_000).toInt())

fun json(vararg pairs: Pair<String, Any?>): String = VoiceJsonCompact.encodeToString(JsonObject.serializer(), obj(*pairs))

@Suppress("UNCHECKED_CAST")
fun obj(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
    for ((k, v) in pairs) put(k, element(v))
}

@Suppress("UNCHECKED_CAST")
private fun element(v: Any?): JsonElement = when (v) {
    null -> kotlinx.serialization.json.JsonNull
    is JsonElement -> v
    is String -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    is Map<*, *> -> JsonObject((v as Map<String, Any?>).mapValues { element(it.value) })
    is List<*> -> kotlinx.serialization.json.JsonArray(v.map { element(it) })
    else -> error("unsupported $v")
}

/** A socket that says what the test tells it to say (port of the Mac's FakeTransport). */
class FakeTransport(script: List<String>) : LiveTransport {
    private val lock = Any()
    private val inbox = ArrayDeque(script)
    private val sentFrames = ArrayList<String>()
    var connectError: Exception? = null
    var sendErrorAfter: Int? = null
    var receiveHangs = false
    /** Frames the server sends once activityEnd reaches it, as a real one does. */
    var replyToActivityEnd: List<String> = emptyList()
    /** Frames sent once audioStreamEnd reaches it (meetings). */
    var replyToStreamEnd: List<String> = emptyList()
    @Volatile var closeCount = 0
        private set
    /** Runs before each send, outside the lock: a slow or held-up socket. */
    @Volatile var beforeSend: (suspend (String) -> Unit)? = null

    val sent: List<String> get() = synchronized(lock) { sentFrames.toList() }

    fun push(frame: String) = synchronized(lock) { inbox.addLast(frame) }

    override suspend fun connect() {
        connectError?.let { throw it }
    }

    override suspend fun send(frame: String) {
        beforeSend?.invoke(frame)
        synchronized(lock) {
            val limit = sendErrorAfter
            if (limit != null && sentFrames.size >= limit) throw IOException("network connection lost")
            sentFrames.add(frame)
            if (frame.contains("\"activityEnd\"")) inbox.addAll(replyToActivityEnd)
            if (frame.contains("\"audioStreamEnd\"")) inbox.addAll(replyToStreamEnd)
        }
    }

    override suspend fun receive(): String {
        if (receiveHangs) {
            delay(30_000)
            throw IOException("timed out")
        }
        repeat(3_000) {
            synchronized(lock) { inbox.removeFirstOrNull() }?.let { return it }
            if (closeCount > 0) throw IOException("closed")
            delay(10)
        }
        throw IOException("timed out")
    }

    override fun close() {
        synchronized(lock) { closeCount++ }
    }

    /** What was put on the wire, in order, as kinds. */
    val sentKinds: List<String>
        get() = sent.mapNotNull { frame ->
            when {
                frame.contains("\"setup\"") -> "setup"
                frame.contains("\"activityStart\"") -> "activityStart"
                frame.contains("\"activityEnd\"") -> "activityEnd"
                frame.contains("\"audioStreamEnd\"") -> "audioStreamEnd"
                frame.contains("\"audio\"") -> "audio"
                else -> null
            }
        }
}

object Frames {
    fun setupComplete() = """{"setupComplete":{}}"""
    fun final(text: String) = json("serverContent" to mapOf("inputTranscription" to mapOf("text" to text)))
    fun partial(text: String) = json("serverContent" to mapOf("interimInputTranscription" to mapOf("text" to text)))
    fun activity(type: String, offset: String = "0s") = json("voiceActivity" to mapOf("type" to type, "audioOffset" to offset))
    fun error(message: String) = json("error" to mapOf("message" to message))
}
