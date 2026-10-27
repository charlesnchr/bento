package com.charles.bento.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.SoundPool
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.content.ContextCompat
import com.charles.bento.R
import com.charles.bento.settings.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Where transcription happens (the Gemini pipeline from :core, or a fake in tests): a
 * session takes 16 kHz PCM16 frames and reports the live transcript; `finish` returns
 * the final, cleaned text.
 */
interface VoicePipeline {
    fun open(request: VoiceRequest, onPartial: (String) -> Unit): VoiceSession

    /** Rewrites `text` as the spoken `instruction` says ("make that shorter"). */
    suspend fun edit(instruction: String, text: String, request: VoiceRequest): String

    /** Why it can't run (no API key…), or null. */
    fun unavailableReason(): String?
}

interface VoiceSession {
    /** False once the session wants no more audio (after stop it may take trailing words first). */
    fun feed(frame: ShortArray): Boolean
    /** Final text ("" when nothing was said); throws with a user-facing message on failure. */
    suspend fun finish(): String
    fun cancel()
}

data class VoiceRequest(val context: FieldContext, val modeId: String?, val purpose: Purpose) {
    enum class Purpose { Dictation, Instruction, Thought, Task }
}

/** Receives finished text for the targets that live in other modules (notes, todos). */
interface DictationSinks {
    /** Appends a captured thought; returns the note's title for the confirmation. */
    suspend fun captureThought(noteId: String?, text: String): String?
    /** Adds a task from quick-add text; returns its title. */
    suspend fun addTask(text: String): String?
}

/**
 * The one dictation at a time, whatever started it (bubble, held key, keyboard, tile,
 * widget, editor), and where its text goes. Main thread.
 */
