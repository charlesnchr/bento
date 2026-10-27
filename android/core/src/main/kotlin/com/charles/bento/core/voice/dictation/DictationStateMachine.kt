package com.charles.bento.core.voice.dictation

/** Why a dictation failed (the Mac's failure matrix). */
enum class DictationFailure {
    /** Audio capture failed to start or died. */
    AUDIO,
    /** No input device at all. */
    NO_MICROPHONE,
    /** Zero samples captured: never shown as an empty transcript. */
    NO_AUDIO,
    /** Transport failure after the silent retry. */
    NETWORK,
    /** 401: key invalid or revoked. */
    AUTH,
    /** 403/404: key fine, model gated or renamed. */
    MODEL_ACCESS,
    /** 400: permanent request failure. */
    BAD_REQUEST,
    /** 429 per-minute throttle; retryable from History. */
    RATE_LIMITED,
    /** 429 daily quota. */
    QUOTA_EXHAUSTED,
    TIMEOUT,
    /** Speech energy but no transcript. Retryable. */
    VALIDATION,
    SAFETY_BLOCKED,
    /** Disk write failure. */
    STORAGE,
}

/** How a finished dictation ended up. */
enum class DictationOutcomeKind {
    /** Text landed (the app's inserter reported success). */
    INSERTED,
    /** The target changed mid-flight; the app offered the text instead of pasting blind. */
    AWAITING_CHIP,
    /** The app put the text on the clipboard. */
    COPIED_TO_CLIPBOARD,
    /** A secure field was focused: the text lives in History only. */
    HELD_FOR_SECURE_FIELD,
    /** Offline: recording queued for retry. */
    QUEUED_FOR_RETRY,
    /** Silence only: no error theatrics. */
    SILENT,
}

sealed class DictationState {
    data object Idle : DictationState()
    /** Session folder created, waiting for audio. */
    data object Warming : DictationState()
    data class Recording(val locked: Boolean) : DictationState()
    /** Stop requested: trailing speech captured, recording closed. */
    data object Finalizing : DictationState()
    data object Transcribing : DictationState()
    data object Inserting : DictationState()
    data class Done(val outcome: DictationOutcomeKind) : DictationState()
    data object Cancelled : DictationState()
    data class Failed(val failure: DictationFailure) : DictationState()

    val isTerminal: Boolean get() = this is Done || this is Cancelled || this is Failed
}

sealed class DictationEvent {
    data object HotkeyBegin : DictationEvent()
    data object LockIn : DictationEvent()
    data object Finalize : DictationEvent()
    data object Cancel : DictationEvent()
    data object AbortAccidental : DictationEvent()
    data object EngineStarted : DictationEvent()
    data class EngineFailed(val failure: DictationFailure) : DictationEvent()
    data object AudioFinalized : DictationEvent()
    data object NoAudioCaptured : DictationEvent()
    data object SilenceOnly : DictationEvent()
    data object TranscriptReady : DictationEvent()
    data class TranscriptFailed(val failure: DictationFailure) : DictationEvent()
    data object QueuedForRetry : DictationEvent()
    data object Inserted : DictationEvent()
    data object InsertionFellBackToClipboard : DictationEvent()
    data object FrontmostChangedAwaitingChip : DictationEvent()
    data object InsertionBlockedSecure : DictationEvent()
}

/** The pure state machine; null means the event is ignored in that state. */
object DictationStateMachine {
    fun transition(state: DictationState, event: DictationEvent): DictationState? = when (state) {
        DictationState.Idle -> when (event) {
            DictationEvent.HotkeyBegin -> DictationState.Warming
            else -> null
        }
        DictationState.Warming -> when (event) {
            DictationEvent.EngineStarted -> DictationState.Recording(locked = false)
            is DictationEvent.EngineFailed -> DictationState.Failed(event.failure)
            DictationEvent.Cancel, DictationEvent.AbortAccidental -> DictationState.Cancelled
            // Released before audio started: still a real dictation.
            DictationEvent.Finalize -> DictationState.Finalizing
            else -> null
        }
        is DictationState.Recording -> when (event) {
            DictationEvent.LockIn -> if (!state.locked) DictationState.Recording(locked = true) else null
            DictationEvent.Finalize -> DictationState.Finalizing
            DictationEvent.Cancel, DictationEvent.AbortAccidental -> DictationState.Cancelled
            // Capture died mid-recording: what was written is kept and finalized.
            is DictationEvent.EngineFailed -> DictationState.Finalizing
            else -> null
        }
        DictationState.Finalizing -> when (event) {
            DictationEvent.AudioFinalized -> DictationState.Transcribing
            DictationEvent.NoAudioCaptured -> DictationState.Failed(DictationFailure.NO_AUDIO)
            DictationEvent.SilenceOnly -> DictationState.Done(DictationOutcomeKind.SILENT)
            DictationEvent.Cancel -> DictationState.Cancelled
            else -> null
        }
        DictationState.Transcribing -> when (event) {
            DictationEvent.TranscriptReady -> DictationState.Inserting
            DictationEvent.SilenceOnly -> DictationState.Done(DictationOutcomeKind.SILENT)
            is DictationEvent.TranscriptFailed -> DictationState.Failed(event.failure)
            DictationEvent.QueuedForRetry -> DictationState.Done(DictationOutcomeKind.QUEUED_FOR_RETRY)
            DictationEvent.Cancel -> DictationState.Cancelled
            else -> null
        }
        // No cancel while inserting: the text exists and History has it regardless.
        DictationState.Inserting -> when (event) {
            DictationEvent.Inserted -> DictationState.Done(DictationOutcomeKind.INSERTED)
            DictationEvent.InsertionFellBackToClipboard -> DictationState.Done(DictationOutcomeKind.COPIED_TO_CLIPBOARD)
            DictationEvent.FrontmostChangedAwaitingChip -> DictationState.Done(DictationOutcomeKind.AWAITING_CHIP)
            DictationEvent.InsertionBlockedSecure -> DictationState.Done(DictationOutcomeKind.HELD_FOR_SECURE_FIELD)
            else -> null
        }
        is DictationState.Done, DictationState.Cancelled, is DictationState.Failed -> null
    }
}

/** Why a session ended with no speech; the copy differs, nothing else does. */
enum class SilenceReason {
    /** Genuinely quiet. */
    NO_SPEECH,
    /** A loud room with nothing rising above it. The recording is kept. */
    TOO_NOISY,
}
