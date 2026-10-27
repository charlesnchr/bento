package com.charles.bento.voice

/** Where a dictation's text goes. */
sealed interface DictationTarget {
    val context: FieldContext

    /** A text field in another app, through the accessibility service. */
    class Field(val inserter: TextInserter, override val context: FieldContext) : DictationTarget

    /** The Bento keyboard's input connection. */
    class Keyboard(
        val commit: (String) -> Unit,
        /** Replaces the text just committed (voice edits); false when the cursor moved away from it. */
        val replaceLast: (old: String, new: String) -> Boolean,
        override val context: FieldContext,
    ) : DictationTarget

    /** Bento's own note editor. */
    class Editor(val commit: (String) -> Unit, override val context: FieldContext) : DictationTarget

    /** "Capture thought": appended to a note as a timestamped, collapsible entry (Mac: Capture Thought to Note). */
    class Thought(val noteId: String?) : DictationTarget {
        override val context = FieldContext(appLabel = "Bento Notes", hint = "A thought to keep in a note")
    }

    /** A task, parsed with the quick-add syntax ("call mum tomorrow 5pm p1"). */
    data object Task : DictationTarget {
        override val context = FieldContext(appLabel = "Bento Todo", hint = "A task, possibly with a date, #project, @label or p1–p4")
    }
}

/** What the cleanup model is told about where the text goes (the Mac passes the app and field the same way). */
data class FieldContext(
    val appPackage: String? = null,
    val appLabel: String? = null,
    val hint: String? = null,
    val textBefore: String? = null,
    val singleLine: Boolean = false,
)

/** Process-wide dictation state the bubble, keyboard, capture sheet and tile all show. */
sealed interface DictationState {
    data object Idle : DictationState

    data class Listening(
        val level: Float,
        /** Live transcript so far (finals + the current partial). */
        val partial: String,
        val modeName: String?,
        /** Tap-started (keeps going until tapped again) rather than held. */
        val handsFree: Boolean,
        val startedAt: Long,
        /** Recording an instruction for the text just inserted ("make that shorter"). */
        val editing: Boolean = false,
    ) : DictationState

    data class Processing(val partial: String, val editing: Boolean = false) : DictationState

    data class Done(
        val text: String,
        /** Restores the field to before the insertion, when the target can. */
        val undo: (() -> Unit)?,
        /** Lets the user say how to change what was just inserted. */
        val canEdit: Boolean,
    ) : DictationState

    data class Failed(val message: String, val canRetry: Boolean) : DictationState
}
