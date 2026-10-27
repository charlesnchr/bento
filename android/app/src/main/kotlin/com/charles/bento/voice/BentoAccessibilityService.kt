package com.charles.bento.voice

import android.accessibilityservice.AccessibilityService
import android.content.pm.PackageManager
import android.graphics.Rect
import android.media.AudioManager
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.charles.bento.graph
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * System-wide dictation without switching keyboards (like Wispr Flow and Whisperian on
 * Android): a mic bubble appears while the keyboard is up over a text field, holding
 * Volume Down talks into that field, and the text is inserted where the cursor is.
 *
 * Reads only the focused field (its text, hint and type) and which app it belongs to,
 * for insertion and the cleanup model's context; nothing is stored.
 */
class BentoAccessibilityService : AccessibilityService() {
    private val scope = MainScope()
    private lateinit var overlay: DictationOverlay
    private val _field = MutableStateFlow<FocusedField?>(null)
    /** The text field dictation would go into right now, with the keyboard's top edge. */
    val field: StateFlow<FocusedField?> = _field.asStateFlow()
    private var refreshJob: Job? = null
    private var holdJob: Job? = null
    private var holdStarted = false
    private var holdDownAt = 0L
    /** Apps where the bubble was swiped away (until another app's field is focused). */
    private var hiddenIn: String? = null

    data class FocusedField(val node: AccessibilityNodeInfo, val pkg: String, val appLabel: String?, val hint: String?,
                            val singleLine: Boolean, val keyboardTop: Int?, val screen: Rect)

    override fun onServiceConnected() {
        instance = this
        val g = graph
        overlay = DictationOverlay(this, g.prefs, g.dictation, onHide = { hiddenIn = _field.value?.pkg; refreshSoon(0) })
        scope.launch {
            combine(_field, g.prefs.bubbleEnabled.flow, g.dictation.state) { f, enabled, state -> Triple(f, enabled, state) }
                .collect { (f, enabled, state) -> overlay.update(f.takeIf { enabled && it?.pkg != hiddenIn }, f, state) }
        }
    }

