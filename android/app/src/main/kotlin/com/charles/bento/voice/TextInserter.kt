package com.charles.bento.voice

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.PersistableBundle
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction

/**
 * Puts dictated text into a text field of another app through its accessibility node,
 * where the cursor is, replacing a selection like typing would.
 *
 * Setting the field's text (ACTION_SET_TEXT) keeps the clipboard untouched and works in
 * native and Compose fields; fields that refuse it (some web views) get a paste, with
 * the clipboard restored right after.
 */
class TextInserter(private val context: Context, private val node: AccessibilityNodeInfo) {
    private var before: Snapshot? = null

    private data class Snapshot(val text: String, val selStart: Int, val selEnd: Int)

    /** What's before the cursor, for the cleanup model's context and spacing. */
    fun textBeforeCursor(max: Int = 400): String? {
        node.refresh()
        val text = currentText() ?: return null
        val start = node.textSelectionStart.takeIf { it in 0..text.length } ?: text.length
        return text.substring(maxOf(0, start - max), start)
    }

    /** True when it went in. */
    suspend fun insert(dictated: String): Boolean {
        if (dictated.isEmpty()) return true
        node.refresh()
        val text = currentText() ?: ""
        var start = node.textSelectionStart
        var end = node.textSelectionEnd
        if (start !in 0..text.length || end !in 0..text.length) { start = text.length; end = text.length }
        if (start > end) start = end.also { end = start }
        val insertion = spaced(dictated, text.substring(0, start), text.substring(end))
        before = Snapshot(text, start, end)

        val canSet = node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SET_TEXT }
        if (canSet) {
            val updated = text.substring(0, start) + insertion + text.substring(end)
            val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated) }
            val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            if (ok) {
                // Compose and some views apply it on the next frame: look again before deciding
                kotlinx.coroutines.delay(150)
                val caret = start + insertion.length
                setSelection(caret, caret)
                if (verify(text, updated)) return true
            }
            log("set text ${if (ok) "didn't stick" else "refused"} (${node.className})")
        }
        val pasted = paste(insertion)
        log("paste ${if (pasted) "worked" else "failed"}; set text ${if (canSet) "offered" else "not offered"}")
        return pasted
    }

    /** Puts the field back as it was before the last insertion. */
    fun undo(): Boolean {
        val s = before ?: return false
        node.refresh()
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, s.text) }
        val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        if (ok) setSelection(s.selStart, s.selEnd)
        before = null
        return ok
    }

    /** Replaces the text inserted last (voice edits) with `replacement`. */
    fun replaceLast(previous: String, replacement: String): Boolean {
        node.refresh()
        val text = currentText() ?: return false
        val caret = node.textSelectionStart.takeIf { it in 0..text.length } ?: text.length
        val at = text.lastIndexOf(previous, startIndex = caret).takeIf { it >= 0 } ?: text.lastIndexOf(previous)
        if (at < 0) return false
        val updated = text.substring(0, at) + replacement + text.substring(at + previous.length)
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated) }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false
        val end = at + replacement.length
        setSelection(end, end)
        return true
    }

    private fun currentText(): String? {
        if (node.isShowingHintText) return ""
        return node.text?.toString()
    }

    private fun setSelection(start: Int, end: Int) {
        val args = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, args)
    }

    /** False only when the field still holds exactly what it held before (the action did nothing). */
    private fun verify(before: String, expected: String): Boolean {
        node.refresh()
        val now = currentText() ?: return true // can't read it back: trust the action
        return now == expected || now != before
    }

    private fun paste(insertion: String): Boolean {
        if (node.actionList.none { it.id == AccessibilityNodeInfo.ACTION_PASTE }) return false
        val cm = context.getSystemService(ClipboardManager::class.java) ?: return false
        val previous = runCatching { cm.primaryClip }.getOrNull()
        val clip = ClipData.newPlainText("Bento dictation", insertion).apply {
            // keep it out of clipboard history and the "copied" preview
            description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        cm.setPrimaryClip(clip)
        val ok = node.performAction(AccessibilityAction.ACTION_PASTE.id)
        node.refresh()
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            runCatching { if (previous != null) cm.setPrimaryClip(previous) else cm.clearPrimaryClip() }
        }, 400)
        return ok
    }

    private fun log(m: String) = android.util.Log.i("BentoInsert", m)

    companion object {
        /**
         * A space before the text when it follows a word, and none after an opening
         * bracket or at a line start; a space after when a word follows directly.
         */
        fun spaced(text: String, before: String, after: String): String {
            var out = text
            val prev = before.lastOrNull()
            if (prev != null && !prev.isWhitespace() && prev !in "([{\"'“‘/@#" && out.firstOrNull()?.let { it.isLetterOrDigit() || it in "([{\"“" } == true) {
                out = " $out"
            }
            val next = after.firstOrNull()
            if (next != null && next.isLetterOrDigit() && out.lastOrNull()?.isWhitespace() == false) out = "$out "
            return out
        }
    }
}
