package com.charles.bento.core.voice

/**
 * Every way a Gemini call can fail, typed so the retry queue and the dictation
 * failure matrix can branch on it. Mirrors the Mac's `TranscriptionError`; the
 * HTTP status → case mapping lives in one place ([com.charles.bento.core.voice.gemini.GeminiClient]).
 */
sealed class TranscriptionError(message: String) : Exception(message) {
    data object Offline : TranscriptionError("offline")
    data class Network(val detail: String) : TranscriptionError("network: $detail")
    /** Permanent request failure (400): retrying is pointless. */
    data class BadRequest(val detail: String) : TranscriptionError("bad request: $detail")
    /** 401: the key itself was rejected. */
    data object Auth : TranscriptionError("auth")
    /** 403/404: the key is fine but this model is gated, renamed or unknown. */
    data class ModelUnavailable(val model: String, val detail: String?) : TranscriptionError("model unavailable: $model")
    /** 429 that is a real daily quota. */
    data object RateLimitedDaily : TranscriptionError("daily quota")
    /** 429 per-minute throttle: clears on its own, retryable. */
    data object RateLimitedTransient : TranscriptionError("rate limited")
    data object Timeout : TranscriptionError("timeout")
    data object EmptyTranscript : TranscriptionError("empty transcript")
    data object SafetyBlocked : TranscriptionError("safety blocked")
    /** Kept for parity with the Mac's dual review; unused on the API-key route. */
    data object ReviewRejected : TranscriptionError("review rejected")

    /** A short description for a History row or a meeting gap ("Network error"). */
    val userDescription: String
        get() = when (this) {
            Offline -> "Offline"
            is Network -> "Network error"
            Timeout -> "Timed out"
            Auth -> "Authentication failed"
            is ModelUnavailable -> "Transcription model unavailable"
            RateLimitedDaily -> "Daily quota reached"
            RateLimitedTransient -> "Rate limited"
            is BadRequest -> "Request rejected"
            SafetyBlocked -> "Declined by the model"
            EmptyTranscript -> "No speech found"
            ReviewRejected -> "Review failed validation"
        }
}