    /** The last editable node a focus or caret event came from (some apps put input focus on a wrapper). */
    private var lastEditable: AccessibilityNodeInfo? = null

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType == AccessibilityEvent.TYPE_VIEW_FOCUSED || event.eventType == AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED) {
            event.source?.takeIf { it.isEditable }?.let { lastEditable = it }
        }
        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_FOCUSED, AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_WINDOWS_CHANGED, AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
            AccessibilityEvent.TYPE_VIEW_CLICKED -> refreshSoon(60)
        }
    }

    private fun refreshSoon(delayMs: Long) {
        refreshJob?.cancel()
        refreshJob = scope.launch {
            delay(delayMs)
            _field.value = currentField()
        }
    }

    private fun currentField(): FocusedField? {
        val ime = windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
        val focus = findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        val node = focus?.takeIf { it.isEditable } ?: focus?.let(::focusedEditableIn)
            ?: lastEditable?.takeIf { it.refresh() && it.isFocused && it.isEditable }
            ?: searchFocusedEditable()
        if (node == null) { trace("no focused text field"); return null }
        if (!node.isEditable || node.isPassword || !dictatable(node.inputType)) { trace("not a dictatable field (${node.className} editable=${node.isEditable} type=${node.inputType} pkg=${node.packageName} focused=${node.isFocused})"); return null }
        val pkg = node.packageName?.toString() ?: return null
        if (pkg == packageName) return null // Bento's own editors have their own mic
        if (hiddenIn != null && hiddenIn != pkg) hiddenIn = null
        if (ime == null && !usingBentoKeyboard()) { trace("no keyboard window (${windows.size} windows)"); return null }
        val top = ime?.let { Rect().also(it::getBoundsInScreen).top }
        val screen = Rect().also { r -> windows.firstOrNull { it.isActive }?.getBoundsInScreen(r) }
        return FocusedField(node, pkg, appLabel(pkg), node.hintText?.toString(), node.isMultiLine.not(), top, screen)
    }

    /** The focused editable node anywhere in the apps' windows (bounded walk). */
    private fun searchFocusedEditable(): AccessibilityNodeInfo? {
        val roots = windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }.mapNotNull { it.root }
        for (root in roots) {
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var seen = 0
            while (queue.isNotEmpty() && seen < 1_500) {
                val n = queue.removeFirst()
                seen++
                if (n.isEditable && n.isFocused) return n
                for (i in 0 until n.childCount) n.getChild(i)?.let(queue::addLast)
            }
        }
        return null
    }

    /** A focused editable node inside `root` (a few levels down). */
    private fun focusedEditableIn(root: AccessibilityNodeInfo, depth: Int = 0): AccessibilityNodeInfo? {
        if (depth > 4) return null
        for (i in 0 until root.childCount) {
            val c = root.getChild(i) ?: continue
            if (c.isEditable && c.isFocused) return c
            focusedEditableIn(c, depth + 1)?.let { return it }
        }
        return null
    }

    /** Text and multi-line fields; not numbers, phones, dates or passwords. */
    private fun dictatable(inputType: Int): Boolean {
        if (inputType == 0) return true // unknown (web views, custom fields)
        // some apps report a text variation without the class bits (Contacts: 0x2060)
        val cls = inputType and InputType.TYPE_MASK_CLASS
        if (cls != InputType.TYPE_CLASS_TEXT && cls != InputType.TYPE_NULL) return false
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        return variation != InputType.TYPE_TEXT_VARIATION_PASSWORD &&
            variation != InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD &&
            variation != InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
    }

    private fun trace(message: String) = android.util.Log.d("BentoA11y", message)

    fun usingBentoKeyboard(): Boolean =
        Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.startsWith("$packageName/") == true

    private fun appLabel(pkg: String): String? = runCatching {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, PackageManager.GET_META_DATA)).toString()
    }.getOrNull()

    /** Starts a dictation into the focused field (bubble tap, held key). */
    fun dictateIntoField(handsFree: Boolean): Boolean {
        val f = _field.value ?: currentField() ?: return false
        val inserter = TextInserter(this, f.node)
        val ctx = FieldContext(appPackage = f.pkg, appLabel = f.appLabel, hint = f.hint,
                               textBefore = inserter.textBeforeCursor(), singleLine = f.singleLine)
        return graph.dictation.start(DictationTarget.Field(inserter, ctx), handsFree)
    }

    // MARK: Hold-to-talk on a hardware key

    override fun onKeyEvent(event: KeyEvent): Boolean {
        val prefs = graph.prefs
        val learning = keyLearner
        if (learning != null && event.action == KeyEvent.ACTION_DOWN) {
            keyLearner = null
            learning(event.keyCode)
            return true
        }
        if (!prefs.volumeHold.value || event.keyCode != prefs.holdKey.value) return false
        val dictation = graph.dictation
        val active = dictation.state.value is DictationState.Listening
        // Only over a text field (or to stop a dictation): elsewhere the key does what it always does.
        if (_field.value == null && !active && !holdStarted) return false
        when (event.action) {
            KeyEvent.ACTION_DOWN -> {
                if (event.repeatCount > 0) return true
                if (active && !holdStarted) { dictation.stop(); return true } // a press ends a tap-started dictation
                holdDownAt = SystemClock.uptimeMillis()
                holdStarted = false
                holdJob?.cancel()
                holdJob = scope.launch {
                    delay(prefs.holdMillis.value.toLong())
                    holdStarted = dictateIntoField(handsFree = false)
                    if (holdStarted) overlay.hapticStart()
                }
                return true
            }
            KeyEvent.ACTION_UP -> {
                holdJob?.cancel()
                if (holdStarted) {
                    holdStarted = false
                    dictation.stop()
                } else if (SystemClock.uptimeMillis() - holdDownAt < prefs.holdMillis.value) {
                    // A short press: the volume change the user expected.
                    val am = getSystemService(AudioManager::class.java)
                    val dir = if (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER
                    if (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
                        am.adjustSuggestedStreamVolume(dir, AudioManager.USE_DEFAULT_STREAM_TYPE, AudioManager.FLAG_SHOW_UI)
                    }
                }
                return true
            }
        }
        return false
    }

    /** Debug builds feed hardware-like key events here (see DebugKeyReceiver). */
    fun debugKey(event: KeyEvent) = onKeyEvent(event)

    override fun onInterrupt() {}

    override fun onDestroy() {
        instance = null
        if (::overlay.isInitialized) overlay.destroy()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        @Volatile var instance: BentoAccessibilityService? = null
            private set

        /** Settings → "Use another key": the next key pressed anywhere becomes the hold key. */
        @Volatile var keyLearner: ((Int) -> Unit)? = null

        val isRunning: Boolean get() = instance != null
    }
}