class DictationController(
    private val context: Context,
    private val prefs: Prefs,
    private val scope: CoroutineScope,
    private val pipeline: () -> VoicePipeline,
    private val sinks: () -> DictationSinks,
    private val modes: () -> List<Pair<String, String>>, // id to name
) {
    private val _state = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = _state.asStateFlow()

    private var session: VoiceSession? = null
    private var capture: AudioCapture? = null
    private var target: DictationTarget? = null
    private var job: Job? = null
    private var editing = false
    private var lastInserted: String? = null
    private var lastTarget: DictationTarget? = null
    private var lastRequest: VoiceRequest? = null
    /** Loudest level heard this dictation: ~0 means the microphone delivered silence (privacy toggle off, mic in use). */
    @Volatile private var peak = 0f

    private val sounds by lazy { Earcons(context) }

    val isBusy: Boolean get() = _state.value is DictationState.Listening || _state.value is DictationState.Processing

    /** The dictation goes into another app's field: the bubble's pill shows it (Bento's own screens show their own). */
    val intoOtherApp: Boolean get() = target is DictationTarget.Field

    /** From the bubble: dictate into the field the accessibility service is tracking. */
    fun startFromBubble(handsFree: Boolean): Boolean = BentoAccessibilityService.instance?.dictateIntoField(handsFree) ?: false

    fun start(target: DictationTarget, handsFree: Boolean): Boolean {
        if (isBusy) return false
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            _state.value = DictationState.Failed("Bento needs the microphone: open Bento to allow it", canRetry = false)
            context.startActivity(Intent(context, com.charles.bento.MainActivity::class.java)
                .setAction(com.charles.bento.MainActivity.ACTION_GRANT_MIC).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return false
        }
        pipeline().unavailableReason()?.let {
            _state.value = DictationState.Failed(it, canRetry = false)
            return false
        }
        editing = false
        this.target = target
        val purpose = when (target) {
            is DictationTarget.Thought -> VoiceRequest.Purpose.Thought
            DictationTarget.Task -> VoiceRequest.Purpose.Task
            else -> VoiceRequest.Purpose.Dictation
        }
        begin(VoiceRequest(target.context, prefs.activeMode.value.ifEmpty { null }, purpose), handsFree)
        return true
    }

    /** After an insertion: record how to change it ("make it more formal"). */
    fun startEdit() {
        val t = lastTarget ?: return
        if (lastInserted == null || isBusy) return
        editing = true
        target = t
        begin(VoiceRequest(t.context, null, VoiceRequest.Purpose.Instruction), handsFree = true)
    }

    private fun begin(request: VoiceRequest, handsFree: Boolean) {
        lastRequest = request
        peak = 0f
        _state.value = DictationState.Listening(0f, "", modeName(), handsFree, System.currentTimeMillis(), editing)
        job = scope.launch {
            if (!VoiceService.enter(context, VoiceService.KIND_DICTATION)) {
                fail("Couldn't start listening right now")
                return@launch
            }
            val s = runCatching { pipeline().open(request) { text -> scope.launch { updatePartial(text) } } }
                .getOrElse { fail(it.message ?: "Couldn't start transcription"); return@launch }
            session = s
            val c = AudioCapture(
                // false: the session has all it wants (stopped, or the 10-minute cap)
                onFrame = {
                    if (!s.feed(it)) scope.launch {
                        if (_state.value is DictationState.Listening) { log("session ended itself"); stop() } else releaseMic()
                    }
                },
                onLevel = { level ->
                    if (level > peak) peak = level
                    _state.update { st -> if (st is DictationState.Listening) st.copy(level = level) else st }
                },
            )
            if (!c.start()) {
                s.cancel()
                fail("The microphone is in use by another app")
                return@launch
            }
            capture = c
            if (prefs.sounds.value) sounds.play(Earcons.START)
            if (prefs.haptics.value) tick()
        }
    }

    private fun log(message: String) = android.util.Log.i("BentoDictation", message)

    private fun updatePartial(text: String) {
        _state.update { st -> if (st is DictationState.Listening) st.copy(partial = text) else st }
    }

    fun stop() {
        val st = _state.value as? DictationState.Listening ?: return
        if (prefs.sounds.value) sounds.play(Earcons.STOP)
        _state.value = DictationState.Processing(st.partial, editing)
        val s = session
        session = null
        job = scope.launch {
            // the microphone stays open a moment for a word still being spoken; the session
            // says when it has enough (feed returns false), and finish waits for that
            val text = runCatching { s?.finish() ?: "" }
            log("finished: ${text.exceptionOrNull()?.message ?: "${text.getOrNull()?.length} chars"}")
            releaseMic()
            VoiceService.exit(context)
            if (peak < SILENT && (text.isFailure || text.getOrNull().isNullOrBlank())) {
                fail("No sound reached the microphone. Is microphone access turned off in Quick Settings?")
                return@launch
            }
            text.onFailure { fail(it.message ?: "Transcription failed", canRetry = true) }
                .onSuccess { deliver(it.trim()) }
        }
    }

    private fun releaseMic() {
        capture?.stop()
        capture = null
    }

    fun cancel() {
        releaseMic()
        session?.cancel()
        session = null
        job?.cancel()
        VoiceService.exit(context)
        if (prefs.sounds.value) sounds.play(Earcons.CANCEL)
        _state.value = DictationState.Idle
    }

    fun dismiss() {
        if (!isBusy) _state.value = DictationState.Idle
    }

    /** Retry after a failure: dictate again into the same place. */
    fun retry() {
        val t = target ?: return
        _state.value = DictationState.Idle
        start(t, handsFree = true)
    }

    fun cycleMode() {
        val all = modes()
        if (all.isEmpty()) return
        val ids = listOf("") + all.map { it.first }
        val next = ids[(ids.indexOf(prefs.activeMode.value) + 1).mod(ids.size)]
        prefs.activeMode.value = next
        _state.update { st -> if (st is DictationState.Listening) st.copy(modeName = modeName()) else st }
    }

    private fun modeName(): String? {
        val id = prefs.activeMode.value
        val all = modes()
        if (all.isEmpty()) return null
        return all.firstOrNull { it.first == id }?.second ?: "Default"
    }

    private suspend fun deliver(text: String) {
        val t = target ?: return
        if (text.isEmpty()) {
            _state.value = DictationState.Failed("Didn't catch anything", canRetry = true)
            return
        }
        if (editing) {
            val previous = lastInserted ?: return
            val rewritten = runCatching { pipeline().edit(text, previous, lastRequest ?: VoiceRequest(t.context, null, VoiceRequest.Purpose.Dictation)) }
                .getOrElse { fail(it.message ?: "Couldn't rewrite it", canRetry = false); return }
            val ok = when (t) {
                is DictationTarget.Field -> t.inserter.replaceLast(previous, rewritten)
                is DictationTarget.Keyboard -> t.replaceLast(previous, rewritten)
                else -> false
            }
            editing = false
            if (!ok) { fail("Couldn't change the text in this field"); return }
            lastInserted = rewritten
            _state.value = if (t is DictationTarget.Keyboard) DictationState.Idle
                else DictationState.Done(rewritten, undo = (t as? DictationTarget.Field)?.let { f -> { f.inserter.undo() } }, canEdit = true)
            return
        }
        when (t) {
            is DictationTarget.Field -> {
                if (!t.inserter.insert(text)) {
                    // the field is gone or refuses text: keep it on the clipboard
                    copyToClipboard(text)
                    _state.value = DictationState.Failed("Couldn't type into this field; copied to the clipboard instead", canRetry = false)
                    return
                }
                lastInserted = text
                lastTarget = t
                _state.value = DictationState.Done(text, undo = { t.inserter.undo() }, canEdit = true)
            }
            is DictationTarget.Keyboard -> { t.commit(text); lastInserted = text; lastTarget = t; _state.value = DictationState.Idle }
            is DictationTarget.Editor -> { t.commit(text); _state.value = DictationState.Idle }
            is DictationTarget.Thought -> {
                val title = sinks().captureThought(t.noteId, text)
                _state.value = DictationState.Done(if (title != null) "Added to “$title”" else text, undo = null, canEdit = false)
            }
            DictationTarget.Task -> {
                val title = sinks().addTask(text)
                _state.value = DictationState.Done(if (title != null) "Task added: $title" else text, undo = null, canEdit = false)
            }
        }
        if (prefs.sounds.value) sounds.play(Earcons.SUCCESS)
    }

    private companion object {
        /** Below this the capture was digital silence, not a quiet room (levels are 0…1 over -55…-10 dBFS). */
        const val SILENT = 0.02f
    }

    private fun fail(message: String, canRetry: Boolean = false) {
        releaseMic()
        VoiceService.exit(context)
        if (prefs.sounds.value) sounds.play(Earcons.ERROR)
        _state.value = DictationState.Failed(message, canRetry)
    }

    private fun copyToClipboard(text: String) {
        val cm = context.getSystemService(android.content.ClipboardManager::class.java)
        cm?.setPrimaryClip(android.content.ClipData.newPlainText("Bento dictation", text))
    }

    private fun tick() {
        context.getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK))
    }
}

/** Jot's earcons (start, stop, cancel, error, success), quiet and short. */
class Earcons(context: Context) {
    private val pool = SoundPool.Builder().setMaxStreams(2).setAudioAttributes(
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
    ).build()
    private val ids = mapOf(
        START to pool.load(context, R.raw.earcon_start, 1),
        STOP to pool.load(context, R.raw.earcon_stop, 1),
        CANCEL to pool.load(context, R.raw.earcon_cancel, 1),
        ERROR to pool.load(context, R.raw.earcon_error, 1),
        SUCCESS to pool.load(context, R.raw.earcon_success, 1),
    )

    fun play(which: Int) {
        ids[which]?.let { pool.play(it, 0.35f, 0.35f, 1, 0, 1f) }
    }

    companion object {
        const val START = 0
        const val STOP = 1
        const val CANCEL = 2
        const val ERROR = 3
        const val SUCCESS = 4
    }
}
