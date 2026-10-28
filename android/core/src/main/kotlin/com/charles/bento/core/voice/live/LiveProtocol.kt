package com.charles.bento.core.voice.live

import com.charles.bento.core.voice.VoiceJsonCompact
import com.charles.bento.core.voice.gemini.GeminiModels
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.util.Base64

sealed class LiveEvent {
    /** The credential was accepted and the session is configured. */
    data object SetupComplete : LiveEvent()
    /** A speculative hypothesis. Display only: never the transcript. */
    data class Partial(val text: String) : LiveEvent()
    /** Authoritative text for a finished segment (already formatted in SMART mode). */
    data class Final(val text: String) : LiveEvent()
    /** The server opened a turn; its presence means this server reports turn ends. */
    data object ActivityStarted : LiveEvent()
    /** The server closed the turn having heard this many seconds (null if unstated). */
    data class ActivityEnded(val offsetSeconds: Double?) : LiveEvent()
    /** The server is closing the session. */
    data object GoAway : LiveEvent()
    /** An error envelope. Terminal. */
    data class Failed(val message: String) : LiveEvent()
}

data class LiveSetup(
    val model: String = GeminiModels.TRANSCRIBE_LIVE,
    val smart: Boolean = true,
    val customVocabulary: List<String> = emptyList(),
)

class LiveError(message: String, val refused: Boolean = false) : Exception(message) {
    companion object {
        fun refused(why: String) = LiveError(why, refused = true)
        fun setupTimedOut() = LiveError("setup timed out")
    }

    override fun equals(other: Any?) = other is LiveError && other.message == message && other.refused == refused
    override fun hashCode() = (message?.hashCode() ?: 0) * 31 + refused.hashCode()
}

/** Wire format of the Live API's dictation sessions (JSON text frames). */
object LiveProtocol {
    const val AUDIO_MIME = "audio/pcm;rate=16000"

    /**
     * The ONLY place a dictation setup frame is built. NEVER add `languageCodes`
     * without probing: with SMART it silently returns verbatim text. Manual VAD:
     * turn boundaries come from the user, so server-side detection would cut a turn
     * while someone pauses to think.
     */
    fun setupFrame(setup: LiveSetup): String = encode(buildJsonObject {
        putJsonObject("setup") {
            put("model", "models/${setup.model}")
            putJsonObject("generationConfig") { putJsonArray("responseModalities") { add("TEXT") } }
            putJsonObject("inputAudioTranscription") {
                put("mode", if (setup.smart) "SMART" else "VERBATIM")
                if (setup.customVocabulary.isNotEmpty()) putJsonArray("customVocabulary") { setup.customVocabulary.forEach { add(it) } }
            }
            putJsonObject("realtimeInputConfig") {
                putJsonObject("automaticActivityDetection") { put("disabled", true) }
            }
        }
    })

    fun audioFrame(pcm: ByteArray): String = encode(buildJsonObject {
        putJsonObject("realtimeInput") {
            putJsonObject("audio") {
                put("data", Base64.getEncoder().encodeToString(pcm))
                put("mimeType", AUDIO_MIME)
            }
        }
    })

    fun activityStartFrame(): String = """{"realtimeInput":{"activityStart":{}}}"""
    fun activityEndFrame(): String = """{"realtimeInput":{"activityEnd":{}}}"""

    internal fun encode(obj: JsonObject) = VoiceJsonCompact.encodeToString(JsonObject.serializer(), obj)

    internal fun parseObject(frame: String): JsonObject? =
        runCatching { VoiceJsonCompact.parseToJsonElement(frame) as? JsonObject }.getOrNull()

    /**
     * Decodes one server frame; null for anything unrecognised (an unknown message is
     * no reason to tear down a session that is transcribing someone's sentence).
     * Interim is checked before final: one frame may carry both, and treating an
     * interim as final would put speculative text on the cursor.
     */
    fun decode(frame: String): LiveEvent? {
        val root = parseObject(frame) ?: return null
        if (root.has("setupComplete", "setup_complete")) return LiveEvent.SetupComplete
        (root["error"] as? JsonObject)?.let { error ->
            return LiveEvent.Failed(error.string("message") ?: "unknown live error")
        }
        val content = root.obj("serverContent", "server_content")
        if (content != null) {
            if (content.has("goAway", "go_away")) return LiveEvent.GoAway
            transcriptText(content, "interimInputTranscription", "interim_input_transcription", trim = false)
                ?.let { return LiveEvent.Partial(it) }
            transcriptText(content, "inputTranscription", "input_transcription", trim = false)
                ?.let { return LiveEvent.Final(it) }
        }
        if (root.has("goAway", "go_away")) return LiveEvent.GoAway
        // Sent even with automatic activity detection off (probed 2026-10-26).
        // ACTIVITY_END normally answers activityEnd with audioOffset = audio sent; the
        // server can also close a long turn by itself during a pause.
        val activity = root.obj("voiceActivity", "voice_activity")
        if (activity != null) {
            val type = activity.string("type") ?: activity.string("voiceActivityType") ?: ""
            if (type.endsWith("START")) return LiveEvent.ActivityStarted
            if (type.endsWith("END")) return LiveEvent.ActivityEnded(parseDuration(activity["audioOffset"] ?: activity["audio_offset"]))
        }
        return null
    }

    /** "0.320s" (protobuf Duration in JSON), or a bare number. */
    fun parseDuration(value: JsonElement?): Double? {
        val p = value as? JsonPrimitive ?: return null
        if (p is JsonNull) return null
        if (!p.isString) return p.doubleOrNull
        val text = p.content
        return (if (text.endsWith("s")) text.dropLast(1) else text).toDoubleOrNull()
    }

    /** camelCase or snake_case: the two documented clients disagree about which the socket speaks. */
    internal fun transcriptText(content: JsonObject, camel: String, snake: String, trim: Boolean): String? {
        val node = content.obj(camel, snake) ?: return null
        val text = node.string("text") ?: return null
        val value = if (trim) text.trim() else text
        return value.ifEmpty { null }
    }

    internal fun JsonObject.has(vararg keys: String) = keys.any { containsKey(it) }
    internal fun JsonObject.obj(vararg keys: String): JsonObject? = keys.firstNotNullOfOrNull { this[it] as? JsonObject }
    internal fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
}
