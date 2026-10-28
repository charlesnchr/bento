package com.charles.bento.core.voice.gemini

import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.VoiceJsonCompact
import com.charles.bento.core.voice.VoiceLog
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Low-level Gemini API client over OkHttp, the API-key route only. Port of the
 * Mac's `GeminiClient`: the same request bodies, the same `x-goog-api-key` header
 * (never `?key=`), the same wall-clock deadline per call, and the ONE place HTTP
 * statuses map onto [TranscriptionError] (the retry queue branches on it).
 */
class GeminiClient(
    private val apiKey: () -> String?,
    httpClient: OkHttpClient = defaultHttpClient(),
) {
    private val http: OkHttpClient = httpClient

    /** How the transcription model formats its output. `verbatim` is the server default. */
    enum class TranscriptionMode(val wire: String) { VERBATIM("verbatim"), SMART("smart") }

    sealed class KeyCheck {
        data object Valid : KeyCheck()
        /** The server answered, and the answer was no. Never advance on this. */
        data class Rejected(val message: String?) : KeyCheck()
        /** No answer. Not the key's fault. */
        data object Unreachable : KeyCheck()
    }

    // MARK: - Calls

    /**
     * Audio transcription via `POST /v1beta/interactions`: the surface where
     * `mode: smart` works, with the model named in the body. Empty text comes back
     * as "" (the dictation pipeline owns the empty-transcript retry).
     */
    suspend fun transcribeInteraction(
        audio: ByteArray,
        mimeType: String = "audio/flac",
        model: String,
        endpoint: String = GeminiModels.ENDPOINT,
        mode: TranscriptionMode,
        customVocabulary: List<String>,
        deadline: Double,
    ): String {
        val body = buildJsonObject {
            put("model", model)
            putJsonArray("input") {
                addJsonObject {
                    put("type", "audio")
                    put("mime_type", mimeType)
                    put("data", Base64.getEncoder().encodeToString(audio))
                }
            }
            transcriptionConfig(mode, customVocabulary)?.let { config ->
                putJsonObject("generation_config") { put("transcription_config", config) }
            }
        }
        val data = post("v1beta/interactions", body, endpoint, deadline, model, modelIsInPath = false)
        return extractInteractionText(data)
    }

    /**
     * The legacy `:generateContent` transcription (verbatim only: `mode` returns an
     * empty text part here). `wordTimestamp` MUST be true or the transcript is empty.
     */
    suspend fun transcribe(
        flac: ByteArray,
        model: String,
        endpoint: String = GeminiModels.ENDPOINT,
        deadline: Double,
        customVocabulary: List<String> = emptyList(),
    ): String {
        val body = buildJsonObject {
            putJsonArray("contents") {
                addJsonObject {
                    put("role", "user")
                    putJsonArray("parts") {
                        addJsonObject {
                            putJsonObject("inline_data") {
                                put("mime_type", "audio/flac")
                                put("data", Base64.getEncoder().encodeToString(flac))
                            }
                        }
                    }
                }
            }
            putJsonObject("generationConfig") {
                put("temperature", 0)
                putJsonObject("audioTranscriptionConfig") {
                    put("wordTimestamp", true)
                    put("diarization", false)
                    if (customVocabulary.isNotEmpty()) putJsonArray("customVocabulary") { customVocabulary.forEach { add(it) } }
                }
            }
        }
        return generateContent(body, model, endpoint, deadline)
    }

    /**
     * A text call with the cleanup model's thinking config (Flash-Lite minimal, others
     * low). `audio` attaches a FLAC before the text, as Gemini recommends.
     */
    suspend fun cleanup(
        prompt: String,
        model: String,
        endpoint: String = GeminiModels.ENDPOINT,
        deadline: Double,
        audio: ByteArray? = null,
    ): String {
        val (thinkingKey, thinkingValue) = CleanupModels.thinkingConfig(model)
        val body = buildJsonObject {
            putJsonArray("contents") {
                addJsonObject {
                    put("role", "user")
                    putJsonArray("parts") {
                        if (audio != null) {
                            addJsonObject {
                                putJsonObject("inlineData") {
                                    put("mimeType", "audio/flac")
                                    put("data", Base64.getEncoder().encodeToString(audio))
                                }
                            }
                        }
                        addJsonObject { put("text", prompt) }
                    }
                }
            }
            putJsonObject("generationConfig") {
                put("temperature", 0)
                putJsonObject("thinkingConfig") {
                    when (thinkingValue) {
                        is Int -> put(thinkingKey, thinkingValue)
                        else -> put(thinkingKey, thinkingValue.toString())
                    }
                }
            }
        }
        return generateContent(body, model, endpoint, deadline)
    }

    /** Cheap key check for onboarding and Settings. A bad key is a 400 here, not a 401. */
    suspend fun validateKey(endpoint: String = GeminiModels.ENDPOINT): KeyCheck {
        val url = url(endpoint, "v1beta/models").newBuilder().addQueryParameter("pageSize", "1").build()
        val response = try {
            execute(get(url), 10.0)
        } catch (_: IOException) {
            return KeyCheck.Unreachable
        }
        return when (response.code) {
            200 -> KeyCheck.Valid
            400, 401, 403 -> KeyCheck.Rejected(errorMessage(response.body))
            in 500..599 -> KeyCheck.Unreachable
            else -> KeyCheck.Rejected(errorMessage(response.body))
        }
    }

    /** First model in `candidates` this key can reach, or null. */
    suspend fun resolveAvailableModel(candidates: List<String>, endpoint: String = GeminiModels.ENDPOINT): String? {
        for (model in candidates) {
            val response = try {
                execute(get(url(endpoint, "v1beta/models/$model")), 8.0)
            } catch (_: IOException) {
                continue
            }
            if (response.code == 200) return model
        }
        return null
    }

    // MARK: - Core

    private suspend fun generateContent(body: JsonObject, model: String, endpoint: String, deadline: Double): String {
        val data = post("v1beta/models/$model:generateContent", body, endpoint, deadline, model)
        return extractText(data)
    }

    /**
     * Shared transport for every POST: auth, the true wall-clock deadline, and the
     * status → error mapping. That mapping must never fork per endpoint.
     */
    internal suspend fun post(
        path: String,
        body: JsonObject,
        endpoint: String,
        deadline: Double,
        modelLabel: String,
        /** False when the model is in the BODY (interactions): a 403/404 is then about the endpoint. */
        modelIsInPath: Boolean = true,
        isRetryAfter429: Boolean = false,
    ): String {
        val bytes = VoiceJsonCompact.encodeToString(JsonObject.serializer(), body).toByteArray()
        val request = Request.Builder()
            .url(url(endpoint, path))
            .post(bytes.toRequestBody(JSON))
            .header("Content-Type", "application/json")
            .apply { apiKey()?.let { header("x-goog-api-key", it) } }
            .build()
        val response = try {
            execute(request, deadline)
        } catch (e: IOException) {
            throw mapIOException(e)
        }
        val data = response.body
        when (response.code) {
            200 -> return data
            401 -> throw TranscriptionError.Auth
            403, 404 -> {
                val message = errorMessage(data)
                VoiceLog.e(TAG, "${response.code} on $path ($modelLabel)")
                if (!modelIsInPath) throw TranscriptionError.Network("interactions_unavailable_${response.code}")
                throw TranscriptionError.ModelUnavailable(modelLabel, message)
            }
            429 -> {
                // Per-minute throttles carry a short retryDelay: honour it once.
                val delaySeconds = retryDelaySeconds(data, response.retryAfter)
                if (!isRetryAfter429 && delaySeconds != null && delaySeconds <= 8) {
                    VoiceLog.i(TAG, "429 with retryDelay ${delaySeconds}s — waiting once")
                    delay((delaySeconds * 1000).toLong())
                    return post(path, body, endpoint, deadline, modelLabel, modelIsInPath, isRetryAfter429 = true)
                }
                // Only a real daily quota is terminal; a per-minute throttle stays retryable.
                if (DAILY_QUOTA.containsMatchIn(data)) throw TranscriptionError.RateLimitedDaily
                throw TranscriptionError.RateLimitedTransient
            }
            400 -> throw TranscriptionError.BadRequest(errorMessage(data) ?: "http_400")
            in 500..599 -> throw TranscriptionError.Network("http_${response.code}")
            else -> throw TranscriptionError.Network(errorMessage(data) ?: "http_${response.code}")
        }
    }

    private class RawResponse(val code: Int, val body: String, val retryAfter: String?)

    private fun get(url: HttpUrl): Request = Request.Builder().url(url).get()
        .apply { apiKey()?.let { header("x-goog-api-key", it) } }.build()

    /** Runs a call with a hard deadline; cancelling the coroutine cancels the call. */
    private suspend fun execute(request: Request, deadline: Double): RawResponse {
        val millis = (deadline * 1000).toLong().coerceAtLeast(1)
        val client = http.newBuilder()
            .callTimeout(millis, TimeUnit.MILLISECONDS)
            .readTimeout(millis, TimeUnit.MILLISECONDS)
            .writeTimeout(millis, TimeUnit.MILLISECONDS)
            .connectTimeout(minOf(millis, 30_000), TimeUnit.MILLISECONDS)
            .build()
        val call = client.newCall(request)
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = try {
                        response.use { RawResponse(it.code, it.body.string(), it.header("Retry-After")) }
                    } catch (e: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                        return
                    }
                    if (continuation.isActive) continuation.resume(result)
                }
            })
        }
    }

    companion object {
        private const val TAG = "GeminiClient"
        private val JSON = "application/json".toMediaType()
        private val DAILY_QUOTA = Regex("\"quotaId\"\\s*:\\s*\"[^\"]*PerDay[^\"]*\"")
        private val RETRY_DELAY = Regex("\"retryDelay\"\\s*:\\s*\"([0-9.]+)s\"")

        /** No redirects (a redirect would carry the key elsewhere); fail fast, no connectivity waits. */
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .build()

        internal fun url(endpoint: String, path: String): HttpUrl {
            val base = endpoint.trimEnd('/')
            return "$base/$path".toHttpUrl()
        }

        /** Network failure → typed error. Offline-looking failures queue the recording for retry. */
        internal fun mapIOException(e: IOException): TranscriptionError = when {
            e is UnknownHostException || e is NoRouteToHostException || e is ConnectException -> TranscriptionError.Offline
            e is SocketException && (e.message?.contains("unreachable", ignoreCase = true) == true) -> TranscriptionError.Offline
            e is SocketTimeoutException -> TranscriptionError.Timeout
            e is InterruptedIOException && (e.message?.contains("timeout", ignoreCase = true) == true) -> TranscriptionError.Timeout
            else -> TranscriptionError.Network(e.javaClass.simpleName)
        }

        /**
         * The ONLY place a transcription_config is built. NEVER add `language_codes`:
         * with `mode: smart` it silently returns verbatim output (verified on the Mac).
         */
        internal fun transcriptionConfig(mode: TranscriptionMode, customVocabulary: List<String>): JsonObject? = when (mode) {
            TranscriptionMode.VERBATIM ->
                if (customVocabulary.isEmpty()) null
                else buildJsonObject { putJsonArray("custom_vocabulary") { customVocabulary.forEach { add(it) } } }
            TranscriptionMode.SMART -> buildJsonObject {
                put("mode", "smart")
                if (customVocabulary.isNotEmpty()) putJsonArray("custom_vocabulary") { customVocabulary.forEach { add(it) } }
            }
        }

        private fun parse(data: String): JsonElement? = runCatching { VoiceJsonCompact.parseToJsonElement(data) }.getOrNull()

        /** `candidates/content/parts` envelope. Empty text is "", not an error. */
        internal fun extractText(data: String): String {
            val json = parse(data) as? JsonObject ?: throw TranscriptionError.Network("unparseable_response")
            val feedback = json["promptFeedback"] as? JsonObject
            if (feedback?.get("blockReason") != null) throw TranscriptionError.SafetyBlocked
            val first = (json["candidates"] as? JsonArray)?.firstOrNull() as? JsonObject
                ?: throw TranscriptionError.Network("no_candidates")
            if ((first["finishReason"] as? JsonPrimitive)?.contentOrNull == "SAFETY") throw TranscriptionError.SafetyBlocked
            val parts = ((first["content"] as? JsonObject)?.get("parts") as? JsonArray) ?: return ""
            return parts.mapNotNull { ((it as? JsonObject)?.get("text") as? JsonPrimitive)?.contentOrNull }.joinToString("")
        }

        /** interactions envelope: {"status","steps":[{"type":"model_output","content":[{"type":"text","text"}]}]}. */
        internal fun extractInteractionText(data: String): String {
            val json = parse(data) as? JsonObject ?: throw TranscriptionError.Network("unparseable_response")
            val status = (json["status"] as? JsonPrimitive)?.contentOrNull ?: "missing"
            if (status != "completed") throw mapInteractionStatus(status, json)
            val steps = json["steps"] as? JsonArray ?: throw TranscriptionError.Network("no_steps")
            return steps.asSequence()
                .mapNotNull { it as? JsonObject }
                .filter { (it["type"] as? JsonPrimitive)?.contentOrNull == "model_output" }
                .flatMap { ((it["content"] as? JsonArray) ?: JsonArray(emptyList())).asSequence() }
                .mapNotNull { part ->
                    val obj = part as? JsonObject ?: return@mapNotNull null
                    if ((obj["type"] as? JsonPrimitive)?.contentOrNull == "text") (obj["text"] as? JsonPrimitive)?.contentOrNull else null
                }
                .joinToString("")
        }

        /** A 200 with a non-"completed" status. Unknown statuses stay retryable (`Network`). */
        internal fun mapInteractionStatus(status: String, json: JsonObject): TranscriptionError {
            val detail = ((json["error"] as? JsonObject)?.get("message") as? JsonPrimitive)?.contentOrNull ?: ""
            if (status == "failed" || status == "error") {
                val lowered = detail.lowercase()
                if (lowered.contains("safety") || lowered.contains("blocked")) return TranscriptionError.SafetyBlocked
                return TranscriptionError.Network("interaction_failed")
            }
            return TranscriptionError.Network("interaction_status_$status")
        }

        /** A short retry hint from a 429: the Retry-After header or a RetryInfo "retryDelay": "2s". */
        internal fun retryDelaySeconds(data: String, retryAfterHeader: String?): Double? {
            retryAfterHeader?.trim()?.toDoubleOrNull()?.let { return it }
            return RETRY_DELAY.find(data)?.groupValues?.get(1)?.toDoubleOrNull()
        }

        /**
         * The two endpoints do not share an error envelope: `{"error":{...}}` on
         * generateContent, `[{"error":{...}}]` on interactions.
         */
        internal fun errorMessage(data: String): String? {
            val root = parse(data)
            val obj = when (root) {
                is JsonObject -> root
                is JsonArray -> root.firstOrNull() as? JsonObject
                else -> null
            }
            val error = obj?.get("error") as? JsonObject ?: return null
            return (error["message"] as? JsonPrimitive)?.contentOrNull
        }
    }
}
