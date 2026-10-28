package com.charles.bento.notes

import com.charles.bento.core.notes.TextMerge

/**
 * How the open editor and the notes module stay in step while text also changes
 * elsewhere (another device, a widget, a captured thought). Each keystroke goes to the
 * module with the text it started from; each change from elsewhere comes to the editor
 * with the text the store had just before it. Both sides then merge the same versions
 * the same way, so neither overwrites the other.
 */
object EditMerge {
    /** The module's side: an edit from `base` to `body` while the store has `stored`; null when both touch the same text. */
    fun edit(stored: String, base: String, body: String): String? =
        if (stored == base) body else TextMerge.merge(base, body, stored)

    /** The editor's side: the store went from `before` to `body` while the editor shows `local`; the typing wins a clash. */
    fun remote(local: String, before: String, body: String): String =
        TextMerge.merge(before, local, body) ?: local
}
