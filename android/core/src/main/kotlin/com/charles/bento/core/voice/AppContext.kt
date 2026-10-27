package com.charles.bento.core.voice

/**
 * Where a dictation's text is going, as the app knows it. The Mac passes only the
 * target app (its bundle id picks the cleanup tone); Android can also pass the
 * field's hint and the text before the cursor, which ride in the cleanup prompt as
 * context when tone matching is on. Never stored in History beyond package and label.
 */
data class AppContext(
    /** Target app's package name ("com.google.android.gm"). Picks the cleanup tone. */
    val packageName: String? = null,
    /** Target app's user-visible label ("Gmail"). */
    val appLabel: String? = null,
    /** The focused field's hint text ("Subject", "Message"), if any. */
    val fieldHint: String? = null,
    /** Text before the cursor, if the app could read it. Only the last 400 characters are sent. */
    val textBeforeCursor: String? = null,
)
