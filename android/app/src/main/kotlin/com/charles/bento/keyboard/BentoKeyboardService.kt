package com.charles.bento.keyboard

import android.inputmethodservice.InputMethodService
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.charles.bento.graph
import com.charles.bento.ui.ComposeWindowOwner
import com.charles.bento.ui.theme.BentoTheme
import com.charles.bento.voice.DictationState
import com.charles.bento.voice.DictationTarget
import com.charles.bento.voice.FieldContext
import com.charles.bento.voice.TextInserter

/**
 * The Bento keyboard: voice first (a big mic, the live transcript, punctuation, ⌫, ⏎),
 * with a compact QWERTY for quick fixes and one tap back to the previous keyboard. For
 * fields the bubble can't reach, and for people who'd rather switch keyboards.
 */
class BentoKeyboardService : InputMethodService() {
    private val owner = ComposeWindowOwner()
    private var editor by mutableStateOf<EditorInfo?>(null)

    override fun onCreateInputView(): View {
        window.window?.decorView?.let(owner::attach)
        return ComposeView(this).apply {
            owner.attach(this)
            setContent {
                val theme by graph.prefs.theme.flow.collectAsStateWithLifecycle()
                val state by graph.dictation.state.collectAsStateWithLifecycle()
                BentoTheme(theme) {
                    KeyboardUi(
                        state = state,
                        editor = editor,
                        modeName = graph.voiceModes().firstOrNull { it.first == graph.prefs.activeMode.value }?.second,
                        hasModes = graph.voiceModes().isNotEmpty(),
                        actions = actions,
                    )
                }
            }
        }
    }

    override fun onStartInputView(info: EditorInfo, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        editor = info
        owner.resume()
    }

    override fun onFinishInputView(finishingInput: Boolean) {
        // leaving the field ends a dictation into it (the text still lands if it can)
        if (graph.dictation.state.value is DictationState.Listening) graph.dictation.stop()
        owner.pause()
        super.onFinishInputView(finishingInput)
    }

    override fun onDestroy() {
        owner.destroy()
        super.onDestroy()
    }

    override fun onEvaluateFullscreenMode() = false

    /** Shown even with a hardware keyboard attached: the mic is the point. */
    override fun onEvaluateInputViewShown(): Boolean {
        super.onEvaluateInputViewShown()
        return true
    }

    private val actions = object : KeyboardActions {
        override fun mic(handsFree: Boolean) {
            val d = graph.dictation
            when (d.state.value) {
                is DictationState.Listening -> d.stop()
                is DictationState.Processing -> {}
                else -> d.start(target(), handsFree)
            }
        }

        override fun micRelease() {
            if ((graph.dictation.state.value as? DictationState.Listening)?.handsFree == false) graph.dictation.stop()
        }

        override fun cancel() = graph.dictation.cancel()
        override fun edit() = graph.dictation.startEdit()
        override fun cycleMode() = graph.dictation.cycleMode()

        override fun type(text: String) {
            val ic = currentInputConnection ?: return
            ic.commitText(text, 1)
        }

        override fun punctuation(p: String) {
            val ic = currentInputConnection ?: return
            // "word ," → "word,": no space before closing punctuation
            val before = ic.getTextBeforeCursor(1, 0)?.toString().orEmpty()
            if (p in CLOSING && before == " ") ic.deleteSurroundingText(1, 0)
            ic.commitText(if (p in CLOSING) "$p " else p, 1)
        }

        override fun backspace(word: Boolean) {
            val ic = currentInputConnection ?: return
            val selected = ic.getSelectedText(0)
            if (!selected.isNullOrEmpty()) { ic.commitText("", 1); return }
            if (word) {
                val before = ic.getTextBeforeCursor(64, 0)?.toString().orEmpty()
                val trimmed = before.trimEnd()
                val cut = before.length - (trimmed.lastIndexOfAny(charArrayOf(' ', '\n')) + 1)
                ic.deleteSurroundingText(maxOf(1, cut), 0)
            } else {
                sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL)
            }
        }

        override fun enter() {
            val info = editor
            val action = info?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE
            val noEnterAction = info?.imeOptions?.and(EditorInfo.IME_FLAG_NO_ENTER_ACTION) != 0
            val multiLine = info?.inputType?.and(InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0
            if (!multiLine && !noEnterAction && action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
                currentInputConnection?.performEditorAction(action)
            } else {
                sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
            }
        }

        override fun switchKeyboard() {
            if (!switchToPreviousInputMethod()) {
                getSystemService(android.view.inputmethod.InputMethodManager::class.java).showInputMethodPicker()
            }
        }

        override fun pickKeyboard() {
            getSystemService(android.view.inputmethod.InputMethodManager::class.java).showInputMethodPicker()
        }
    }

    private fun target(): DictationTarget.Keyboard {
        val info = editor
        val ic = currentInputConnection
        val ctx = FieldContext(
            appPackage = info?.packageName,
            appLabel = info?.packageName?.let { pkg ->
                runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrNull()
            },
            hint = info?.hintText?.toString(),
            textBefore = ic?.getTextBeforeCursor(400, 0)?.toString(),
            singleLine = info?.inputType?.and(InputType.TYPE_TEXT_FLAG_MULTI_LINE) == 0,
        )
        return DictationTarget.Keyboard(
            commit = { text ->
                val c = currentInputConnection
                if (c != null) {
                    val before = c.getTextBeforeCursor(64, 0)?.toString().orEmpty()
                    val after = c.getTextAfterCursor(1, 0)?.toString().orEmpty()
                    c.commitText(TextInserter.spaced(text, before, after), 1)
                }
            },
            replaceLast = { old, new ->
                val c = currentInputConnection
                val before = c?.getTextBeforeCursor(old.length + 2, 0)?.toString().orEmpty()
                val at = before.lastIndexOf(old)
                if (c == null || at < 0) false else {
                    c.beginBatchEdit()
                    c.deleteSurroundingText(before.length - at, 0)
                    c.commitText(new + before.substring(at + old.length), 1)
                    c.endBatchEdit()
                    true
                }
            },
            context = ctx,
        )
    }

    companion object {
        private const val CLOSING = ",.?!:;"
    }
}

interface KeyboardActions {
    fun mic(handsFree: Boolean)
    fun micRelease()
    fun cancel()
    fun edit()
    fun cycleMode()
    fun type(text: String)
    fun punctuation(p: String)
    fun backspace(word: Boolean)
    fun enter()
    fun switchKeyboard()
    fun pickKeyboard()
}
